const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { calculateOverview, calculateByCampaign, calculateDailyHistory } = require('../services/metricsEngine');
const { get } = require('../config/redis');
const { decrypt } = require('../services/encryptionService');
const { query } = require('../config/database');

const router = express.Router();
router.use(requireAuth);

const getTodayBRT = () =>
  new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    .toISOString().slice(0, 10);

// GET /api/metrics/overview?days=7
router.get('/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cacheKey = `metrics:overview:${req.user.id}:${days}d:${getTodayBRT()}`;
    const cached = await get(cacheKey);
    if (cached) return res.json({ data: cached, cached: true });
    const metrics = await calculateOverview(req.user.id, days);
    res.json({ data: metrics, cached: false });
  } catch (error) {
    console.error('[Metrics] Erro overview:', error.message);
    res.status(500).json({ error: 'Erro ao calcular metricas' });
  }
});

// GET /api/metrics/campaigns?days=7
router.get('/campaigns', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const campaigns = await calculateByCampaign(req.user.id, days);
    res.json({ data: campaigns, count: campaigns.length });
  } catch (error) {
    console.error('[Metrics] Erro campaigns:', error.message);
    res.status(500).json({ error: 'Erro ao calcular metricas por campanha' });
  }
});

// GET /api/metrics/history?days=30&campaign_id=xxx
router.get('/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const campaignId = req.query.campaign_id || null;
    const history = await calculateDailyHistory(req.user.id, campaignId, days);
    res.json({ data: history });
  } catch (error) {
    console.error('[Metrics] Erro history:', error.message);
    res.status(500).json({ error: 'Erro ao buscar historico' });
  }
});

