const { query } = require('../config/database');
const { calculateByCampaign } = require('./metricsEngine');

// ─── MOTOR DE DECISAO IPPMIFY — v2 com rigor estatístico ──────────────────────
// REGRA DE OURO: nunca recomendar pausar/matar sem amostra suficiente.
// Um "aguardar" honesto vale mais que um "pause" precipitado.

// ─── UTILIDADES ESTATÍSTICAS ─────────────────────────────────────────────────

// Vendas esperadas dado o gasto e o CPA-alvo
const calcVendasEsperadas = (spend, cpaTarget) => {
  if (!cpaTarget || cpaTarget <= 0) return 0;
  return spend / cpaTarget;
};

// Suficiência de amostra: 'suficiente' | 'parcial' | 'insuficiente'
// threshold: multiplicador sobre o CPA-alvo (padrão 2×)
const nivelSuficiencia = (spend, cpaTarget, threshold = 2) => {
  if (!cpaTarget || cpaTarget <= 0) return 'insuficiente';
  const ratio = spend / cpaTarget;
  if (ratio >= threshold)        return 'suficiente';  // ≥ 2× CPA-target
  if (ratio >= threshold * 0.5)  return 'parcial';     // ≥ 1× CPA-target
  return 'insuficiente';                               // < 1× CPA-target
};

// Confiança da recomendação baseada em amostra + conversões
const calcConfianca = (spend, cpaTarget, conversoes = 0) => {
  const suf = nivelSuficiencia(spend, cpaTarget);
  if (suf === 'suficiente' && conversoes >= 3) return 'alta';
  if (suf === 'suficiente' || (suf === 'parcial' && conversoes >= 1)) return 'media';
  return 'baixa';
};

// Confiança de tendência baseada em dias de histórico
const confHistorico = (dias) => {
  if (dias >= 5) return 'alta';
  if (dias >= 3) return 'media';
  return 'baixa';
};

// Formata impacto financeiro honesto
const fmtImpacto = (valor, base) => {
  if (!valor || isNaN(valor)) return null;
  return `R$${Math.abs(valor).toFixed(2)} (${base})`;
};

// ─── CONFIGURAÇÃO DO USUÁRIO ─────────────────────────────────────────────────
const getUserConfig = async (userId) => {
  const result = await query(
    'SELECT cpa_target, roas_target, roas_breakeven FROM users WHERE id = $1',
    [userId]
  );
  const u = result.rows[0] || {};
  return {
    cpa_target:     parseFloat(u.cpa_target     || 50),
    roas_target:    parseFloat(u.roas_target    || 2),
    roas_breakeven: parseFloat(u.roas_breakeven || 1),
    min_spend:      50,
    ctr_drop_pct:   0.30,
    conv_drop_pct:  0.50,
  };
};

// ─── HISTÓRICO 7 DIAS ────────────────────────────────────────────────────────
const getCampaignHistory7d = async (userId, campaignExternalId) => {
  const result = await query(`
    SELECT
      am.date,
      COALESCE(SUM(am.spend), 0) AS spend,
      COALESCE(SUM(am.impressions), 0) AS impressions,
      COALESCE(SUM(am.clicks), 0) AS clicks,
      CASE WHEN SUM(am.impressions) > 0
        THEN SUM(am.spend) / SUM(am.impressions) * 1000 ELSE 0 END AS cpm,
      CASE WHEN SUM(am.impressions) > 0
        THEN SUM(am.clicks)::float / SUM(am.impressions) * 100 ELSE 0 END AS ctr
    FROM ad_metrics am
    JOIN campaigns c ON c.id = am.campaign_id
    WHERE c.user_id = $1
      AND c.external_id = $2
      AND am.date >= CURRENT_DATE - INTERVAL '7 days'
      AND am.date < CURRENT_DATE
    GROUP BY am.date ORDER BY am.date DESC
  `, [userId, campaignExternalId]);
  return result.rows;
};

const getSalesHistory7d = async (userId, campaignExternalId) => {
  try {
    const result = await query(`
      SELECT
        DATE(s.sale_date) AS date,
        COALESCE(SUM(s.net_revenue), 0) AS revenue,
        COUNT(s.id) AS conversions,
        CASE WHEN SUM(am.spend) > 0
          THEN SUM(s.net_revenue) / SUM(am.spend) ELSE 0 END AS roas
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
      GROUP BY am.date ORDER BY am.date DESC
    `, [userId, campaignExternalId]);
    return result.rows;
  } catch (_) { return []; }
};

