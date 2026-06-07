const { query } = require('../config/database');
const { calculateByCampaign } = require('./metricsEngine');
const { pauseEntity, updateDailyBudget, getIntegrationToken } = require('./metaAds');

// ─── CONFIGURACOES DO USUARIO ──────────────────────────────────────────────
const getUserConfig = async (userId) => {
  const result = await query('SELECT cpa_target, roas_target, roas_breakeven FROM users WHERE id = $1', [userId]);
  const u = result.rows[0] || {};
  const cpaTarget = parseFloat(u.cpa_target || 50);
  return {
    cpa_target:     cpaTarget,
    roas_target:    parseFloat(u.roas_target || 2),
    roas_breakeven: parseFloat(u.roas_breakeven || 1),
    // Minimo 2x o CPA target para evitar pausas prematuras (ex: CPA R$70 → min R$140)
    min_spend:      Math.max(cpaTarget * 2, 50),
    ctr_drop_pct:   0.30,
    conv_drop_pct:  0.50,
    cpm_spike_pct:  1.0,
  };
};

// ─── EXECUTAR ACAO NO META ADS ─────────────────────────────────────────────
const executeMetaAction = async (userId, decisionId, action) => {
  const tokenData = await getIntegrationToken(userId);
  if (!tokenData || !tokenData.accessToken) {
    console.log('[Action] Meta Ads nao conectado — acao nao executada');
    return false;
  }

  const { accessToken } = tokenData;

  try {
    if (action.type === 'PAUSE') {
      await pauseEntity(action.entityId, accessToken);
    } else if (action.type === 'SCALE_BUDGET') {
      await updateDailyBudget(action.entityId, action.newBudget, accessToken);
    }

    // Registrar acao executada
    await query(`
      INSERT INTO automated_actions
        (user_id, decision_id, entity_type, entity_id, entity_name,
         action_type, old_value, new_value, status, executed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'executed',NOW())
    `, [
      userId, decisionId,
      action.entityType, action.entityId, action.entityName,
      action.type,
      JSON.stringify(action.oldValue || {}),
      JSON.stringify(action.newValue || {}),
    ]);

    console.log(`[Action] ${action.type} executado em ${action.entityName} (${action.entityId})`);
    return true;
  } catch (err) {
    console.error(`[Action] Erro ao executar ${action.type}:`, err.message);

    await query(`
      INSERT INTO automated_actions
        (user_id, decision_id, entity_type, entity_id, entity_name,
         action_type, old_value, new_value, status, error_message, executed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed',$9,NOW())
    `, [
      userId, decisionId,
      action.entityType, action.entityId, action.entityName,
      action.type,
      JSON.stringify(action.oldValue || {}),
      JSON.stringify(action.newValue || {}),
      err.message,
    ]);
    return false;
  }
};

