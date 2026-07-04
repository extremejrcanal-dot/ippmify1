const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');

const router = express.Router();
router.use(requireAuth);

// ─── BENCHMARKS POR NICHO ─────────────────────────────────────────────────
// Valores baseados em dados reais do mercado brasileiro (Meta Ads, 2024-2025)
// avg  = media do mercado
// great = top 10% do mercado (meta de excelencia)
const BENCHMARKS = {
  ecommerce: {
    label: 'E-commerce',
    roas:      { avg: 2.5,  great: 5.0,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 80,   great: 35,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 1.5,  great: 3.0,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 35,   great: 18,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 1.5,  great: 3.5,  unit: '%',  lower_is_better: false },
  },
  infoprodutos: {
    label: 'Infoprodutos',
    roas:      { avg: 3.0,  great: 7.0,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 60,   great: 22,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 2.0,  great: 4.5,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 28,   great: 15,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 2.0,  great: 5.5,  unit: '%',  lower_is_better: false },
  },
  servicos: {
    label: 'Servicos / Leads',
    roas:      { avg: 2.0,  great: 4.0,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 100,  great: 40,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 1.2,  great: 2.8,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 40,   great: 22,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 1.0,  great: 2.5,  unit: '%',  lower_is_better: false },
  },
  saude_beleza: {
    label: 'Saude & Beleza',
    roas:      { avg: 2.8,  great: 5.5,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 70,   great: 28,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 1.8,  great: 3.8,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 30,   great: 16,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 1.8,  great: 4.2,  unit: '%',  lower_is_better: false },
  },
  aplicativos: {
    label: 'Aplicativos / SaaS',
    roas:      { avg: 2.0,  great: 5.0,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 50,   great: 18,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 2.5,  great: 5.5,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 25,   great: 12,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 3.0,  great: 7.5,  unit: '%',  lower_is_better: false },
  },
};

// ─── CALCULAR NOTA DE UMA METRICA ─────────────────────────────────────────
// Retorna grade (A+, A, B, C, D, N/A) e score 0-100
const gradeMetric = (value, bench) => {
  if (value === null || value === undefined || isNaN(value)) {
    return { grade: 'N/A', score: null };
  }

  const { avg, great, lower_is_better } = bench;

  // Normalizar: quanto maior o score, melhor (independente de lower_is_better)
  let ratio;
  if (lower_is_better) {
    // CPA, CPM: menor é melhor. great < avg.
    // ratio = 1 quando value = great, 0 quando value = avg * 2
    const worst = avg * 2;
    ratio = Math.max(0, Math.min(1, (worst - value) / (worst - great)));
  } else {
    // ROAS, CTR, Conv Rate: maior é melhor
    // ratio = 0 quando value = 0, 1 quando value = great
    ratio = Math.max(0, Math.min(1, value / great));
  }

  const score = Math.round(ratio * 100);

  let grade;
  if (lower_is_better) {
    if (value <= great)        grade = 'A+';
    else if (value <= avg * 0.8) grade = 'A';
    else if (value <= avg)     grade = 'B';
    else if (value <= avg * 1.4) grade = 'C';
    else                       grade = 'D';
  } else {
    if (value >= great)        grade = 'A+';
    else if (value >= avg * 1.3) grade = 'A';
    else if (value >= avg)     grade = 'B';
    else if (value >= avg * 0.6) grade = 'C';
    else                       grade = 'D';
  }

  return { grade, score };
};

// ─── GRADE GERAL A PARTIR DO SCORE ────────────────────────────────────────
const overallGrade = (score) => {
  if (score >= 85) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  return 'D';
};

