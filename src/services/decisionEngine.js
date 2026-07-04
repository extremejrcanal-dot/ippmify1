const { query } = require('../config/database');
const { calculateByCampaign } = require('./metricsEngine');

// ─── MOTOR DE DECISAO DO IPPMIFY ───────────────────────────────────────────
// Avalia 12 regras e gera recomendacoes acionaveis automaticamente

const getUserConfig = async (userId) => {
  const result = await query(
    'SELECT cpa_target, roas_target, roas_breakeven FROM users WHERE id = $1',
    [userId]
  );
  const u = result.rows[0] || {};
  return {
    cpa_target:     parseFloat(u.cpa_target || 50),
    roas_target:    parseFloat(u.roas_target || 2),
    roas_breakeven: parseFloat(u.roas_breakeven || 1),
    min_spend:      50,
    ctr_drop_pct:   0.30,
    conv_drop_pct:  0.50,
    cpm_spike_pct:  1.0,
  };
};

const getCampaignHistory7d = async (userId, campaignExternalId) => {
  const result = await query(`
    SELECT
      am.date,
      COALESCE(SUM(am.spend), 0) AS spend,
      COALESCE(SUM(am.impressions), 0) AS impressions,
      COALESCE(SUM(am.clicks), 0) AS clicks,
      CASE WHEN SUM(am.impressions) > 0
        THEN SUM(am.spend) / SUM(am.impressions) * 1000
        ELSE 0 END AS cpm,
      CASE WHEN SUM(am.impressions) > 0
        THEN SUM(am.clicks)::float / SUM(am.impressions) * 100
        ELSE 0 END AS ctr
    FROM ad_metrics am
    JOIN campaigns c ON c.id = am.campaign_id
    WHERE c.user_id = $1
      AND c.external_id = $2
      AND am.date >= CURRENT_DATE - INTERVAL '7 days'
      AND am.date < CURRENT_DATE
    GROUP BY am.date
    ORDER BY am.date DESC
  `, [userId, campaignExternalId]);

  return result.rows;
};

// Tenta buscar historico de vendas — tabela sales pode nao existir
const getSalesHistory7d = async (userId, campaignExternalId) => {
  try {
    const result = await query(`
      SELECT
        DATE(s.sale_date) AS date,
        COALESCE(SUM(s.net_revenue), 0) AS revenue,
        COUNT(s.id) AS conversions,
        CASE WHEN SUM(am.spend) > 0
          THEN SUM(s.net_revenue) / SUM(am.spend)
          ELSE 0 END AS roas
      FROM ad_metrics am
      JOIN campaigns c ON c.id = am.campaign_id
      LEFT JOIN sales s
        ON s.utm_campaign = c.external_id
        AND s.status = 'approved'
        AND s.user_id = $1
        AND DATE(s.sale_date) = am.date
      WHERE c.user_id = $1
        AND c.external_id = $2
        AND am.date >= CURRENT_DATE - INTERVAL '7 days'
        AND am.date < CURRENT_DATE
      GROUP BY am.date
      ORDER BY am.date DESC
    `, [userId, campaignExternalId]);
    return result.rows;
  } catch (_) {
    return [];
  }
};

