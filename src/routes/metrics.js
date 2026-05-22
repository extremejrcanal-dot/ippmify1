const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { calculateOverview, calculateByCampaign, calculateDailyHistory } = require('../services/metricsEngine');
const { get, setEx } = require('../config/redis');
const { decrypt } = require('../services/encryptionService');

const router = express.Router();

// Todas as rotas exigem login
router.use(requireAuth);

// ─── VISAO GERAL ───────────────────────────────────────────────────────────
// GET /api/metrics/overview?days=7
router.get('/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cacheKey = `metrics:overview:${req.user.id}:${days}d`;

    // Tentar cache primeiro
    const cached = await get(cacheKey);
    if (cached) return res.json({ data: cached, cached: true });

    const metrics = await calculateOverview(req.user.id, days);
    res.json({ data: metrics, cached: false });
  } catch (error) {
    console.error('[Metrics] Erro overview:', error.message);
    res.status(500).json({ error: 'Erro ao calcular metricas' });
  }
});

// ─── METRICAS POR CAMPANHA ─────────────────────────────────────────────────
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

// ─── HISTORICO DIARIO ──────────────────────────────────────────────────────
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

// ─── ARVORE COMPLETA (3 NIVEIS) ────────────────────────────────────────────
// GET /api/metrics/tree?days=7&period=today|month|7|14|30&integration_id=uuid
router.get('/tree', async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = require('../config/database');

    // Calcular intervalo de datas
    let startDate, days;
    const period = req.query.period || req.query.days || '7';
    if (period === 'today') {
      startDate = 'CURRENT_DATE';
      days = 1;
    } else if (period === 'month') {
      startDate = "date_trunc('month', CURRENT_DATE)";
      days = 31;
    } else {
      days = parseInt(period) || 7;
      startDate = `CURRENT_DATE - ${days}::integer`;
    }

    const integrationId = req.query.integration_id || null;

    // Buscar targets do usuario para calcular saude
    const userResult = await query('SELECT cpa_target, roas_target FROM users WHERE id=$1', [userId]);
    const cpaTarget  = parseFloat(userResult.rows[0]?.cpa_target  || 50);
    const roasTarget = parseFloat(userResult.rows[0]?.roas_target || 2);

    const calcHealth = (spend, revenue, conversions) => {
      if (spend === 0) return 'gray';
      const roas = spend > 0 ? revenue / spend : 0;
      const cpa  = conversions > 0 ? spend / conversions : 9999;
      if (roas >= roasTarget && cpa <= cpaTarget) return 'green';
      if (roas >= roasTarget * 0.7 || cpa <= cpaTarget * 1.3) return 'yellow';
      return 'red';
    };

    // Filtro de integration_id (conta de anúncio)
    const integFilter = integrationId ? `AND c.integration_id = '${integrationId}'` : '';
    const integFilterSet = integrationId ? `AND ads.integration_id = '${integrationId}'` : '';
    const integFilterAd  = integrationId ? `AND a.integration_id = '${integrationId}'` : '';

    // NIVEL 1 — Campanhas
    const campResult = await query(`
      SELECT c.id, c.name, c.status, c.external_id, c.objective,
        c.integration_id, c.daily_budget, c.lifetime_budget,
        COALESCE(SUM(am.spend), 0)::numeric       AS spend,
        COALESCE(SUM(am.impressions), 0)::integer AS impressions,
        COALESCE(SUM(am.clicks), 0)::integer      AS clicks,
        COALESCE(AVG(am.cpm), 0)::numeric         AS cpm,
        COALESCE(AVG(am.ctr), 0)::numeric         AS ctr
      FROM campaigns c
      LEFT JOIN ad_metrics am ON am.campaign_id = c.id
        AND am.date >= ${startDate}
      WHERE c.user_id = $1 ${integFilter}
      GROUP BY c.id, c.name, c.status, c.external_id, c.objective,
               c.integration_id, c.daily_budget, c.lifetime_budget
      ORDER BY spend DESC
    `, [userId]);

    // NIVEL 2 — Conjuntos
    const adSetResult = await query(`
      SELECT ads.id, ads.name, ads.status, ads.campaign_id, ads.external_id,
        ads.daily_budget, ads.lifetime_budget,
        COALESCE(SUM(asm.spend), 0)::numeric       AS spend,
        COALESCE(SUM(asm.impressions), 0)::integer AS impressions,
        COALESCE(SUM(asm.clicks), 0)::integer      AS clicks,
        COALESCE(AVG(asm.cpm), 0)::numeric         AS cpm,
        COALESCE(AVG(asm.ctr), 0)::numeric         AS ctr
      FROM ad_sets ads
      LEFT JOIN ad_set_metrics asm ON asm.ad_set_id = ads.id
        AND asm.date >= ${startDate}
      WHERE ads.user_id = $1 ${integFilterSet}
      GROUP BY ads.id, ads.name, ads.status, ads.campaign_id, ads.external_id,
               ads.daily_budget, ads.lifetime_budget
      ORDER BY spend DESC
    `, [userId]);

    // NIVEL 3 — Anuncios
    const adsResult = await query(`
      SELECT a.id, a.name, a.status, a.campaign_id, a.ad_set_id, a.external_id,
        COALESCE(SUM(alm.spend), 0)::numeric       AS spend,
        COALESCE(SUM(alm.impressions), 0)::integer AS impressions,
        COALESCE(SUM(alm.clicks), 0)::integer      AS clicks,
        COALESCE(AVG(alm.cpm), 0)::numeric         AS cpm,
        COALESCE(AVG(alm.ctr), 0)::numeric         AS ctr
      FROM ads a
      LEFT JOIN ad_level_metrics alm ON alm.ad_id = a.id
        AND alm.date >= ${startDate}
      WHERE a.user_id = $1 ${integFilterAd}
      GROUP BY a.id, a.name, a.status, a.campaign_id, a.ad_set_id, a.external_id
      ORDER BY spend DESC
    `, [userId]);

    // Receita por campanha (via utm_campaign)
    const revenueBycamp = await query(`
      SELECT utm_campaign, SUM(net_revenue) AS revenue, COUNT(*) AS conversions
      FROM sales
      WHERE user_id=$1 AND status='approved'
        AND sale_date::date >= ${startDate}
      GROUP BY utm_campaign
    `, [userId]);

    // Receita por anuncio (via utm_content)
    const revenueByAd = await query(`
      SELECT utm_content, SUM(net_revenue) AS revenue, COUNT(*) AS conversions
      FROM sales
      WHERE user_id=$1 AND status='approved'
        AND sale_date::date >= ${startDate}
      GROUP BY utm_content
    `, [userId]);

    const campRevMap = {};
    revenueBycamp.rows.forEach(r => { campRevMap[r.utm_campaign] = { revenue: parseFloat(r.revenue||0), conversions: parseInt(r.conversions||0) }; });

    const adRevMap = {};
    revenueByAd.rows.forEach(r => { adRevMap[r.utm_content] = { revenue: parseFloat(r.revenue||0), conversions: parseInt(r.conversions||0) }; });

    // Montar arvore
    const adsBySet = {};
    adsResult.rows.forEach(ad => {
      const key = ad.ad_set_id;
      if (!adsBySet[key]) adsBySet[key] = [];
      const rev = adRevMap[ad.external_id] || { revenue: 0, conversions: 0 };
      const spend = parseFloat(ad.spend);
      adsBySet[key].push({
        id: ad.id, name: ad.name, status: ad.status, external_id: ad.external_id,
        spend, revenue: rev.revenue, conversions: rev.conversions,
        roas: spend > 0 ? rev.revenue / spend : 0,
        cpa: rev.conversions > 0 ? spend / rev.conversions : 0,
        impressions: ad.impressions, clicks: ad.clicks,
        cpm: parseFloat(ad.cpm), ctr: parseFloat(ad.ctr),
        health: calcHealth(spend, rev.revenue, rev.conversions),
      });
    });

    const setsByCamp = {};
    adSetResult.rows.forEach(adSet => {
      const key = adSet.campaign_id;
      if (!setsByCamp[key]) setsByCamp[key] = [];
      const spend = parseFloat(adSet.spend);
      const childAds = adsBySet[adSet.id] || [];
      const revenue = childAds.reduce((s, a) => s + a.revenue, 0);
      const conversions = childAds.reduce((s, a) => s + a.conversions, 0);
      setsByCamp[key].push({
        id: adSet.id, name: adSet.name, status: adSet.status, external_id: adSet.external_id,
        daily_budget: parseFloat(adSet.daily_budget || 0),
        lifetime_budget: parseFloat(adSet.lifetime_budget || 0),
        spend, revenue, conversions,
        roas: spend > 0 ? revenue / spend : 0,
        cpa: conversions > 0 ? spend / conversions : 0,
        impressions: adSet.impressions, clicks: adSet.clicks,
        cpm: parseFloat(adSet.cpm), ctr: parseFloat(adSet.ctr),
        health: calcHealth(spend, revenue, conversions),
        ads: childAds,
      });
    });

    const tree = campResult.rows.map(c => {
      const spend = parseFloat(c.spend);
      const campRev = campRevMap[c.external_id] || { revenue: 0, conversions: 0 };
      const adSets = setsByCamp[c.id] || [];
      const revenue = campRev.revenue > 0 ? campRev.revenue : adSets.reduce((s, a) => s + a.revenue, 0);
      const conversions = campRev.conversions > 0 ? campRev.conversions : adSets.reduce((s, a) => s + a.conversions, 0);
      const dailyBudget = parseFloat(c.daily_budget || 0);
      const lifetimeBudget = parseFloat(c.lifetime_budget || 0);
      // CBO: orçamento definido no nível da campanha (daily_budget > 0)
      const is_cbo = dailyBudget > 0 || lifetimeBudget > 0;
      return {
        id: c.id, name: c.name, status: c.status, external_id: c.external_id,
        objective: c.objective, integration_id: c.integration_id,
        daily_budget: dailyBudget, lifetime_budget: lifetimeBudget, is_cbo,
        spend, revenue, conversions,
        roas: spend > 0 ? revenue / spend : 0,
        cpa: conversions > 0 ? spend / conversions : 0,
        impressions: c.impressions, clicks: c.clicks,
        cpm: parseFloat(c.cpm), ctr: parseFloat(c.ctr),
        health: calcHealth(spend, revenue, conversions),
        ad_sets: adSets,
      };
    });

    res.json({ data: tree, count: tree.length });
  } catch (error) {
    console.error('[Metrics] Erro tree:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── TOGGLE STATUS (pausar / ativar via Meta API) ──────────────────────────
// POST /api/metrics/toggle
// body: { entity_type: 'campaign'|'adset'|'ad', entity_id: <uuid>, action: 'pause'|'activate' }
router.post('/toggle', async (req, res) => {
  try {
    const { entity_type, entity_id, action } = req.body;
    const userId = req.user.id;
    const { query } = require('../config/database');
    const { setEntityStatus } = require('../services/metaAds');

    const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';

    const tableMap = { campaign: 'campaigns', adset: 'ad_sets', ad: 'ads' };
    const tableName = tableMap[entity_type];
    if (!tableName) return res.status(400).json({ error: 'entity_type invalido' });

    // Buscar external_id e integration_id da entidade
    const entityResult = await query(
      `SELECT external_id, integration_id FROM ${tableName} WHERE id=$1 AND user_id=$2`,
      [entity_id, userId]
    );
    if (entityResult.rows.length === 0) {
      return res.status(404).json({ error: 'Entidade nao encontrada' });
    }
    const { external_id, integration_id } = entityResult.rows[0];

    // Buscar token da integracao
    const intResult = await query(
      'SELECT access_token FROM integrations WHERE id=$1',
      [integration_id]
    );
    if (intResult.rows.length === 0) {
      return res.status(404).json({ error: 'Integracao nao encontrada' });
    }
    const accessToken = decrypt(intResult.rows[0].access_token);

    // Chamar a Meta API
    await setEntityStatus(external_id, newStatus, accessToken);

    // Atualizar status no banco local
    await query(
      `UPDATE ${tableName} SET status=$1 WHERE id=$2 AND user_id=$3`,
      [newStatus, entity_id, userId]
    );

    res.json({
      message: `${entity_type} ${newStatus === 'PAUSED' ? 'pausado' : 'ativado'} com sucesso`,
      status: newStatus,
    });
  } catch (error) {
    console.error('[Toggle] Erro:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── ATUALIZAR ORÇAMENTO (CBO / ABO) ──────────────────────────────────────
// POST /api/metrics/update-budget
// body: { entity_type: 'campaign'|'adset', entity_id: <uuid>, new_budget: number }
router.post('/update-budget', async (req, res) => {
  try {
    const { entity_type, entity_id, new_budget } = req.body;
    const userId = req.user.id;
    const { query } = require('../config/database');
    const { updateDailyBudget, getIntegrationToken } = require('../services/metaAds');

    if (!entity_type || !entity_id || !new_budget || new_budget <= 0) {
      return res.status(400).json({ error: 'entity_type, entity_id e new_budget são obrigatórios' });
    }

    const tableMap = { campaign: 'campaigns', adset: 'ad_sets' };
    const tableName = tableMap[entity_type];
    if (!tableName) return res.status(400).json({ error: 'entity_type deve ser campaign ou adset' });

    // Buscar entidade
    const entityResult = await query(
      `SELECT external_id, integration_id FROM ${tableName} WHERE id=$1 AND user_id=$2`,
      [entity_id, userId]
    );
    if (!entityResult.rows.length) return res.status(404).json({ error: 'Entidade não encontrada' });

    const { external_id, integration_id } = entityResult.rows[0];

    // Buscar token da integração
    const integrations = await (require('../services/metaAds').getAllIntegrations)(userId);
    const intData = integrations.find(i => i.integration.id === integration_id) || integrations[0];
    if (!intData) return res.status(400).json({ error: 'Conta Meta Ads não encontrada ou desconectada' });

    // Atualizar via Meta API
    await updateDailyBudget(external_id, parseFloat(new_budget), intData.accessToken);

    // Atualizar DB
    await query(
      `UPDATE ${tableName} SET daily_budget=$1 WHERE id=$2 AND user_id=$3`,
      [new_budget, entity_id, userId]
    );

    console.log(`[Budget] ${entity_type} ${entity_id} → R$${new_budget} (user: ${userId})`);
    res.json({ message: `Orçamento atualizado para R$ ${parseFloat(new_budget).toFixed(2)}` });

  } catch (error) {
    console.error('[Budget] Erro:', error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message || 'Erro ao atualizar orçamento' });
  }
});

module.exports = router;