// ─── AVALIAÇÃO COM RIGOR ESTATÍSTICO ─────────────────────────────────────────
const evaluateCampaign = (campaign, history7d, salesHistory7d, config) => {
  const decisions = [];
  const c   = campaign;
  const cpa = config.cpa_target;
  const rBE = config.roas_breakeven;
  const rT  = config.roas_target;

  const avgCtr7d  = history7d.length > 0
    ? history7d.reduce((s, r) => s + parseFloat(r.ctr || 0), 0) / history7d.length : c.ctr;
  const avgCpm7d  = history7d.length > 0
    ? history7d.reduce((s, r) => s + parseFloat(r.cpm || 0), 0) / history7d.length : c.cpm;
  const avgRoas7d = salesHistory7d.length > 0
    ? salesHistory7d.reduce((s, r) => s + parseFloat(r.roas || 0), 0) / salesHistory7d.length : c.roas;
  const avgConv7d = salesHistory7d.length > 0
    ? salesHistory7d.reduce((s, r) => s + parseInt(r.conversions || 0), 0) / salesHistory7d.length : 1;
  const diasComHistorico = history7d.filter(r => parseFloat(r.spend) > 0).length;
  const budgetUtil = c.daily_budget > 0 ? c.spend / c.daily_budget : 1;
  const vendasEsp  = calcVendasEsperadas(c.spend, cpa);

  // ── R01 & R02: CPA Alto ────────────────────────────────────────────────────
  // PROIBIDO recomendar pausa quando gasto < 1× CPA-alvo (amostra insuficiente)
  if (c.cpa > cpa * 1.5 && c.conversions > 0) {
    const suf  = nivelSuficiencia(c.spend, cpa);
    const conf = calcConfianca(c.spend, cpa, c.conversions);
    const mult = (c.cpa / cpa).toFixed(1);

    if (suf === 'insuficiente') {
      // Silenciar: sem dado para julgar CPA
    } else if (c.cpa > cpa * 2) {
      // R01: CPA crítico
      const podeAgir  = suf === 'suficiente';
      const impacto   = fmtImpacto((c.cpa - cpa) * c.conversions, 'excesso no período');
      decisions.push({
        rule_id: 'R01', type: 'HIGH_CPA',
        severity: podeAgir ? 8 : 5,
        confianca: conf,
        title: `CPA R$${c.cpa.toFixed(2)} — ${mult}× acima do target`,
        description: `Gasto: R$${c.spend.toFixed(2)} | Conversões: ${c.conversions} | Esperado: ${vendasEsp.toFixed(1)} vendas ao target.`,
        recommendation: podeAgir
          ? `Pause ou corte budget 50%. CPA ${mult}× acima com amostra suficiente (R$${c.spend.toFixed(0)} gasto). Revise criativo e público antes de reativar.`
          : `Aguarde atingir R$${(cpa * 2).toFixed(0)} de gasto antes de pausar. CPA pode estar alto por amostra pequena — ${c.conversions} conversão(ões) ainda é pouco para decidir.`,
        action_type: podeAgir ? 'PAUSE' : 'MONITOR',
        o_que_muda: `Se CPA cair abaixo de R$${(cpa * 1.5).toFixed(2)} → manter. Se CPA cair abaixo de R$${cpa.toFixed(2)} → ótimo. Se CPA continuar > R$${(cpa * 2).toFixed(2)} após R$${(cpa * 2).toFixed(0)} de gasto → pausar.`,
        quando_revisar: podeAgir ? 'Agora' : `Ao atingir R$${(cpa * 2).toFixed(0)} de gasto total`,
        impacto_financeiro: impacto || `Excesso de R$${((c.cpa - cpa) * c.conversions).toFixed(2)} no período`,
        display_text: podeAgir
          ? `🔴 CPA R$${c.cpa.toFixed(2)} (${mult}× o target de R$${cpa.toFixed(2)}) com dado suficiente. Pause e revise criativo e público.`
          : `⏳ CPA R$${c.cpa.toFixed(2)} — amostra parcial (${c.spend.toFixed(0)}/R$${(cpa*2).toFixed(0)}). Aguarde mais dados antes de agir.`,
        data_snapshot: { cpa: c.cpa, cpa_target: cpa, spend: c.spend, conversions: c.conversions, vendas_esperadas: vendasEsp, suficiencia: suf }
      });
    } else {
      // R02: CPA elevado (1.5× a 2×)
      decisions.push({
        rule_id: 'R02', type: 'HIGH_CPA',
        severity: conf === 'alta' ? 5 : 3,
        confianca: conf,
        title: `CPA R$${c.cpa.toFixed(2)} — ${mult}× acima do target`,
        description: `Acima do alvo mas ainda dentro da margem de aprendizado. Gasto: R$${c.spend.toFixed(2)} | Conv: ${c.conversions}.`,
        recommendation: `Monitore por 24-48h. Teste 1-2 criativos novos se CTR < 2%. Só pause se CPA ultrapassar R$${(cpa * 2).toFixed(2)} com amostra suficiente.`,
        action_type: 'MONITOR',
        o_que_muda: `CPA acima de R$${(cpa * 2).toFixed(2)} com R$${(cpa * 2).toFixed(0)} gasto → escalar para alerta. CPA abaixo de R$${cpa.toFixed(2)} → tudo certo.`,
        quando_revisar: '24-48h',
        impacto_financeiro: `Excesso de R$${((c.cpa - cpa) * c.conversions).toFixed(2)} no período vs. meta`,
        display_text: `🟡 CPA R$${c.cpa.toFixed(2)} (${mult}× target) — monitorando. Só aja se ultrapassar R$${(cpa*2).toFixed(2)} com amostra completa.`,
        data_snapshot: { cpa: c.cpa, cpa_target: cpa, spend: c.spend, conversions: c.conversions, suficiencia: suf }
      });
    }
  }

  // ── R03: ROAS abaixo do breakeven (prejuízo real) ─────────────────────────
  // Só faz sentido quando há conversões — sem conversão, é R09
  if (c.roas < rBE && c.roas > 0 && c.conversions > 0 && c.spend >= config.min_spend) {
    const suf     = nivelSuficiencia(c.spend, cpa);
    const conf    = calcConfianca(c.spend, cpa, c.conversions);
    const prejuiz = Math.abs(c.profit || (c.revenue - c.spend));
    const podeAgir = suf === 'suficiente' || c.conversions >= 3;
    decisions.push({
      rule_id: 'R03', type: 'LOW_ROAS',
      severity: podeAgir ? 9 : 6,
      confianca: conf,
      title: `ROAS ${c.roas.toFixed(2)}× — Campanha operando no prejuízo`,
      description: `Para cada R$1 investido, retorna R$${c.roas.toFixed(2)}. Prejuízo no período: R$${prejuiz.toFixed(2)}.`,
      recommendation: podeAgir
        ? `Pause imediatamente. ROAS ${c.roas.toFixed(2)}× abaixo do breakeven (${rBE}×) com ${c.conversions} conversão(ões). Cada dia adicional gera mais prejuízo.`
        : `Atenção: ROAS abaixo do breakeven com amostra ainda crescendo. Monitore por 48h. Pause se ROAS permanecer abaixo de ${rBE}× após R$${(cpa * 2).toFixed(0)} de gasto.`,
      action_type: podeAgir ? 'PAUSE' : 'MONITOR',
      o_que_muda: `ROAS acima de ${rBE}× → breakeven atingido. ROAS acima de ${rT}× → escala. Mais conversões com ROAS maior → revisar para cima.`,
      quando_revisar: podeAgir ? 'Agora' : '48h',
      impacto_financeiro: `R$${prejuiz.toFixed(2)} de prejuízo no período (${Math.round((c.spend - c.revenue) / Math.max(1, diasComHistorico))} R$/dia)`,
      display_text: podeAgir
        ? `🔴 ROAS ${c.roas.toFixed(2)}× — abaixo do breakeven (${rBE}×). Prejuízo: R$${prejuiz.toFixed(2)}. Pause agora.`
        : `🟡 ROAS ${c.roas.toFixed(2)}× abaixo do breakeven com amostra parcial. Monitore 48h antes de pausar.`,
      data_snapshot: { roas: c.roas, roas_breakeven: rBE, spend: c.spend, revenue: c.revenue, prejuizo: prejuiz, conversions: c.conversions, suficiencia: suf }
    });
  }

  // ── R04: ROAS caindo em relação ao histórico ───────────────────────────────
  if (avgRoas7d > 0 && c.roas < avgRoas7d * 0.75 && diasComHistorico >= 3 && c.spend >= config.min_spend) {
    const dropPct = ((avgRoas7d - c.roas) / avgRoas7d * 100).toFixed(0);
    const conf    = confHistorico(diasComHistorico);
    decisions.push({
      rule_id: 'R04', type: 'ROAS_DROPPING',
      severity: conf === 'alta' ? 6 : 4,
      confianca: conf,
      title: `ROAS caiu ${dropPct}% vs. média dos últimos ${diasComHistorico} dias`,
      description: `ROAS hoje: ${c.roas.toFixed(2)}×. Média ${diasComHistorico}d: ${avgRoas7d.toFixed(2)}×. Queda de ${dropPct}%.`,
      recommendation: `Investigar causa: (1) saturação de público? (2) criativo cansado (veja CTR)? (3) sazonalidade? Teste 2-3 criativos novos antes de mudar budget.`,
      action_type: 'REVIEW',
      o_que_muda: `ROAS voltar acima de ${(avgRoas7d * 0.9).toFixed(2)}× → ruído normal. ROAS cair abaixo de ${rBE}× → escalar para R03.`,
      quando_revisar: '48-72h',
      impacto_financeiro: `Queda de receita estimada: R$${((avgRoas7d - c.roas) * c.spend).toFixed(2)} vs. performance anterior`,
      display_text: `📉 ROAS ${c.roas.toFixed(2)}× (queda de ${dropPct}% vs. média de ${diasComHistorico} dias). Investigue antes de mudar budget.`,
      data_snapshot: { roas_hoje: c.roas, roas_7d: avgRoas7d, queda_pct: dropPct, dias_historico: diasComHistorico }
    });
  }

  // ── R05: Oportunidade de escala ────────────────────────────────────────────
  // Só escale com amostra suficiente e conversões reais
  if (c.roas > rT * 1.3 && budgetUtil < 0.75 && c.spend >= config.min_spend && c.conversions >= 3) {
    const novoOrc  = (c.daily_budget * 1.25).toFixed(2);
    const conf     = calcConfianca(c.spend, cpa, c.conversions);
    const recPotencial = (c.revenue * 0.25).toFixed(2); // +25% budget → +25% receita estimada
    decisions.push({
      rule_id: 'R05', type: 'SCALE_OPPORTUNITY',
      severity: 3,
      confianca: conf,
      title: `ROAS ${c.roas.toFixed(2)}× — Oportunidade de escala`,
      description: `ROAS ${c.roas.toFixed(2)}× (target: ${rT}×) com ${c.conversions} conversões e apenas ${(budgetUtil*100).toFixed(0)}% do orçamento usado.`,
      recommendation: `Aumente o orçamento diário em 20-25%: de R$${c.daily_budget.toFixed(2)} para R$${novoOrc}. Aguarde 48h e monitore se ROAS se mantém acima de ${rT}×.`,
      action_type: 'SCALE_BUDGET',
      o_que_muda: `ROAS cair abaixo de ${rT}× após escala → reverter. ROAS se manter → novo aumento de 20% após 48h.`,
      quando_revisar: '48h após o aumento',
      impacto_financeiro: `Receita adicional estimada: +R$${recPotencial} (+25% do orçamento). Conservador — mantenha ROAS acima de ${rT}×.`,
      display_text: `🚀 ROAS ${c.roas.toFixed(2)}× com ${c.conversions} conversões. Escale +20-25% o orçamento. Revise em 48h.`,
      data_snapshot: { roas: c.roas, roas_target: rT, budget_atual: c.daily_budget, budget_sugerido: parseFloat(novoOrc), conversions: c.conversions, budget_util: budgetUtil }
    });
  }

  // ── R06: Fadiga de criativo / CTR caindo ──────────────────────────────────
  if (avgCtr7d > 0 && c.ctr < avgCtr7d * (1 - config.ctr_drop_pct) && c.impressions > 5000 && diasComHistorico >= 3) {
    const dropPct = ((avgCtr7d - c.ctr) / avgCtr7d * 100).toFixed(0);
    const conf    = confHistorico(diasComHistorico);
    decisions.push({
      rule_id: 'R06', type: 'CREATIVE_FATIGUE',
      severity: conf === 'alta' ? 6 : 4,
      confianca: conf,
      title: `CTR caiu ${dropPct}% — Fadiga de criativo`,
      description: `CTR hoje: ${c.ctr.toFixed(2)}%. Média ${diasComHistorico}d: ${avgCtr7d.toFixed(2)}%. Queda de ${dropPct}% com ${c.impressions.toLocaleString('pt-BR')} impressões.`,
      recommendation: `Crie 3-5 anúncios novos com hooks diferentes nos primeiros 3s. Priorize Reels. Não altere orçamento — mude apenas os criativos.`,
      action_type: 'REVIEW',
      o_que_muda: `CTR voltar acima de ${(avgCtr7d * 0.85).toFixed(2)}% → recuperado. CTR continuar caindo e CPA subindo → escalar para High CPA.`,
      quando_revisar: '48-72h após novos criativos',
      impacto_financeiro: `Custo extra estimado por CTR baixo: R$${(c.cpm * (avgCtr7d - c.ctr) / 100 * c.impressions / 1000).toFixed(2)} em CPC adicional`,
      display_text: `🎨 CTR ${c.ctr.toFixed(2)}% (queda de ${dropPct}%). Lance criativos novos. Não mexa no orçamento — só no criativo.`,
      data_snapshot: { ctr_hoje: c.ctr, ctr_7d: avgCtr7d, queda_pct: dropPct, impressoes: c.impressions, dias_historico: diasComHistorico }
    });
  }

  // ── R06b: CTR absolutamente baixo (independente de histórico) ─────────────
  if (c.ctr < 0.5 && c.impressions > 8000 && avgCtr7d === 0) {
    decisions.push({
      rule_id: 'R06B', type: 'CREATIVE_FATIGUE',
      severity: 5,
      confianca: 'media',
      title: `CTR ${c.ctr.toFixed(2)}% — Criativo com baixa performance`,
      description: `CTR abaixo de 0,5% com ${c.impressions.toLocaleString('pt-BR')} impressões. Benchmark saudável: 1,5-4% no Feed, 3-9% em Reels.`,
      recommendation: `CTR muito abaixo dos benchmarks. Revise o hook dos primeiros 3s e o thumbnail. Teste Advantage+ Audience se ainda não usa.`,
      action_type: 'REVIEW',
      o_que_muda: 'CTR acima de 1% → normal. CTR acima de 2% → bom.',
      quando_revisar: '48h após novos criativos',
      impacto_financeiro: 'CTR baixo aumenta o CPC e dificulta a otimização do algoritmo',
      display_text: `🎨 CTR ${c.ctr.toFixed(2)}% — muito abaixo do benchmark (1,5%+). Troque o criativo antes de mais qualquer coisa.`,
      data_snapshot: { ctr: c.ctr, impressoes: c.impressions }
    });
  }

  // ── R07: Queda abrupta de conversões vs. histórico ────────────────────────
  if (avgConv7d >= 2 && c.conversions < avgConv7d * config.conv_drop_pct && c.spend >= config.min_spend && diasComHistorico >= 3) {
    const quedaPct = ((1 - c.conversions / avgConv7d) * 100).toFixed(0);
    const conf     = confHistorico(diasComHistorico);
    decisions.push({
      rule_id: 'R07', type: 'CONVERSION_DROP',
      severity: conf === 'alta' ? 8 : 5,
      confianca: conf,
      title: `Conversões caíram ${quedaPct}% vs. média dos últimos ${diasComHistorico} dias`,
      description: `Hoje: ${c.conversions} conversão(ões). Média ${diasComHistorico}d: ${avgConv7d.toFixed(1)}. Queda abrupta com gasto normal.`,
      recommendation: `Verifique em ordem: (1) Pixel ou CAPI funcionando? (2) Página de vendas carregando? (3) Checkout com erro? (4) Oferta ainda ativa? (5) Problema sazonal (fim de semana, feriado)?`,
      action_type: 'ALERT',
      o_que_muda: 'Conversões voltarem acima de 50% da média → ruído/sazonal. Pixel quebrado ou checkout com erro → técnico urgente.',
      quando_revisar: '4-6h (possível problema técnico)',
      impacto_financeiro: `Receita perdida estimada: R$${((avgConv7d - c.conversions) * (c.revenue / Math.max(c.conversions, 1))).toFixed(2)} vs. média`,
      display_text: `🔴 Conversões: ${c.conversions} hoje vs. média de ${avgConv7d.toFixed(0)} (queda de ${quedaPct}%). Verifique pixel, página e checkout imediatamente.`,
      data_snapshot: { conversoes_hoje: c.conversions, media_7d: avgConv7d, queda_pct: quedaPct, dias_historico: diasComHistorico }
    });
  }

  // ── R08: CPM explodindo ────────────────────────────────────────────────────
  if (avgCpm7d > 0 && c.cpm > avgCpm7d * 2 && c.impressions > 1000 && diasComHistorico >= 3) {
    const spikePct = ((c.cpm / avgCpm7d - 1) * 100).toFixed(0);
    const conf     = confHistorico(diasComHistorico);
    decisions.push({
      rule_id: 'R08', type: 'CPM_SPIKE',
      severity: 5,
      confianca: conf,
      title: `CPM R$${c.cpm.toFixed(2)} — ${spikePct}% acima da média (leilão concorrido)`,
      description: `CPM hoje: R$${c.cpm.toFixed(2)}. Média ${diasComHistorico}d: R$${avgCpm7d.toFixed(2)}. Custo de impressão está alto.`,
      recommendation: `Amplie o público (Advantage+ Audience se não usa) ou teste outros posicionamentos: Reels, Stories. Evite audiências muito restritivas (< 500k).`,
      action_type: 'REVIEW',
      o_que_muda: `CPM abaixo de R$${(avgCpm7d * 1.3).toFixed(2)} → normalizado. CPM persistente → considerar nova campanha com público diferente.`,
      quando_revisar: '48-72h',
      impacto_financeiro: `Custo extra de leilão: R$${((c.cpm - avgCpm7d) * c.impressions / 1000).toFixed(2)} no período`,
      display_text: `💸 CPM R$${c.cpm.toFixed(2)} (+${spikePct}% vs. média). Amplie o público ou teste novos posicionamentos.`,
      data_snapshot: { cpm_hoje: c.cpm, cpm_7d: avgCpm7d, spike_pct: spikePct, impressoes: c.impressions }
    });
  }

  // ── R09: Zero vendas — escalonado por suficiência de amostra ───────────────
  // Esta é a regra mais importante a ser calibrada.
  // NUNCA disparar "Pause" com dados insuficientes.
  if (c.conversions === 0 && c.spend > 0) {
    const suf       = nivelSuficiencia(c.spend, cpa);
    const gastoPct  = (c.spend / (cpa * 2) * 100).toFixed(0);
    const falta     = Math.max(0, cpa * 2 - c.spend).toFixed(2);

    if (suf === 'insuficiente') {
      // Informativo apenas — matematicamente esperado ter 0 vendas
      // Só registrar se já tiver gasto significativo (mínimo de R$10)
      if (c.spend >= 10) {
        decisions.push({
          rule_id: 'R09', type: 'ZERO_SALES',
          severity: 2,
          confianca: 'baixa',
          title: `0 vendas — aguardando amostra (${gastoPct}% do limiar)`,
          description: `Gasto: R$${c.spend.toFixed(2)}. Vendas esperadas ao target: ${vendasEsp.toFixed(1)} (ainda abaixo de 1). Amostra insuficiente para qualquer conclusão.`,
          recommendation: `Nenhuma ação necessária agora. É matematicamente esperado ter 0 vendas com R$${c.spend.toFixed(0)} e CPA-alvo de R$${cpa.toFixed(0)}. Continue coletando dados até R$${(cpa * 2).toFixed(0)}.`,
          action_type: 'MONITOR',
          o_que_muda: `Atingir R$${(cpa).toFixed(0)} de gasto → reavalie. Atingir R$${(cpa * 2).toFixed(0)} sem venda → aí sim investigue.`,
          quando_revisar: `Ao gastar mais R$${falta} (total R$${(cpa * 2).toFixed(0)})`,
          impacto_financeiro: null,
          display_text: `⏳ 0 vendas com R$${c.spend.toFixed(2)} gasto — esperado. Faltam R$${falta} para ter amostra suficiente (R$${(cpa*2).toFixed(0)}). Não tome decisão agora.`,
          data_snapshot: { spend: c.spend, cpa_target: cpa, vendas_esperadas: vendasEsp, suficiencia: suf, gasto_pct: gastoPct }
        });
      }
    } else if (suf === 'parcial') {
      // Atenção — ainda sem dado conclusivo mas já vale monitorar
      decisions.push({
        rule_id: 'R09', type: 'ZERO_SALES',
        severity: 5,
        confianca: 'media',
        title: `0 vendas com R$${c.spend.toFixed(2)} gasto — monitorando`,
        description: `${gastoPct}% da amostra necessária. Esperado: ${vendasEsp.toFixed(1)} venda(s). Faltam R$${falta} para conclusão.`,
        recommendation: `Verifique se a página de vendas está carregando e o checkout funciona. Não pause ainda — espere atingir R$${(cpa * 2).toFixed(0)} de gasto. Limiar para ação: 0 vendas após R$${(cpa * 2).toFixed(0)}.`,
        action_type: 'MONITOR',
        o_que_muda: `Venda aparecer → tudo certo, monitore CPA. Chegar em R$${(cpa * 2).toFixed(0)} sem venda → investigate e possivelmente pause.`,
        quando_revisar: `Ao atingir R$${(cpa * 2).toFixed(0)} de gasto total (faltam R$${falta})`,
        impacto_financeiro: `Sem venda confirmada ainda. Risco: R$${falta} adicionais sem retorno`,
        display_text: `⚠️ 0 vendas com R$${c.spend.toFixed(0)} (${gastoPct}% do limiar). Verifique pixel e checkout. Só pause se chegar em R$${(cpa*2).toFixed(0)} sem venda.`,
        data_snapshot: { spend: c.spend, cpa_target: cpa, vendas_esperadas: vendasEsp, suficiencia: suf, falta_para_limiar: parseFloat(falta) }
      });
    } else {
      // suf === 'suficiente' — aqui SIM é um sinal real
      decisions.push({
        rule_id: 'R09', type: 'ZERO_SALES',
        severity: 9,
        confianca: 'alta',
        title: `ZERO vendas com R$${c.spend.toFixed(2)} gasto — investigar agora`,
        description: `Gasto ${(c.spend / cpa).toFixed(1)}× o CPA-alvo sem nenhuma venda. Esperado: ${vendasEsp.toFixed(0)} venda(s). Isso é um sinal real — não é ruído estatístico.`,
        recommendation: `Pause e investigue em ordem: (1) Pixel/CAPI funcionando? (2) Página de vendas carregando e rápida? (3) Checkout sem erro? (4) Oferta está clara e ativa? (5) Público está alinhado com a oferta?`,
        action_type: 'PAUSE',
        o_que_muda: 'Problema técnico encontrado → corrigir e reativar. Oferta/público errado → reformular campanha.',
        quando_revisar: 'Agora — cada hora adicional gasta mais sem retorno',
        impacto_financeiro: `R$${c.spend.toFixed(2)} investidos sem nenhuma receita gerada`,
        display_text: `🔴 ZERO vendas com R$${c.spend.toFixed(2)} — ${(c.spend/cpa).toFixed(1)}× o CPA-alvo. Dado suficiente para agir: pause e verifique pixel, página e checkout.`,
        data_snapshot: { spend: c.spend, cpa_target: cpa, vendas_esperadas: vendasEsp, suficiencia: suf }
      });
    }
  }

  // ── R10: Budget alto com ROAS baixo (desperdício em andamento) ────────────
  if (budgetUtil > 0.85 && c.roas < rT && c.spend >= config.min_spend) {
    const suf  = nivelSuficiencia(c.spend, cpa);
    const conf = calcConfianca(c.spend, cpa, c.conversions);
    if (suf !== 'insuficiente') {
      const desperdicioEst = ((c.spend - c.revenue / rT)).toFixed(2);
      decisions.push({
        rule_id: 'R10', type: 'BUDGET_ANOMALY',
        severity: conf === 'alta' ? 7 : 4,
        confianca: conf,
        title: `${(budgetUtil * 100).toFixed(0)}% do orçamento usado com ROAS ${c.roas.toFixed(2)}× (abaixo do target)`,
        description: `Orçamento diário R$${c.daily_budget.toFixed(2)}. Já gastou R$${c.spend.toFixed(2)} com ROAS de ${c.roas.toFixed(2)}× vs. target ${rT}×.`,
        recommendation: `Reduza o budget diário para R$${(c.daily_budget * 0.5).toFixed(2)} (50%) até estabilizar o ROAS. Não pause totalmente — preserve o aprendizado do algoritmo.`,
        action_type: 'REVIEW',
        o_que_muda: `ROAS subir acima de ${rT}× → aumentar budget de volta gradualmente. ROAS cair abaixo de ${rBE}× → R03 (prejuízo real).`,
        quando_revisar: '24h',
        impacto_financeiro: `Desperdício estimado: R$${Math.max(0, parseFloat(desperdicioEst)).toFixed(2)} abaixo do retorno esperado`,
        display_text: `🟡 ${(budgetUtil*100).toFixed(0)}% do orçamento consumido com ROAS ${c.roas.toFixed(2)}×. Reduza budget 50% e monitore 24h.`,
        data_snapshot: { budget_util: budgetUtil, roas: c.roas, roas_target: rT, spend: c.spend, daily_budget: c.daily_budget, suficiencia: suf }
      });
    }
  }

  // ── R11: Conversão assimétrica — muitos cliques, zero conversão ──────────
  // Só com amostra suficiente de cliques
  if (c.clicks >= 80 && c.conversions === 0 && c.ctr > 1.0) {
    // CTR bom mas sem conversão = problema de página/oferta, não criativo
    decisions.push({
      rule_id: 'R11', type: 'PAGE_CONVERSION',
      severity: 7,
      confianca: 'alta',
      title: `${c.clicks} cliques sem nenhuma conversão — problema na página`,
      description: `CTR ${c.ctr.toFixed(2)}% (bom). Cliques: ${c.clicks}. Conversões: 0. O anúncio atrai mas a página/oferta não converte.`,
      recommendation: `O criativo está funcionando — o problema está depois do clique. Verifique: (1) Velocidade da página (>3s = 50% saem), (2) Headline alinhada com o anúncio, (3) CTA visível acima do fold, (4) Checkout sem fricção.`,
      action_type: 'ALERT',
      o_que_muda: 'Taxa de conversão aparecer → criativo e página ok. Conversões continuarem zero → revisar funil completo.',
      quando_revisar: 'Imediatamente — problema de funil, não de anúncio',
      impacto_financeiro: `R$${c.spend.toFixed(2)} em cliques sem receita. Taxa de conv. esperada: ~${(1/cpa*100).toFixed(1)}%`,
      display_text: `🔴 ${c.clicks} cliques (CTR ${c.ctr.toFixed(2)}%) mas zero conversão. O anúncio convence — o problema é a página. Verifique velocidade, headline e checkout.`,
      data_snapshot: { clicks: c.clicks, ctr: c.ctr, conversions: 0, spend: c.spend }
    });
  }

  // ── Ordenar por impacto × confiança (severidade é o proxy) ────────────────
  return decisions.sort((a, b) => b.severity - a.severity);
};