// ─── AVALIACAO DAS 12 REGRAS ───────────────────────────────────────────────
const evaluateCampaign = (campaign, history7d, salesHistory7d, config) => {
  const decisions = [];
  const c = campaign;

  const avgCtr7d  = history7d.length > 0 ? history7d.reduce((s, r) => s + parseFloat(r.ctr || 0), 0) / history7d.length : c.ctr;
  const avgCpm7d  = history7d.length > 0 ? history7d.reduce((s, r) => s + parseFloat(r.cpm || 0), 0) / history7d.length : c.cpm;
  const avgRoas7d = salesHistory7d.length > 0 ? salesHistory7d.reduce((s, r) => s + parseFloat(r.roas || 0), 0) / salesHistory7d.length : c.roas;
  const avgConv7d = salesHistory7d.length > 0 ? salesHistory7d.reduce((s, r) => s + parseInt(r.conversions || 0), 0) / salesHistory7d.length : 1;
  const budgetUtil = c.daily_budget > 0 ? c.spend / c.daily_budget : 1;

  // R01: CPA Critico (2x acima do target)
  if (c.cpa > config.cpa_target * 2 && c.spend >= config.min_spend) {
    decisions.push({
      rule_id: 'R01', type: 'HIGH_CPA', severity: 9,
      title: `CPA R$${c.cpa.toFixed(2)} — ${(c.cpa / config.cpa_target).toFixed(1)}x acima do target`,
      description: `A campanha "${c.campaign_name}" gastou R$${c.spend.toFixed(2)} com CPA de R$${c.cpa.toFixed(2)}. Target: R$${config.cpa_target.toFixed(2)}.`,
      recommendation: `Pause imediatamente. Revise publico-alvo e criativos. Teste nova angulacao da oferta antes de reativar.`,
      action_type: 'PAUSE',
      data_snapshot: { cpa: c.cpa, cpa_target: config.cpa_target, spend: c.spend }
    });
  } else if (c.cpa > config.cpa_target * 1.5 && c.spend >= config.min_spend) {
    decisions.push({
      rule_id: 'R02', type: 'HIGH_CPA', severity: 6,
      title: `CPA R$${c.cpa.toFixed(2)} — acima do target`,
      description: `CPA ${(c.cpa / config.cpa_target).toFixed(1)}x acima do target de R$${config.cpa_target.toFixed(2)}.`,
      recommendation: `Revise criativos e publico. Teste novas segmentacoes antes de pausar. Verifique se a pagina de vendas esta convertendo.`,
      action_type: 'REVIEW',
      data_snapshot: { cpa: c.cpa, cpa_target: config.cpa_target }
    });
  }

  // R03: ROAS abaixo do breakeven
  if (c.roas < config.roas_breakeven && c.spend >= config.min_spend && c.conversions > 0) {
    decisions.push({
      rule_id: 'R03', type: 'LOW_ROAS', severity: 9,
      title: `ROAS ${c.roas.toFixed(2)}x — Campanha dando PREJUIZO`,
      description: `Para cada R$1 investido, retorna apenas R$${c.roas.toFixed(2)}. Prejuizo real de R$${Math.abs(c.profit || 0).toFixed(2)}.`,
      recommendation: `Pause imediatamente. Nao reative sem revisao completa da oferta, pagina de vendas e publico.`,
      action_type: 'PAUSE',
      data_snapshot: { roas: c.roas, roas_breakeven: config.roas_breakeven, profit: c.profit }
    });
  }

  // R04: ROAS caindo vs historico
  if (avgRoas7d > 0 && c.roas < avgRoas7d * 0.8 && c.spend >= config.min_spend) {
    const dropPct = ((avgRoas7d - c.roas) / avgRoas7d * 100).toFixed(0);
    decisions.push({
      rule_id: 'R04', type: 'ROAS_DROPPING', severity: 5,
      title: `ROAS caiu ${dropPct}% vs. media dos ultimos 7 dias`,
      description: `ROAS atual: ${c.roas.toFixed(2)}x. Media 7 dias: ${avgRoas7d.toFixed(2)}x. Queda de ${dropPct}%.`,
      recommendation: `Verifique saturacao de publico, fadiga de criativo ou aumento de concorrencia. Teste novos anuncios.`,
      action_type: 'REVIEW',
      data_snapshot: { roas_today: c.roas, roas_7d_avg: avgRoas7d, drop_pct: dropPct }
    });
  }

  // R05: Oportunidade de escala
  if (c.roas > config.roas_target * 1.3 && budgetUtil < 0.7 && c.spend >= config.min_spend) {
    const suggestedBudget = (c.daily_budget * 1.25).toFixed(2);
    decisions.push({
      rule_id: 'R05', type: 'SCALE_OPPORTUNITY', severity: 3,
      title: `ROAS ${c.roas.toFixed(2)}x — Oportunidade de escala`,
      description: `ROAS ${c.roas.toFixed(2)}x (target: ${config.roas_target}x) com apenas ${(budgetUtil * 100).toFixed(0)}% do orcamento usado.`,
      recommendation: `Aumente o orcamento diario em 25%: de R$${c.daily_budget.toFixed(2)} para R$${suggestedBudget}. Aguarde 48h e monitore o CPA.`,
      action_type: 'SCALE_BUDGET',
      data_snapshot: { roas: c.roas, budget: c.daily_budget, suggested_budget: parseFloat(suggestedBudget) }
    });
  }

  // R06: Fadiga de criativo (CTR caindo)
  if (avgCtr7d > 0 && c.ctr < avgCtr7d * (1 - config.ctr_drop_pct) && c.impressions > 5000) {
    const dropPct = ((avgCtr7d - c.ctr) / avgCtr7d * 100).toFixed(0);
    decisions.push({
      rule_id: 'R06', type: 'CREATIVE_FATIGUE', severity: 5,
      title: `CTR caiu ${dropPct}% — Fadiga de criativo detectada`,
      description: `CTR atual: ${c.ctr.toFixed(2)}%. Media 7 dias: ${avgCtr7d.toFixed(2)}%. O publico ja esta ignorando seus anuncios.`,
      recommendation: `Crie 3-5 novos criativos com angulos diferentes. Teste novos hooks nos primeiros 3 segundos do video.`,
      action_type: 'REVIEW',
      data_snapshot: { ctr_today: c.ctr, ctr_7d_avg: avgCtr7d, drop_pct: dropPct }
    });
  }

  // R07: Queda abrupta de conversoes
  if (avgConv7d > 2 && c.conversions < avgConv7d * config.conv_drop_pct && c.spend >= config.min_spend) {
    decisions.push({
      rule_id: 'R07', type: 'CONVERSION_DROP', severity: 8,
      title: `Conversoes caindo ${((1 - c.conversions / avgConv7d) * 100).toFixed(0)}% vs. media 7 dias`,
      description: `Conversoes hoje: ${c.conversions}. Media 7 dias: ${avgConv7d.toFixed(1)}. Problema serio no funil.`,
      recommendation: `Verifique: (1) Pixel funcionando? (2) Pagina de vendas carregando? (3) Checkout com erro? (4) Oferta ainda ativa?`,
      action_type: 'ALERT',
      data_snapshot: { conversions_today: c.conversions, conversions_7d_avg: avgConv7d }
    });
  }

  // R08: CPM explosivo
  if (avgCpm7d > 0 && c.cpm > avgCpm7d * 2 && c.impressions > 1000) {
    const spikePct = ((c.cpm / avgCpm7d - 1) * 100).toFixed(0);
    decisions.push({
      rule_id: 'R08', type: 'CPM_SPIKE', severity: 5,
      title: `CPM ${spikePct}% acima da media — Leilao concorrido`,
      description: `CPM atual: R$${c.cpm.toFixed(2)}. Media 7 dias: R$${avgCpm7d.toFixed(2)}. Custo por impressao disparou.`,
      recommendation: `Amplie o publico ou teste outros posicionamentos (Reels, Stories). Considere Advantage+ Audience.`,
      action_type: 'REVIEW',
      data_snapshot: { cpm_today: c.cpm, cpm_7d_avg: avgCpm7d, spike_pct: spikePct }
    });
  }

  // R09: Zero vendas com gasto significativo
  if (c.spend >= config.min_spend && c.conversions === 0) {
    decisions.push({
      rule_id: 'R09', type: 'ZERO_SALES', severity: 8,
      title: `R$${c.spend.toFixed(2)} gastos — ZERO vendas`,
      description: `A campanha gastou R$${c.spend.toFixed(2)} sem gerar nenhuma venda. Taxa de conversao: 0%.`,
      recommendation: `Pause imediatamente. Audit: (1) Pagina de vendas ok? (2) Oferta correta? (3) Publico alinhado? (4) Criativo gerando interesse?`,
      action_type: 'PAUSE',
      data_snapshot: { spend: c.spend, conversions: 0 }
    });
  }

  // R10: Anomalia de gasto — gastando rapido com ROAS baixo
  if (budgetUtil > 0.8 && c.roas < config.roas_target && c.spend >= config.min_spend) {
    decisions.push({
      rule_id: 'R10', type: 'BUDGET_ANOMALY', severity: 7,
      title: `${(budgetUtil * 100).toFixed(0)}% do orcamento usado com ROAS abaixo do target`,
      description: `Ja usou ${(budgetUtil * 100).toFixed(0)}% do orcamento diario com ROAS de apenas ${c.roas.toFixed(2)}x.`,
      recommendation: `Considere reduzir o orcamento ou pausar para hoje. Revise a campanha antes de amanhecer.`,
      action_type: 'REVIEW',
      data_snapshot: { budget_utilization: budgetUtil, roas: c.roas, spend: c.spend }
    });
  }

  return decisions;
};