// GET /api/metrics/tree?period=today|month|7|14|30&integration_id=uuid
//
// Estrategia por nivel:
//   Nivel 1 — campaigns + ad_metrics (SEM filtro de adset_id — igual ao metricsEngine)
//   Nivel 2 — tenta ad_sets + ad_metrics; fallback: ad_metrics agrupado por adset_id
//   Nivel 3 — tenta ads + ad_metrics; fallback: ad_metrics agrupado por ad_id
router.get('/tree', async (req, res) => {
  try {
    const userId = req.user.id;

    // Data de inicio em BRT
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const period = req.query.period || req.query.days || '7';
    let dateFrom;
    if (period === 'today') {
      dateFrom = now.toISOString().slice(0, 10);
    } else if (period === 'month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFrom = first.toISOString().slice(0, 10);
    } else {
      const d = parseInt(period) || 7;
      const fromDate = new Date(now);
      fromDate.setDate(fromDate.getDate() - d);
      dateFrom = fromDate.toISOString().slice(0, 10);
    }

    const integrationId = req.query.integration_id || null;

    // Targets do usuario para calcular saude
    const userResult = await query('SELECT cpa_target, roas_target FROM users WHERE id=$1', [userId]);
    const cpaTarget  = parseFloat(userResult.rows[0]?.cpa_target  || 50);
    const roasTarget = parseFloat(userResult.rows[0]?.roas_target || 2);

    const calcHealth = (spend, revenue, conversions) => {
      if (spend === 0) return 'gray';
      const roas = revenue / spend;
      const cpa  = conversions > 0 ? spend / conversions : 9999;
      if (roas >= roasTarget && cpa <= cpaTarget) return 'green';
      if (roas >= roasTarget * 0.7 || cpa <= cpaTarget * 1.3) return 'yellow';
      return 'red';
    };

    // ── NIVEL 1: Campanhas ─────────────────────────────────────────────────
    // Sem filtro de adset_id — identico ao calculateByCampaign do metricsEngine
    const campParams = integrationId ? [userId, dateFrom, integrationId] : [userId, dateFrom];
    const campFilter = integrationId ? 'AND c.integration_id = $3' : '';
    const campResult = await query(`
      SELECT
        c.id, c.name, c.status, c.external_id,
        c.integration_id, c.daily_budget, c.lifetime_budget,
        COALESCE(SUM(am.spend), 0)::numeric           AS spend,
        COALESCE(SUM(am.impressions), 0)::integer     AS impressions,
        COALESCE(SUM(am.clicks), 0)::integer          AS clicks,
        COALESCE(SUM(am.reach), 0)::integer           AS reach,
        COALESCE(AVG(NULLIF(am.cpm, 0)), 0)::numeric  AS cpm,
        COALESCE(AVG(NULLIF(am.ctr, 0)), 0)::numeric  AS ctr,
        COALESCE(AVG(NULLIF(am.cpc, 0)), 0)::numeric  AS cpc
      FROM campaigns c
      LEFT JOIN ad_metrics am
        ON am.campaign_id = c.id
        AND am.date >= $2
      WHERE c.user_id = $1 ${campFilter}
      GROUP BY c.id, c.name, c.status, c.external_id,
               c.integration_id, c.daily_budget, c.lifetime_budget
      ORDER BY
        CASE WHEN c.status = 'ACTIVE' THEN 0 ELSE 1 END ASC,
        COALESCE(SUM(am.spend), 0) DESC
    `, campParams);

    // ── NIVEL 2: Conjuntos de anuncio ──────────────────────────────────────
    // Prefere tabela ad_sets (com nome/status/orcamento real)
    // Se ad_sets nao existir, agrupa ad_metrics por adset_id
    let adSetResult = { rows: [] };
    try {
      // Abordagem 1: ad_sets + ad_set_metrics (tabelas opcionais mas comuns no live DB)
      adSetResult = await query(`
        SELECT
          ads.id, ads.external_id, ads.name, ads.status,
          ads.campaign_id,
          COALESCE(ads.daily_budget,    0) AS daily_budget,
          COALESCE(ads.lifetime_budget, 0) AS lifetime_budget,
          COALESCE(SUM(asm.spend), 0)::numeric           AS spend,
          COALESCE(SUM(asm.impressions), 0)::integer     AS impressions,
          COALESCE(SUM(asm.clicks), 0)::integer          AS clicks,
          COALESCE(SUM(asm.reach), 0)::integer           AS reach,
          COALESCE(AVG(NULLIF(asm.cpm, 0)), 0)::numeric  AS cpm,
          COALESCE(AVG(NULLIF(asm.ctr, 0)), 0)::numeric  AS ctr,
          COALESCE(AVG(NULLIF(asm.cpc, 0)), 0)::numeric  AS cpc
        FROM ad_sets ads
        LEFT JOIN ad_set_metrics asm
          ON asm.ad_set_id = ads.id
          AND asm.date >= $2
        WHERE ads.user_id = $1
        GROUP BY ads.id, ads.external_id, ads.name, ads.status,
                 ads.campaign_id, ads.daily_budget, ads.lifetime_budget
        ORDER BY spend DESC
      `, [userId, dateFrom]);
    } catch (e) {
      // Abordagem 2: agrupar ad_metrics por adset_id (fallback)
      try {
        adSetResult = await query(`
          SELECT
            am.adset_id AS id, am.adset_id AS external_id, am.campaign_id,
            am.adset_id AS name, 'ACTIVE' AS status,
            0 AS daily_budget, 0 AS lifetime_budget,
            COALESCE(SUM(am.spend), 0)::numeric           AS spend,
            COALESCE(SUM(am.impressions), 0)::integer     AS impressions,
            COALESCE(SUM(am.clicks), 0)::integer          AS clicks,
            COALESCE(SUM(am.reach), 0)::integer           AS reach,
            COALESCE(AVG(NULLIF(am.cpm, 0)), 0)::numeric  AS cpm,
            COALESCE(AVG(NULLIF(am.ctr, 0)), 0)::numeric  AS ctr,
            COALESCE(AVG(NULLIF(am.cpc, 0)), 0)::numeric  AS cpc
          FROM ad_metrics am
          WHERE am.user_id = $1 AND am.date >= $2
            AND am.adset_id IS NOT NULL AND am.adset_id != ''
          GROUP BY am.adset_id, am.campaign_id
          ORDER BY spend DESC
        `, [userId, dateFrom]);
      } catch (e2) {
        console.warn('[Tree] Fallback Level2 tambem falhou:', e2.message);
      }
    }

    // ── NIVEL 3: Anuncios individuais ──────────────────────────────────────
    // Prefere tabela ads (com nome/status real)
    // Se ads nao existir, agrupa ad_metrics por ad_id
    let adsResult = { rows: [] };
    try {
      // Abordagem 1: ads + ad_level_metrics (tabelas opcionais mas comuns no live DB)
      adsResult = await query(`
        SELECT
          a.id, a.external_id, a.name, a.status,
          a.campaign_id, a.ad_set_id,
          COALESCE(SUM(alm.spend), 0)::numeric           AS spend,
          COALESCE(SUM(alm.impressions), 0)::integer     AS impressions,
          COALESCE(SUM(alm.clicks), 0)::integer          AS clicks,
          COALESCE(SUM(alm.reach), 0)::integer           AS reach,
          COALESCE(AVG(NULLIF(alm.cpm, 0)), 0)::numeric  AS cpm,
          COALESCE(AVG(NULLIF(alm.ctr, 0)), 0)::numeric  AS ctr,
          COALESCE(AVG(NULLIF(alm.cpc, 0)), 0)::numeric  AS cpc
        FROM ads a
        LEFT JOIN ad_level_metrics alm
          ON alm.ad_id = a.id
          AND alm.date >= $2
        WHERE a.user_id = $1
        GROUP BY a.id, a.external_id, a.name, a.status,
                 a.campaign_id, a.ad_set_id
        ORDER BY spend DESC
      `, [userId, dateFrom]);
    } catch (e) {
      // Abordagem 2: agrupar ad_metrics por ad_id (fallback)
      try {
        adsResult = await query(`
          SELECT
            am.ad_id AS id, am.ad_id AS external_id,
            am.adset_id AS ad_set_id, am.campaign_id,
            am.ad_id AS name, 'ACTIVE' AS status,
            COALESCE(SUM(am.spend), 0)::numeric           AS spend,
            COALESCE(SUM(am.impressions), 0)::integer     AS impressions,
            COALESCE(SUM(am.clicks), 0)::integer          AS clicks,
            COALESCE(SUM(am.reach), 0)::integer           AS reach,
            COALESCE(AVG(NULLIF(am.cpm, 0)), 0)::numeric  AS cpm,
            COALESCE(AVG(NULLIF(am.ctr, 0)), 0)::numeric  AS ctr,
            COALESCE(AVG(NULLIF(am.cpc, 0)), 0)::numeric  AS cpc
          FROM ad_metrics am
          WHERE am.user_id = $1 AND am.date >= $2
            AND am.ad_id IS NOT NULL AND am.ad_id != ''
          GROUP BY am.ad_id, am.adset_id, am.campaign_id
          ORDER BY spend DESC
        `, [userId, dateFrom]);
      } catch (e2) {
        console.warn('[Tree] Fallback Level3 tambem falhou:', e2.message);
      }
    }

    // Receita por campanha (utm_campaign = campaigns.external_id)
    const revCampResult = await query(`
      SELECT utm_campaign, SUM(net_revenue)::numeric AS revenue, COUNT(*) AS conversions
      FROM sales
      WHERE user_id=$1 AND status='approved' AND sale_date::date >= $2
      GROUP BY utm_campaign
    `, [userId, dateFrom]);

    // Receita por anuncio (utm_content = ad external_id)
    const revAdResult = await query(`
      SELECT utm_content, SUM(net_revenue)::numeric AS revenue, COUNT(*) AS conversions
      FROM sales
      WHERE user_id=$1 AND status='approved' AND sale_date::date >= $2
      GROUP BY utm_content
    `, [userId, dateFrom]);

    const campRevMap = {};
    revCampResult.rows.forEach(r => {
      campRevMap[r.utm_campaign] = {
        revenue: parseFloat(r.revenue || 0),
        conversions: parseInt(r.conversions || 0),
      };
    });
    const adRevMap = {};
    revAdResult.rows.forEach(r => {
      adRevMap[r.utm_content] = {
        revenue: parseFloat(r.revenue || 0),
        conversions: parseInt(r.conversions || 0),
      };
    });

    // Montar arvore: anuncios agrupados por conjunto
    const adsBySet = {};
    adsResult.rows.forEach(ad => {
      // Para tabela ads: ad.ad_set_id e UUID; para fallback: ad.ad_set_id e adset_id VARCHAR
      const key = ad.ad_set_id || '__none__';
      if (!adsBySet[key]) adsBySet[key] = [];
      const rev   = adRevMap[ad.external_id] || { revenue: 0, conversions: 0 };
      const spend = parseFloat(ad.spend);
      adsBySet[key].push({
        id:          ad.id,
        external_id: ad.external_id,
        name:        ad.name || ('Anuncio ' + String(ad.external_id || ad.id).slice(-6)),
        status:      ad.status || 'ACTIVE',
        spend,
        revenue:     rev.revenue,
        conversions: rev.conversions,
        roas:        spend > 0 ? rev.revenue / spend : 0,
        cpa:         rev.conversions > 0 ? spend / rev.conversions : 0,
        impressions: parseInt(ad.impressions),
        clicks:      parseInt(ad.clicks),
        reach:       parseInt(ad.reach),
        cpm:         parseFloat(ad.cpm),
        ctr:         parseFloat(ad.ctr),
        cpc:         parseFloat(ad.cpc),
        health:      calcHealth(spend, rev.revenue, rev.conversions),
      });
    });

    // Conjuntos agrupados por campanha
    const setsByCamp = {};
    adSetResult.rows.forEach(adSet => {
      const campKey = adSet.campaign_id;
      if (!setsByCamp[campKey]) setsByCamp[campKey] = [];
      const spend       = parseFloat(adSet.spend);
      // Para tabela ads: childAds por UUID do ad_set; para fallback: childAds por adset_id VARCHAR
      const childAds    = adsBySet[adSet.id] || [];
      const revenue     = childAds.reduce((s, a) => s + a.revenue, 0);
      const conversions = childAds.reduce((s, a) => s + a.conversions, 0);
      setsByCamp[campKey].push({
        id:              adSet.id,
        external_id:     adSet.external_id,
        name:            adSet.name || ('Conjunto ' + String(adSet.external_id || adSet.id).slice(-6)),
        status:          adSet.status || 'ACTIVE',
        daily_budget:    parseFloat(adSet.daily_budget  || 0),
        lifetime_budget: parseFloat(adSet.lifetime_budget || 0),
        spend,
        revenue,
        conversions,
        roas:        spend > 0 ? revenue / spend : 0,
        cpa:         conversions > 0 ? spend / conversions : 0,
        impressions: parseInt(adSet.impressions),
        clicks:      parseInt(adSet.clicks),
        reach:       parseInt(adSet.reach),
        cpm:         parseFloat(adSet.cpm),
        ctr:         parseFloat(adSet.ctr),
        cpc:         parseFloat(adSet.cpc),
        health:      calcHealth(spend, revenue, conversions),
        ads:         childAds,
      });
    });

    // Arvore final
    const tree = campResult.rows.map(c => {
      const spend          = parseFloat(c.spend);
      const campRev        = campRevMap[c.external_id] || { revenue: 0, conversions: 0 };
      const adSets         = setsByCamp[c.id] || [];
      const revenue        = campRev.revenue > 0 ? campRev.revenue : adSets.reduce((s, a) => s + a.revenue, 0);
      const conversions    = campRev.conversions > 0 ? campRev.conversions : adSets.reduce((s, a) => s + a.conversions, 0);
      const dailyBudget    = parseFloat(c.daily_budget    || 0);
      const lifetimeBudget = parseFloat(c.lifetime_budget || 0);
      return {
        id:              c.id,
        name:            c.name,
        status:          c.status,
        external_id:     c.external_id,
        integration_id:  c.integration_id,
        daily_budget:    dailyBudget,
        lifetime_budget: lifetimeBudget,
        is_cbo:          dailyBudget > 0 || lifetimeBudget > 0,
        spend,
        revenue,
        conversions,
        roas:        spend > 0 ? revenue / spend : 0,
        cpa:         conversions > 0 ? spend / conversions : 0,
        impressions: parseInt(c.impressions),
        clicks:      parseInt(c.clicks),
        reach:       parseInt(c.reach),
        cpm:         parseFloat(c.cpm),
        ctr:         parseFloat(c.ctr),
        cpc:         parseFloat(c.cpc),
        health:      calcHealth(spend, revenue, conversions),
        ad_sets:     adSets,
      };
    });

    res.json({ data: tree, count: tree.length });
  } catch (error) {
    console.error('[Metrics] Erro tree:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/metrics/toggle
router.post('/toggle', async (req, res) => {
  try {
    const { entity_type, entity_id, action } = req.body;
    const userId = req.user.id;
    if (!['campaign', 'adset', 'ad'].includes(entity_type)) {
      return res.status(400).json({ error: 'entity_type invalido' });
    }
    let metaAds;
    try { metaAds = require('../services/metaAds'); }
    catch (e) { return res.status(503).json({ error: 'Servico Meta Ads nao disponivel' }); }
    const { setEntityStatus } = metaAds;
    const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';
    let external_id, integration_id;
    if (entity_type === 'campaign') {
      const r = await query('SELECT external_id, integration_id FROM campaigns WHERE id=$1 AND user_id=$2', [entity_id, userId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Campanha nao encontrada' });
      external_id = r.rows[0].external_id; integration_id = r.rows[0].integration_id;
    } else if (entity_type === 'adset') {
      external_id = entity_id;
      // Tentar tabela ad_sets primeiro, fallback para ad_metrics
      try {
        const r = await query('SELECT external_id, integration_id FROM ad_sets WHERE id=$1 AND user_id=$2', [entity_id, userId]);
        if (r.rows.length) { external_id = r.rows[0].external_id; integration_id = r.rows[0].integration_id; }
      } catch (e) { /* ad_sets nao existe */ }
      if (!integration_id) {
        const r = await query('SELECT DISTINCT c.integration_id FROM ad_metrics am JOIN campaigns c ON c.id = am.campaign_id WHERE am.adset_id = $1 AND am.user_id = $2 LIMIT 1', [entity_id, userId]);
        if (!r.rows.length) return res.status(404).json({ error: 'Conjunto nao encontrado' });
        integration_id = r.rows[0].integration_id;
      }
    } else {
      external_id = entity_id;
      try {
        const r = await query('SELECT external_id, integration_id FROM ads WHERE id=$1 AND user_id=$2', [entity_id, userId]);
        if (r.rows.length) { external_id = r.rows[0].external_id; integration_id = r.rows[0].integration_id; }
      } catch (e) { /* ads nao existe */ }
      if (!integration_id) {
        const r = await query('SELECT DISTINCT c.integration_id FROM ad_metrics am JOIN campaigns c ON c.id = am.campaign_id WHERE am.ad_id = $1 AND am.user_id = $2 LIMIT 1', [entity_id, userId]);
        if (!r.rows.length) return res.status(404).json({ error: 'Anuncio nao encontrado' });
        integration_id = r.rows[0].integration_id;
      }
    }
    const intR = await query('SELECT access_token FROM integrations WHERE id=$1', [integration_id]);
    if (!intR.rows.length) return res.status(404).json({ error: 'Integracao nao encontrada' });
    const accessToken = decrypt(intR.rows[0].access_token);
    await setEntityStatus(external_id, newStatus, accessToken);
    if (entity_type === 'campaign') {
      await query('UPDATE campaigns SET status=$1 WHERE id=$2 AND user_id=$3', [newStatus, entity_id, userId]);
    }
    res.json({ message: entity_type + ' ' + (newStatus === 'PAUSED' ? 'pausado' : 'ativado') + ' com sucesso', status: newStatus });
  } catch (error) {
    console.error('[Toggle] Erro:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/metrics/update-budget
router.post('/update-budget', async (req, res) => {
  try {
    const { entity_type, entity_id, new_budget } = req.body;
    const userId = req.user.id;
    if (!entity_type || !entity_id || !new_budget || parseFloat(new_budget) <= 0) {
      return res.status(400).json({ error: 'entity_type, entity_id e new_budget sao obrigatorios' });
    }
    if (!['campaign', 'adset'].includes(entity_type)) {
      return res.status(400).json({ error: 'entity_type deve ser campaign ou adset' });
    }
    let metaAds;
    try { metaAds = require('../services/metaAds'); }
    catch (e) { return res.status(503).json({ error: 'Servico Meta Ads nao disponivel' }); }
    const { updateDailyBudget } = metaAds;
    let external_id, integration_id;
    if (entity_type === 'campaign') {
      const r = await query('SELECT external_id, integration_id FROM campaigns WHERE id=$1 AND user_id=$2', [entity_id, userId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Campanha nao encontrada' });
      external_id = r.rows[0].external_id; integration_id = r.rows[0].integration_id;
    } else {
      external_id = entity_id;
      try {
        const r = await query('SELECT external_id, integration_id FROM ad_sets WHERE id=$1 AND user_id=$2', [entity_id, userId]);
        if (r.rows.length) { external_id = r.rows[0].external_id; integration_id = r.rows[0].integration_id; }
      } catch (e) { /* ad_sets nao existe */ }
      if (!integration_id) {
        const r = await query('SELECT DISTINCT c.integration_id FROM ad_metrics am JOIN campaigns c ON c.id = am.campaign_id WHERE am.adset_id = $1 AND am.user_id = $2 LIMIT 1', [entity_id, userId]);
        if (!r.rows.length) return res.status(404).json({ error: 'Conjunto nao encontrado' });
        integration_id = r.rows[0].integration_id;
      }
    }
    const intR = await query('SELECT access_token FROM integrations WHERE id=$1', [integration_id]);
    if (!intR.rows.length) return res.status(404).json({ error: 'Integracao nao encontrada' });
    const accessToken = decrypt(intR.rows[0].access_token);
    await updateDailyBudget(external_id, parseFloat(new_budget), accessToken);
    if (entity_type === 'campaign') {
      await query('UPDATE campaigns SET daily_budget=$1 WHERE id=$2 AND user_id=$3', [new_budget, entity_id, userId]);
    }
    res.json({ message: 'Orcamento atualizado para R$ ' + parseFloat(new_budget).toFixed(2) });
  } catch (error) {
    console.error('[Budget] Erro:', error.message);
    const msg = error.response && error.response.data && error.response.data.error
      ? error.response.data.error.message : error.message || 'Erro ao atualizar orcamento';
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