// ─── COOLDOWN POR SEVERIDADE ─────────────────────────────────────────────────
const getCooldownSec = (severity) => {
  if (severity >= 9) return 2  * 60 * 60;  // 2h
  if (severity >= 7) return 4  * 60 * 60;  // 4h
  if (severity >= 5) return 8  * 60 * 60;  // 8h
  return 24 * 60 * 60;                     // 24h (info / baixa severidade)
};

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

// ─── EXECUTAR O MOTOR PARA UM USUÁRIO ────────────────────────────────────────
const runDecisionEngine = async (userId) => {
  console.log(`[Decision Engine] Iniciando avaliacao para usuario ${userId}`);
  const config    = await getUserConfig(userId);
  const campaigns = await calculateByCampaign(userId, 7);

  const allDecisions = [];

  for (const campaign of campaigns) {
    if (campaign.spend < 5) continue; // Skip campanhas com gasto < R$5

    const history7d      = await getCampaignHistory7d(userId, campaign.external_id);
    const salesHistory7d = await getSalesHistory7d(userId, campaign.external_id);
    const decisions      = evaluateCampaign(campaign, history7d, salesHistory7d, config);

    for (const decision of decisions) {
      const isDup = await isDuplicateDecision(
        userId, campaign.campaign_id, decision.type, decision.severity
      );
      if (isDup) {
        console.log(`[Decision Engine] ${decision.rule_id} em cooldown — pulando`);
        continue;
      }

      // Montar data_snapshot com os campos novos
      const snapshot = {
        ...decision.data_snapshot,
        confianca:             decision.confianca,
        display_text:          decision.display_text,
        o_que_muda:            decision.o_que_muda,
        quando_revisar:        decision.quando_revisar,
        impacto_financeiro:    decision.impacto_financeiro,
      };

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
        JSON.stringify(snapshot),
      ]);

      const dbId = inserted.rows[0]?.id;
      allDecisions.push({ ...decision, campaign_name: campaign.campaign_name, db_id: dbId });
      console.log(`[Decision Engine] ${decision.rule_id} sev:${decision.severity} conf:${decision.confianca} — ${decision.title.slice(0,60)}`);
    }
  }

  const criticalDecisions = allDecisions.filter(d => d.severity >= 7);
  console.log(`[Decision Engine] ${allDecisions.length} decisoes, ${criticalDecisions.length} criticas`);
  return { all: allDecisions, critical: criticalDecisions };
};

module.exports = { runDecisionEngine, evaluateCampaign, getUserConfig };