// ─── COOLDOWN POR SEVERIDADE ───────────────────────────────────────────────
const getCooldownSec = (severity) => {
  if (severity >= 9) return 2 * 60 * 60;   // 2h
  if (severity >= 7) return 4 * 60 * 60;   // 4h
  return 24 * 60 * 60;                      // 24h
};

// FIXED: usa INTERVAL '1 second' * $4 em vez de ($4 || ' seconds')::INTERVAL
const isDuplicateDecision = async (userId, campaignId, type, severity) => {
  const cooldownSec = getCooldownSec(severity);
  const result = await query(`
    SELECT id FROM decisions
    WHERE user_id     = $1
      AND campaign_id = $2
      AND type        = $3
      AND triggered_at >= NOW() - INTERVAL '1 second' * $4
    LIMIT 1
  `, [userId, campaignId, type, cooldownSec]);
  return result.rows.length > 0;
};

// ─── EXECUTAR O MOTOR PARA UM USUARIO ─────────────────────────────────────
const runDecisionEngine = async (userId) => {
  console.log(`[Decision Engine] Iniciando avaliacao para usuario ${userId}`);
  const config = await getUserConfig(userId);
  const campaigns = await calculateByCampaign(userId, 7);

  const allDecisions = [];

  for (const campaign of campaigns) {
    if (campaign.spend < config.min_spend * 0.1) continue;

    const history7d     = await getCampaignHistory7d(userId, campaign.external_id);
    const salesHistory7d = await getSalesHistory7d(userId, campaign.external_id);
    const decisions     = evaluateCampaign(campaign, history7d, salesHistory7d, config);

    for (const decision of decisions) {
      const isDup = await isDuplicateDecision(userId, campaign.campaign_id, decision.type, decision.severity);
      if (isDup) {
        console.log(`[Decision Engine] Regra ${decision.rule_id} em cooldown — pulando`);
        continue;
      }

      const inserted = await query(`
        INSERT INTO decisions
          (user_id, campaign_id, type, severity, title, description,
           recommendation, action_type, data_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [
        userId, campaign.campaign_id,
        decision.type, decision.severity,
        decision.title, decision.description,
        decision.recommendation, decision.action_type,
        JSON.stringify(decision.data_snapshot),
      ]);

      const dbId = inserted.rows[0]?.id;
      allDecisions.push({ ...decision, campaign_name: campaign.campaign_name, db_id: dbId });
      console.log(`[Decision Engine] Regra ${decision.rule_id} — ${decision.title}`);
    }
  }

  const criticalDecisions = allDecisions.filter(d => d.severity >= 7);
  console.log(`[Decision Engine] ${allDecisions.length} decisoes, ${criticalDecisions.length} criticas`);
  return { all: allDecisions, critical: criticalDecisions };
};

module.exports = { runDecisionEngine, evaluateCampaign, getUserConfig };
