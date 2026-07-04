const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');

const router = express.Router();
router.use(requireAuth);

// ─── BENCHMARKS POR NICHO ─────────────────────────────────────────────────
// Dados atualizados: Meta Ads Brasil, 2026 (H1 2026)
// Fontes: dados internos IPPMIFY + WordStream + Guia de Métricas Meta Business
// avg   = mediana do mercado brasileiro (50° percentil)
// great = top 10% do mercado (meta de excelência)
// Contexto 2026:
//   - CPMs subiram ~25–35% vs 2024 (mais anunciantes, leilão competitivo)
//   - iOS ATT: ~35–45% das conversões perdidas sem CAPI
//   - Advantage+: reduz CPA em média 20–30% vs interesse manual
//   - Frequência criativa: fadiga em 10–21 dias (antes era 30+)
const BENCHMARKS = {
  ecommerce: {
    label: 'E-commerce',
    roas:      { avg: 2.8,  great: 5.5,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 95,   great: 40,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 1.6,  great: 3.5,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 48,   great: 25,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 1.4,  great: 3.2,  unit: '%',  lower_is_better: false },
  },
  infoprodutos: {
    label: 'Infoprodutos',
    roas:      { avg: 3.2,  great: 7.0,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 68,   great: 28,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 2.2,  great: 5.0,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 38,   great: 20,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 2.2,  great: 6.0,  unit: '%',  lower_is_better: false },
  },
  servicos: {
    label: 'Serviços / Leads',
    roas:      { avg: 2.2,  great: 4.5,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 115,  great: 48,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 1.3,  great: 3.0,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 52,   great: 28,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 1.1,  great: 2.8,  unit: '%',  lower_is_better: false },
  },
  saude_beleza: {
    label: 'Saúde & Beleza',
    roas:      { avg: 3.0,  great: 6.0,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 80,   great: 32,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 2.0,  great: 4.5,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 42,   great: 22,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 2.0,  great: 4.8,  unit: '%',  lower_is_better: false },
  },
  aplicativos: {
    label: 'Aplicativos / SaaS',
    roas:      { avg: 2.2,  great: 5.5,  unit: 'x',  lower_is_better: false },
    cpa:       { avg: 58,   great: 22,   unit: 'R$', lower_is_better: true  },
    ctr:       { avg: 2.8,  great: 6.0,  unit: '%',  lower_is_better: false },
    cpm:       { avg: 32,   great: 16,   unit: 'R$', lower_is_better: true  },
    conv_rate: { avg: 3.2,  great: 8.0,  unit: '%',  lower_is_better: false },
  },
};

// ─── CALCULAR NOTA DE UMA METRICA ─────────────────────────────────────────
const gradeMetric = (value, bench) => {
  if (value === null || value === undefined || isNaN(value)) {
    return { grade: 'N/A', score: null };
  }

  const { avg, great, lower_is_better } = bench;

  let ratio;
  if (lower_is_better) {
    const worst = avg * 2.2;
    ratio = Math.max(0, Math.min(1, (worst - value) / (worst - great)));
  } else {
    ratio = Math.max(0, Math.min(1, value / great));
  }

  const score = Math.round(ratio * 100);

  let grade;
  if (lower_is_better) {
    if (value <= great)          grade = 'A+';
    else if (value <= avg * 0.8) grade = 'A';
    else if (value <= avg)       grade = 'B';
    else if (value <= avg * 1.4) grade = 'C';
    else                         grade = 'D';
  } else {
    if (value >= great)          grade = 'A+';
    else if (value >= avg * 1.3) grade = 'A';
    else if (value >= avg)       grade = 'B';
    else if (value >= avg * 0.6) grade = 'C';
    else                         grade = 'D';
  }

  return { grade, score };
};

const overallGrade = (score) => {
  if (score >= 85) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  return 'D';
};

const metricLabel = (value, bench) => {
  if (value === null) return 'Sem dados suficientes';
  const { avg, great, lower_is_better } = bench;
  if (lower_is_better) {
    if (value <= great)          return 'Você está no top 10%! 🏆';
    if (value <= avg * 0.85)     return 'Acima da média do mercado';
    if (value <= avg)            return 'Na média do mercado';
    if (value <= avg * 1.5)      return 'Acima da média de custo — otimize';
    return 'Custo alto — ação necessária';
  } else {
    if (value >= great)          return 'Você está no top 10%! 🏆';
    if (value >= avg * 1.3)      return 'Acima da média do mercado';
    if (value >= avg)            return 'Na média do mercado';
    if (value >= avg * 0.6)      return 'Abaixo da média — melhore';
    return 'Resultado baixo — ação necessária';
  }
};

// ─── GET /api/benchmarks ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const niche = req.query.niche || 'ecommerce';
    const days  = Math.min(parseInt(req.query.days) || 30, 90);
    const bench = BENCHMARKS[niche] || BENCHMARKS.ecommerce;

    // Métricas de anúncios
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
    } catch (_) {
      // pixel_purchase_count pode nao existir — fallback
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

    // Vendas via webhook
    let webhookRev = 0, webhookConv = 0;
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
      const sr = salesResult.rows[0] || {};
      webhookRev  = parseFloat(sr.webhook_revenue || 0);
      webhookConv = parseInt(sr.webhook_conv || 0);
    } catch (_) {
      // tabela sales nao existe
    }

    const totalConv    = webhookConv > 0 ? webhookConv : pixelConv;
    const totalRevenue = webhookRev;

    const userMetrics = {
      roas:      totalSpend > 0 && totalRevenue > 0  ? totalRevenue / totalSpend          : null,
      cpa:       totalConv > 0  && totalSpend > 0    ? totalSpend / totalConv             : null,
      ctr:       totalImpressions > 0                ? (totalClicks / totalImpressions) * 100 : null,
      cpm:       totalImpressions > 0                ? (totalSpend / totalImpressions) * 1000 : null,
      conv_rate: totalClicks > 0 && totalConv > 0    ? (totalConv / totalClicks) * 100   : null,
    };

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
        label:           metricLabel(yourValue, benchData),
      };

      if (score !== null) scores.push(score);
    }

    const avgScore   = scores.length > 0
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
      data_year:     2026,
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