// ─── GET /api/benchmarks ──────────────────────────────────────────────────
// Query: ?niche=ecommerce&days=30
router.get('/', async (req, res) => {
  try {
    const niche = req.query.niche || 'ecommerce';
    const days  = Math.min(parseInt(req.query.days) || 30, 90);
    const bench = BENCHMARKS[niche] || BENCHMARKS.ecommerce;

    // ── Metricas brutas do usuario (ultimos N dias) ──────────────────────
    // Tenta com pixel_purchase_count; cai para query simples se coluna nao existir
    let adRow = {};
    try {
      const adResult = await query(`
        SELECT
          COALESCE(SUM(am.spend), 0)::float         AS total_spend,
          COALESCE(SUM(am.impressions), 0)::bigint  AS total_impressions,
          COALESCE(SUM(am.clicks), 0)::bigint       AS total_clicks,
          COALESCE(SUM(am.pixel_purchase_count), 0)::integer AS pixel_conv
        FROM ad_metrics am
        JOIN campaigns c ON c.id = am.campaign_id
        WHERE c.user_id = $1
          AND am.date >= CURRENT_DATE - INTERVAL '1 day' * $2
      `, [req.user.id, days]);
      adRow = adResult.rows[0] || {};
    } catch (e) {
      // pixel_purchase_count pode nao existir ainda — fallback sem ela
      console.warn('[Benchmarks] Fallback sem pixel_purchase_count:', e.message);
      const adResult = await query(`
        SELECT
          COALESCE(SUM(am.spend), 0)::float         AS total_spend,
          COALESCE(SUM(am.impressions), 0)::bigint  AS total_impressions,
          COALESCE(SUM(am.clicks), 0)::bigint       AS total_clicks,
          0::integer                                AS pixel_conv
        FROM ad_metrics am
        JOIN campaigns c ON c.id = am.campaign_id
        WHERE c.user_id = $1
          AND am.date >= CURRENT_DATE - INTERVAL '1 day' * $2
      `, [req.user.id, days]);
      adRow = adResult.rows[0] || {};
    }

    const totalSpend       = parseFloat(adRow.total_spend || 0);
    const totalImpressions = parseInt(adRow.total_impressions || 0);
    const totalClicks      = parseInt(adRow.total_clicks || 0);
    const pixelConv        = parseInt(adRow.pixel_conv || 0);

    // Vendas via webhook (receita + conversoes) — tabela pode nao existir ainda
    let webhookRev  = 0;
    let webhookConv = 0;
    try {
      const salesResult = await query(`
        SELECT
          COALESCE(SUM(s.price), 0)::float AS webhook_revenue,
          COUNT(s.id)::integer             AS webhook_conv
        FROM sales s
        WHERE s.user_id = $1
          AND s.created_at >= NOW() - INTERVAL '1 day' * $2
          AND s.status = 'approved'
      `, [req.user.id, days]);
      const salesRow = salesResult.rows[0] || {};
      webhookRev  = parseFloat(salesRow.webhook_revenue || 0);
      webhookConv = parseInt(salesRow.webhook_conv || 0);
    } catch (e) {
      console.warn('[Benchmarks] Tabela sales nao encontrada — ignorando receita webhook:', e.message);
    }

    // Deduplicacao: webhook tem prioridade
    const totalConv    = webhookConv > 0 ? webhookConv : pixelConv;
    const totalRevenue = webhookRev;

    // ── Calcular metricas do usuario ────────────────────────────────────
    const userMetrics = {
      roas:      totalSpend > 0 && totalRevenue > 0 ? totalRevenue / totalSpend : null,
      cpa:       totalConv > 0 && totalSpend > 0    ? totalSpend / totalConv    : null,
      ctr:       totalImpressions > 0               ? (totalClicks / totalImpressions) * 100 : null,
      cpm:       totalImpressions > 0               ? (totalSpend / totalImpressions) * 1000 : null,
      conv_rate: totalClicks > 0 && totalConv > 0   ? (totalConv / totalClicks) * 100 : null,
    };

    // ── Comparar cada metrica com o benchmark ────────────────────────────
    const metrics = {};
    const scores  = [];

    for (const [key, benchData] of Object.entries(bench)) {
      if (key === 'label') continue;
      const yourValue = userMetrics[key];
      const { grade, score } = gradeMetric(yourValue, benchData);

      metrics[key] = {
        your_value:      yourValue !== null ? parseFloat(yourValue.toFixed(4)) : null,
        benchmark_avg:   benchData.avg,
        benchmark_great: benchData.great,
        grade,
        unit:            benchData.unit,
        lower_is_better: benchData.lower_is_better,
        label:           yourValue !== null
          ? (benchData.lower_is_better
              ? (yourValue <= benchData.great ? 'Voce esta no top 10%!' : yourValue <= benchData.avg ? 'Na media do mercado' : 'Acima da media de custo')
              : (yourValue >= benchData.great ? 'Voce esta no top 10%!' : yourValue >= benchData.avg ? 'Na media do mercado' : 'Abaixo da media'))
          : 'Sem dados suficientes',
      };

      if (score !== null) scores.push(score);
    }

    // ── Score e grade geral ──────────────────────────────────────────────
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;

    const finalGrade = avgScore !== null ? overallGrade(avgScore) : 'N/A';

    res.json({
      niche,
      niche_label:   bench.label,
      period_days:   days,
      overall_score: avgScore,
      overall_grade: finalGrade,
      has_data:      totalSpend > 0,
      totals: {
        spend:       parseFloat(totalSpend.toFixed(2)),
        revenue:     parseFloat(totalRevenue.toFixed(2)),
        impressions: totalImpressions,
        clicks:      totalClicks,
        conversions: totalConv,
      },
      metrics,
    });

  } catch (err) {
    console.error('[Benchmarks] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao calcular benchmarks' });
  }
});

module.exports = router;