// ─── CRIAR ACAO PENDENTE — AGUARDA CONFIRMACAO VIA LINK NO WHATSAPP ──────────
// PAUSA nunca e executada automaticamente — usuario clica em link recebido no WA
const createPendingAction = async (userId, decisionId, decision) => {
  try {
    // Verificar se ja existe acao pendente ativa para esta entidade
    const existing = await query(`
      SELECT id FROM pending_actions
      WHERE user_id = $1
        AND entity_external_id = $2
        AND status = 'pending_approval'
        AND expires_at > NOW()
    `, [userId, decision.entity_external_id]);

    if (existing.rows.length > 0) {
      console.log(`[Action] Acao pendente ja existe para "${decision.entity_name}" — nao reenviando alerta`);
      return;
    }

    // Inserir acao pendente e obter o UUID gerado (sera usado como token no link)
    const result = await query(`
      INSERT INTO pending_actions
        (user_id, decision_id, action_type, entity_type, entity_external_id, entity_name, new_budget)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      userId, decisionId,
      decision.action_type,
      decision.entity_type,
      decision.entity_external_id,
      decision.entity_name,
      decision.new_budget || null,
    ]);

    const pendingId = result.rows[0].id;
    // Link de confirmacao — usuario clica no WhatsApp para aprovar a pausa
    const confirmUrl = `${process.env.APP_URL || 'https://ippmify1-production.up.railway.app'}/api/integrations/confirm/${pendingId}`;

    // Enviar WhatsApp com link de confirmacao via CallMeBot
    const { sendPauseRequest } = require('./alertService');
    await sendPauseRequest(userId, decision, confirmUrl);

    console.log(`[Action] PAUSE pendente (${pendingId}) — link enviado via WhatsApp: "${decision.entity_name}"`);
  } catch (err) {
    console.error('[createPendingAction] Erro:', err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// NIVEL 1 — AVALIACAO DE CAMPANHAS
// ═══════════════════════════════════════════════════════════════════════════

const getCampaignHistory7d = async (userId, campaignExternalId) => {
  const result = await query(`
    SELECT am.date,
      COALESCE(SUM(am.spend), 0) AS spend,
      COALESCE(SUM(am.impressions), 0) AS impressions,
      COALESCE(SUM(am.clicks), 0) AS clicks,
      COALESCE(SUM(s.net_revenue), 0) AS revenue,
      COUNT(s.id) AS conversions,
      CASE WHEN SUM(am.impressions)>0 THEN SUM(am.spend)/SUM(am.impressions)*1000 ELSE 0 END AS cpm,
      CASE WHEN SUM(am.impressions)>0 THEN SUM(am.clicks)::float/SUM(am.impressions)*100 ELSE 0 END AS ctr,
      CASE WHEN SUM(am.spend)>0 THEN SUM(s.net_revenue)/SUM(am.spend) ELSE 0 END AS roas
    FROM ad_metrics am
    JOIN campaigns c ON c.id = am.campaign_id
    LEFT JOIN sales s ON s.utm_campaign = c.external_id
      AND s.status='approved' AND s.user_id=$1 AND DATE(s.sale_date)=am.date
    WHERE c.user_id=$1 AND c.external_id=$2
      AND am.date >= CURRENT_DATE - INTERVAL '7 days' AND am.date < CURRENT_DATE
    GROUP BY am.date ORDER BY am.date DESC
  `, [userId, campaignExternalId]);
  return result.rows;
};

const evaluateCampaign = (campaign, history7d, config) => {
  const decisions = [];
  const c = campaign;
  const avgRoas7d  = history7d.length > 0 ? history7d.reduce((s,r) => s + parseFloat(r.roas), 0) / history7d.length : c.roas;
  const avgCtr7d   = history7d.length > 0 ? history7d.reduce((s,r) => s + parseFloat(r.ctr), 0) / history7d.length : c.ctr;
  const avgConv7d  = history7d.length > 0 ? history7d.reduce((s,r) => s + parseInt(r.conversions), 0) / history7d.length : 1;
  const avgCpm7d   = history7d.length > 0 ? history7d.reduce((s,r) => s + parseFloat(r.cpm), 0) / history7d.length : c.cpm;
  const budgetUtil = c.daily_budget > 0 ? c.spend / c.daily_budget : 1;

  if (c.cpa > config.cpa_target * 2 && c.spend >= config.min_spend) {
    decisions.push({
      rule_id: 'R01', type: 'HIGH_CPA', severity: 9,
      title: `CPA R$${c.cpa.toFixed(2)} — ${(c.cpa/config.cpa_target).toFixed(1)}x acima do target`,
      description: `Campanha "${c.campaign_name}" com CPA critico. Target: R$${config.cpa_target.toFixed(2)}.`,
      recommendation: `CPA critico detectado. Aguardando sua confirmacao via WhatsApp para pausar. Revise criativos e publico antes de reativar.`,
      action_type: 'PAUSE', entity_type: 'campaign', entity_external_id: c.external_id, entity_name: c.campaign_name,
      data_snapshot: { cpa: c.cpa, cpa_target: config.cpa_target, spend: c.spend }
    });
  } else if (c.cpa > config.cpa_target * 1.5 && c.spend >= config.min_spend) {
    decisions.push({
      rule_id: 'R02', type: 'HIGH_CPA', severity: 6,
      title: `CPA R$${c.cpa.toFixed(2)} — acima do target`,
      description: `CPA ${(c.cpa/config.cpa_target).toFixed(1)}x acima do target de R$${config.cpa_target.toFixed(2)}.`,
      recommendation: `Revise criativos e publico. Teste novas segmentacoes.`,
      action_type: 'REVIEW', data_snapshot: { cpa: c.cpa, cpa_target: config.cpa_target }
    });
  }

  if (c.roas < config.roas_breakeven && c.spend >= config.min_spend && c.conversions > 0) {
    decisions.push({
      rule_id: 'R03', type: 'LOW_ROAS', severity: 9,
      title: `ROAS ${c.roas.toFixed(2)}x — Campanha dando PREJUIZO`,
      description: `Prejuizo real de R$${Math.abs(c.profit).toFixed(2)} no periodo.`,
      recommendation: `ROAS abaixo do ponto de equilibrio — campanha gerando prejuizo. Aguardando sua confirmacao via WhatsApp para pausar.`,
      action_type: 'PAUSE', entity_type: 'campaign', entity_external_id: c.external_id, entity_name: c.campaign_name,
      data_snapshot: { roas: c.roas, roas_breakeven: config.roas_breakeven, profit: c.profit }
    });
  }

  if (avgRoas7d > 0 && c.roas < avgRoas7d * 0.8 && c.spend >= config.min_spend) {
    const dropPct = ((avgRoas7d - c.roas) / avgRoas7d * 100).toFixed(0);
    decisions.push({
      rule_id: 'R04', type: 'ROAS_DROPPING', severity: 5,
      title: `ROAS caiu ${dropPct}% vs. media 7 dias`,
      description: `ROAS atual: ${c.roas.toFixed(2)}x. Media 7d: ${avgRoas7d.toFixed(2)}x.`,
      recommendation: `Investigate saturacao de publico ou concorrencia. Teste novos anuncios.`,
      action_type: 'REVIEW', data_snapshot: { roas_today: c.roas, roas_7d_avg: avgRoas7d }
    });
  }

  if (c.roas > config.roas_target * 1.3 && budgetUtil < 0.7 && c.spend >= config.min_spend) {
    const suggestedBudget = c.daily_budget * 1.25;
    decisions.push({
      rule_id: 'R05', type: 'SCALE_OPPORTUNITY', severity: 3,
      title: `ROAS ${c.roas.toFixed(2)}x — Oportunidade de escala`,
      description: `Campanha usando apenas ${(budgetUtil*100).toFixed(0)}% do orcamento com ROAS excelente.`,
      recommendation: `⚡ ACAO AUTOMATICA: Budget aumentado 25%: R$${c.daily_budget.toFixed(2)} → R$${suggestedBudget.toFixed(2)}.`,
      action_type: 'SCALE_BUDGET', entity_type: 'campaign', entity_external_id: c.external_id, entity_name: c.campaign_name,
      new_budget: suggestedBudget,
      data_snapshot: { roas: c.roas, budget: c.daily_budget, suggested_budget: suggestedBudget }
    });
  }

  if (c.spend >= config.min_spend && c.conversions === 0) {
    decisions.push({
      rule_id: 'R09', type: 'ZERO_SALES', severity: 8,
      title: `R$${c.spend.toFixed(2)} gastos — ZERO vendas`,
      description: `Gasto sem nenhuma conversao registrada.`,
      recommendation: `Gasto sem conversoes rastreadas. Aguardando sua confirmacao via WhatsApp para pausar. Verifique pagina de vendas e rastreamento.`,
      action_type: 'PAUSE', entity_type: 'campaign', entity_external_id: c.external_id, entity_name: c.campaign_name,
      data_snapshot: { spend: c.spend, conversions: 0 }
    });
  }

  return decisions;
};

// ═══════════════════════════════════════════════════════════════════════════
// NIVEL 2 — AVALIACAO DE CONJUNTOS (Ad Sets)
// ═══════════════════════════════════════════════════════════════════════════

const getAdSetData = async (userId, daysBack = 3) => {
  const result = await query(`
    SELECT
      asm.ad_set_id,
      ads_t.external_id AS ad_set_external_id,
      ads_t.name AS ad_set_name,
      ads_t.daily_budget,
      c.external_id AS campaign_external_id,
      c.name AS campaign_name,
      SUM(asm.spend) AS spend,
      SUM(asm.impressions) AS impressions,
      SUM(asm.clicks) AS clicks,
      AVG(asm.cpm) AS cpm,
      AVG(asm.ctr) AS ctr,
      COALESCE(SUM(s.net_revenue), 0) AS revenue,
      COUNT(DISTINCT s.id) AS conversions,
      CASE WHEN SUM(asm.spend) > 0
        THEN COALESCE(SUM(s.net_revenue), 0) / SUM(asm.spend) ELSE 0 END AS roas,
      CASE WHEN COUNT(DISTINCT s.id) > 0
        THEN SUM(asm.spend) / COUNT(DISTINCT s.id) ELSE 999999 END AS cpa
    FROM ad_set_metrics asm
    JOIN ad_sets ads_t ON ads_t.id = asm.ad_set_id
    JOIN campaigns c ON c.id = ads_t.campaign_id
    LEFT JOIN sales s ON s.utm_campaign = c.external_id
      AND s.status='approved' AND s.user_id=$1
      AND DATE(s.sale_date) >= CURRENT_DATE - $2
    WHERE asm.user_id=$1
      AND asm.date >= CURRENT_DATE - $2
    GROUP BY asm.ad_set_id, ads_t.external_id, ads_t.name, ads_t.daily_budget, c.external_id, c.name
    HAVING SUM(asm.spend) > 10
    ORDER BY SUM(asm.spend) DESC
  `, [userId, daysBack]);
  return result.rows;
};

const getAdSetHistory7d = async (userId, adSetId) => {
  const result = await query(`
    SELECT date, AVG(cpm) AS cpm, AVG(ctr) AS ctr, SUM(spend) AS spend
    FROM ad_set_metrics
    WHERE user_id=$1 AND ad_set_id=$2
      AND date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY date ORDER BY date DESC
  `, [userId, adSetId]);
  return result.rows;
};

const evaluateAdSets = async (userId, config) => {
  const adSets = await getAdSetData(userId, 3);
  const decisions = [];

  for (const adSet of adSets) {
    const history7d = await getAdSetHistory7d(userId, adSet.ad_set_id);
    const avgCpm7d = history7d.length > 0 ? history7d.reduce((s,r) => s + parseFloat(r.cpm), 0) / history7d.length : parseFloat(adSet.cpm);
    const avgCtr7d = history7d.length > 0 ? history7d.reduce((s,r) => s + parseFloat(r.ctr), 0) / history7d.length : parseFloat(adSet.ctr);

    const cpa      = parseFloat(adSet.cpa);
    const roas     = parseFloat(adSet.roas);
    const spend    = parseFloat(adSet.spend);
    const cpm      = parseFloat(adSet.cpm);
    const ctr      = parseFloat(adSet.ctr);

    // Fadiga de audiencia: CPM subindo + CTR caindo
    if (avgCpm7d > 0 && avgCtr7d > 0 && cpm > avgCpm7d * 1.5 && ctr < avgCtr7d * 0.7) {
      decisions.push({
        rule_id: 'AS01', type: 'AUDIENCE_FATIGUE', severity: 7,
        title: `Fadiga de audiencia — Conjunto "${adSet.ad_set_name}"`,
        description: `CPM subiu ${((cpm/avgCpm7d-1)*100).toFixed(0)}% e CTR caiu ${((1-ctr/avgCtr7d)*100).toFixed(0)}% vs media 7 dias. Audiencia saturada.`,
        recommendation: `Audiencia saturada detectada. Aguardando sua confirmacao via WhatsApp para pausar. Crie um novo conjunto com audiencia diferente.`,
        action_type: 'PAUSE', entity_type: 'ad_set', entity_external_id: adSet.ad_set_external_id, entity_name: adSet.ad_set_name,
        data_snapshot: { cpm, cpm_7d: avgCpm7d, ctr, ctr_7d: avgCtr7d }
      });
    }

    // CPA critico no nivel de conjunto
    if (cpa > config.cpa_target * 2 && spend >= config.min_spend) {
      decisions.push({
        rule_id: 'AS02', type: 'HIGH_CPA_ADSET', severity: 8,
        title: `CPA R$${cpa.toFixed(2)} — Conjunto "${adSet.ad_set_name}"`,
        description: `CPA ${(cpa/config.cpa_target).toFixed(1)}x acima do target neste conjunto de anuncios.`,
        recommendation: `CPA critico no conjunto. Aguardando sua confirmacao via WhatsApp para pausar. Teste nova segmentacao de publico.`,
        action_type: 'PAUSE', entity_type: 'ad_set', entity_external_id: adSet.ad_set_external_id, entity_name: adSet.ad_set_name,
        data_snapshot: { cpa, cpa_target: config.cpa_target, spend }
      });
    }

    // Conjunto lucrativo — escalar budget
    if (roas > config.roas_target * 1.5 && spend >= config.min_spend && parseFloat(adSet.daily_budget) > 0) {
      const newBudget = parseFloat(adSet.daily_budget) * 1.20;
      decisions.push({
        rule_id: 'AS03', type: 'SCALE_ADSET', severity: 2,
        title: `ROAS ${roas.toFixed(2)}x — Escalar conjunto "${adSet.ad_set_name}"`,
        description: `Conjunto com ROAS ${roas.toFixed(2)}x acima do target de ${config.roas_target}x. Boa oportunidade de escala.`,
        recommendation: `⚡ ACAO AUTOMATICA: Budget do conjunto aumentado 20%: R$${parseFloat(adSet.daily_budget).toFixed(2)} → R$${newBudget.toFixed(2)}.`,
        action_type: 'SCALE_BUDGET', entity_type: 'ad_set', entity_external_id: adSet.ad_set_external_id, entity_name: adSet.ad_set_name,
        new_budget: newBudget,
        data_snapshot: { roas, budget: parseFloat(adSet.daily_budget), new_budget: newBudget }
      });
    }
  }

  return decisions;
};

// ═══════════════════════════════════════════════════════════════════════════
// NIVEL 3 — AVALIACAO DE ANUNCIOS INDIVIDUAIS (com atribuicao UTM)
// ═══════════════════════════════════════════════════════════════════════════

const getAdLevelData = async (userId, daysBack = 3) => {
  const result = await query(`
    SELECT
      alm.ad_id,
      a.external_id AS ad_external_id,
      a.name AS ad_name,
      ads_t.external_id AS ad_set_external_id,
      ads_t.name AS ad_set_name,
      c.external_id AS campaign_external_id,
      SUM(alm.spend) AS spend,
      SUM(alm.impressions) AS impressions,
      SUM(alm.clicks) AS clicks,
      AVG(alm.cpm) AS cpm,
      AVG(alm.ctr) AS ctr,
      -- Atribuicao via utm_content = ad ID (rastreamento direto)
      COALESCE((
        SELECT SUM(s2.net_revenue) FROM sales s2
        WHERE s2.utm_content = a.external_id
          AND s2.status = 'approved' AND s2.user_id=$1
          AND DATE(s2.sale_date) >= CURRENT_DATE - $2
      ), 0) AS revenue_direct,
      COALESCE((
        SELECT COUNT(*) FROM sales s2
        WHERE s2.utm_content = a.external_id
          AND s2.status = 'approved' AND s2.user_id=$1
          AND DATE(s2.sale_date) >= CURRENT_DATE - $2
      ), 0) AS conversions_direct
    FROM ad_level_metrics alm
    JOIN ads a ON a.id = alm.ad_id
    JOIN ad_sets ads_t ON ads_t.id = a.ad_set_id
    JOIN campaigns c ON c.id = a.campaign_id
    WHERE alm.user_id=$1
      AND alm.date >= CURRENT_DATE - $2
    GROUP BY alm.ad_id, a.external_id, a.name, ads_t.external_id, ads_t.name, c.external_id
    HAVING SUM(alm.spend) > 5
    ORDER BY SUM(alm.spend) DESC
    LIMIT 100
  `, [userId, daysBack]);
  return result.rows;
};

const getAdHistory7d = async (userId, adId) => {
  const result = await query(`
    SELECT date, AVG(ctr) AS ctr, AVG(cpm) AS cpm, SUM(spend) AS spend
    FROM ad_level_metrics
    WHERE user_id=$1 AND ad_id=$2
      AND date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY date ORDER BY date DESC
  `, [userId, adId]);
  return result.rows;
};

const evaluateAds = async (userId, config) => {
  const ads = await getAdLevelData(userId, 3);
  const decisions = [];

  for (const ad of ads) {
    const history7d = await getAdHistory7d(userId, ad.ad_id);
    const avgCtr7d = history7d.length > 0 ? history7d.reduce((s,r) => s + parseFloat(r.ctr), 0) / history7d.length : parseFloat(ad.ctr);

    const spend       = parseFloat(ad.spend);
    const ctr         = parseFloat(ad.ctr);
    const cpm         = parseFloat(ad.cpm);
    const revenue     = parseFloat(ad.revenue_direct);
    const conversions = parseInt(ad.conversions_direct);
    const roas        = spend > 0 ? revenue / spend : 0;
    const cpa         = conversions > 0 ? spend / conversions : 999999;

    // Criativo esgotado — CTR caiu muito
    if (avgCtr7d > 0 && ctr < avgCtr7d * 0.6 && spend >= config.min_spend) {
      const dropPct = ((avgCtr7d - ctr) / avgCtr7d * 100).toFixed(0);
      decisions.push({
        rule_id: 'AD01', type: 'CREATIVE_FATIGUE_AD', severity: 7,
        title: `Criativo esgotado — "${ad.ad_name}"`,
        description: `CTR caiu ${dropPct}% vs media 7 dias. Publico ignorando este anuncio.`,
        recommendation: `Criativo com queda de CTR detectada. Aguardando sua confirmacao via WhatsApp para pausar. Crie nova versao com angulo diferente.`,
        action_type: 'PAUSE', entity_type: 'ad', entity_external_id: ad.ad_external_id, entity_name: ad.ad_name,
        data_snapshot: { ctr, ctr_7d: avgCtr7d, drop_pct: dropPct, spend }
      });
    }

    // CPA critico no nivel de anuncio
    if (cpa > config.cpa_target * 2.5 && spend >= config.min_spend && conversions > 0) {
      decisions.push({
        rule_id: 'AD02', type: 'HIGH_CPA_AD', severity: 8,
        title: `CPA R$${cpa.toFixed(2)} — Anuncio "${ad.ad_name}"`,
        description: `Este anuncio especifico tem CPA ${(cpa/config.cpa_target).toFixed(1)}x acima do target. Criativo nao converte.`,
        recommendation: `CPA critico no anuncio. Aguardando sua confirmacao via WhatsApp para pausar. O criativo nao esta convertendo para este publico.`,
        action_type: 'PAUSE', entity_type: 'ad', entity_external_id: ad.ad_external_id, entity_name: ad.ad_name,
        data_snapshot: { cpa, cpa_target: config.cpa_target, spend, conversions }
      });
    }

    // Gasto sem nenhuma conversao rastreada
    if (spend >= config.min_spend && conversions === 0 && revenue === 0) {
      decisions.push({
        rule_id: 'AD03', type: 'ZERO_CONVERSION_AD', severity: 7,
        title: `R$${spend.toFixed(2)} gastos — ZERO conversoes — "${ad.ad_name}"`,
        description: `Este anuncio gastou R$${spend.toFixed(2)} sem gerar nenhuma venda rastreada via UTM.`,
        recommendation: `Anuncio sem conversoes rastreadas. Aguardando sua confirmacao via WhatsApp para pausar. Verifique se utm_content esta configurado corretamente.`,
        action_type: 'PAUSE', entity_type: 'ad', entity_external_id: ad.ad_external_id, entity_name: ad.ad_name,
        data_snapshot: { spend, conversions: 0, ad_external_id: ad.ad_external_id }
      });
    }

    // Anuncio vencedor — ROAS excelente com atribuicao direta
    if (roas > config.roas_target * 2 && conversions >= 2 && spend >= config.min_spend) {
      decisions.push({
        rule_id: 'AD04', type: 'WINNING_AD', severity: 1,
        title: `🏆 Anuncio vencedor — "${ad.ad_name}" — ROAS ${roas.toFixed(2)}x`,
        description: `Este anuncio gerou ${conversions} vendas com ROAS de ${roas.toFixed(2)}x. Criativo altamente eficiente.`,
        recommendation: `Duplique este anuncio em novos conjuntos. Teste variantes do mesmo criativo. Aumente o budget do conjunto em 30%.`,
        action_type: 'SCALE_INSIGHT',
        data_snapshot: { roas, cpa, conversions, revenue, spend, ad_external_id: ad.ad_external_id }
      });
    }
  }

  return decisions;
};

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL — EXECUTA OS 3 NIVEIS E APLICA ACOES
// ═══════════════════════════════════════════════════════════════════════════

const runDecisionEngine = async (userId) => {
  console.log(`[Decision Engine] Iniciando avaliacao completa (3 niveis) para usuario ${userId}`);

  const config = await getUserConfig(userId);
  const allDecisions = [];

  // ── NIVEL 1: Campanhas ───────────────────────────────────────────────────
  const campaigns = await calculateByCampaign(userId, 1);
  for (const campaign of campaigns) {
    const history7d = await getCampaignHistory7d(userId, campaign.external_id);
    const decisions = evaluateCampaign(campaign, history7d, config);

    for (const decision of decisions) {
      const result = await query(`
        INSERT INTO decisions
          (user_id, campaign_id, type, severity, title, description, recommendation, action_type, data_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [userId, campaign.campaign_id, decision.type, decision.severity,
          decision.title, decision.description, decision.recommendation,
          decision.action_type, JSON.stringify(decision.data_snapshot)]);

      const decisionId = result.rows[0]?.id;

      if (decisionId && decision.entity_external_id) {
        if (decision.action_type === 'SCALE_BUDGET') {
          // Escala e segura — executa automaticamente sem precisar de aprovacao
          await executeMetaAction(userId, decisionId, {
            type:       'SCALE_BUDGET',
            entityType: decision.entity_type,
            entityId:   decision.entity_external_id,
            entityName: decision.entity_name,
            newBudget:  decision.new_budget,
            oldValue:   { budget: decision.old_budget },
            newValue:   { budget: decision.new_budget },
          });
        } else if (decision.action_type === 'PAUSE') {
          // PAUSA *nunca* e automatica — envia WhatsApp e aguarda SIM do usuario
          await createPendingAction(userId, decisionId, decision);
        }
      }

      allDecisions.push({ ...decision, campaign_name: campaign.campaign_name });
      console.log(`[Engine L1] ${decision.rule_id} — ${decision.title}`);
    }
  }

  // ── NIVEL 2: Conjuntos ───────────────────────────────────────────────────
  const adSetDecisions = await evaluateAdSets(userId, config);
  for (const decision of adSetDecisions) {
    const result = await query(`
      INSERT INTO decisions
        (user_id, type, severity, title, description, recommendation, action_type, data_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [userId, decision.type, decision.severity, decision.title,
        decision.description, decision.recommendation,
        decision.action_type, JSON.stringify(decision.data_snapshot)]);

    const decisionId = result.rows[0]?.id;

    if (decisionId && decision.entity_external_id) {
      if (decision.action_type === 'SCALE_BUDGET') {
        await executeMetaAction(userId, decisionId, {
          type:       'SCALE_BUDGET',
          entityType: decision.entity_type,
          entityId:   decision.entity_external_id,
          entityName: decision.entity_name,
          newBudget:  decision.new_budget,
          oldValue:   {},
          newValue:   { budget: decision.new_budget },
        });
      } else if (decision.action_type === 'PAUSE') {
        await createPendingAction(userId, decisionId, decision);
      }
    }

    allDecisions.push(decision);
    console.log(`[Engine L2] ${decision.rule_id} — ${decision.title}`);
  }

  // ── NIVEL 3: Anuncios Individuais ────────────────────────────────────────
  const adDecisions = await evaluateAds(userId, config);
  for (const decision of adDecisions) {
    const result = await query(`
      INSERT INTO decisions
        (user_id, type, severity, title, description, recommendation, action_type, data_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [userId, decision.type, decision.severity, decision.title,
        decision.description, decision.recommendation,
        decision.action_type, JSON.stringify(decision.data_snapshot)]);

    const decisionId = result.rows[0]?.id;

    if (decisionId && decision.entity_external_id && decision.action_type === 'PAUSE') {
      // Nivel 3 (anuncios): PAUSA tambem requer confirmacao via WhatsApp
      await createPendingAction(userId, decisionId, decision);
    }

    allDecisions.push(decision);
    console.log(`[Engine L3] ${decision.rule_id} — ${decision.title}`);
  }

  const criticalDecisions = allDecisions.filter(d => d.severity >= 7);
  console.log(`[Decision Engine] ${allDecisions.length} decisoes geradas (${criticalDecisions.length} criticas)`);
  return { all: allDecisions, critical: criticalDecisions };
};

module.exports = { runDecisionEngine, evaluateCampaign, getUserConfig };
