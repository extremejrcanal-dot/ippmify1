const express = require('express');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ─── BENCHMARKS DO MERCADO ────────────────────────────────────────────────────
// Dados baseados em médias reais do mercado brasileiro de tráfego pago

const BENCHMARKS = {
  ecommerce: {
    label: 'E-commerce',
    icon: '🛒',
    metrics: {
      roas:        { avg: 3.5,  good: 4.5,  great: 6.0,  unit: 'x',  lower_is_better: false },
      cpa:         { avg: 45,   good: 35,   great: 20,   unit: 'R$', lower_is_better: true  },
      ctr:         { avg: 1.8,  good: 2.5,  great: 3.5,  unit: '%',  lower_is_better: false },
      cpm:         { avg: 18,   good: 15,   great: 10,   unit: 'R$', lower_is_better: true  },
      conv_rate:   { avg: 1.2,  good: 2.0,  great: 3.5,  unit: '%',  lower_is_better: false },
    }
  },
  infoprodutos: {
    label: 'Infoprodutos',
    icon: '📚',
    metrics: {
      roas:        { avg: 5.0,  good: 7.0,  great: 10.0, unit: 'x',  lower_is_better: false },
      cpa:         { avg: 80,   good: 60,   great: 35,   unit: 'R$', lower_is_better: true  },
      ctr:         { avg: 2.2,  good: 3.0,  great: 4.5,  unit: '%',  lower_is_better: false },
      cpm:         { avg: 22,   good: 18,   great: 12,   unit: 'R$', lower_is_better: true  },
      conv_rate:   { avg: 2.5,  good: 4.0,  great: 6.0,  unit: '%',  lower_is_better: false },
    }
  },
  servicos: {
    label: 'Serviços / Leads',
    icon: '🤝',
    metrics: {
      roas:        { avg: 4.0,  good: 6.0,  great: 9.0,  unit: 'x',  lower_is_better: false },
      cpa:         { avg: 120,  good: 80,   great: 45,   unit: 'R$', lower_is_better: true  },
      ctr:         { avg: 1.5,  good: 2.2,  great: 3.2,  unit: '%',  lower_is_better: false },
      cpm:         { avg: 20,   good: 16,   great: 10,   unit: 'R$', lower_is_better: true  },
      conv_rate:   { avg: 3.0,  good: 5.0,  great: 8.0,  unit: '%',  lower_is_better: false },
    }
  },
  saude_beleza: {
    label: 'Saúde & Beleza',
    icon: '💊',
    metrics: {
      roas:        { avg: 4.0,  good: 5.5,  great: 8.0,  unit: 'x',  lower_is_better: false },
      cpa:         { avg: 55,   good: 40,   great: 25,   unit: 'R$', lower_is_better: true  },
      ctr:         { avg: 2.0,  good: 2.8,  great: 4.0,  unit: '%',  lower_is_better: false },
      cpm:         { avg: 20,   good: 16,   great: 11,   unit: 'R$', lower_is_better: true  },
      conv_rate:   { avg: 1.8,  good: 3.0,  great: 5.0,  unit: '%',  lower_is_better: false },
    }
  },
  aplicativos: {
    label: 'Aplicativos / SaaS',
    icon: '📱',
    metrics: {
      roas:        { avg: 2.5,  good: 3.5,  great: 5.0,  unit: 'x',  lower_is_better: false },
      cpa:         { avg: 35,   good: 25,   great: 15,   unit: 'R$', lower_is_better: true  },
      ctr:         { avg: 1.2,  good: 1.8,  great: 2.8,  unit: '%',  lower_is_better: false },
      cpm:         { avg: 16,   good: 12,   great: 8,    unit: 'R$', lower_is_better: true  },
      conv_rate:   { avg: 2.0,  good: 3.5,  great: 5.5,  unit: '%',  lower_is_better: false },
    }
  },
};

// Calcular métricas reais do usuário (últimos 30 dias)
const getUserMetrics = async (userId) => {
  try {
    const result = await query(`
      SELECT
        COALESCE(SUM(spend), 0)::float           AS total_spend,
        COALESCE(SUM(revenue), 0)::float          AS total_revenue,
        COALESCE(SUM(conversions), 0)::float      AS total_conversions,
        COALESCE(SUM(clicks), 0)::float           AS total_clicks,
        COALESCE(SUM(impressions), 0)::float      AS total_impressions
      FROM daily_metrics
      WHERE user_id = $1
        AND date >= NOW() - INTERVAL '30 days'
    `, [userId]);

    const m = result.rows[0];
    const spend       = parseFloat(m.total_spend)       || 0;
    const revenue     = parseFloat(m.total_revenue)     || 0;
    const conversions = parseFloat(m.total_conversions) || 0;
    const clicks      = parseFloat(m.total_clicks)      || 0;
    const impressions = parseFloat(m.total_impressions) || 0;

    return {
      roas:      spend > 0 ? revenue / spend : null,
      cpa:       conversions > 0 ? spend / conversions : null,
      ctr:       impressions > 0 ? (clicks / impressions) * 100 : null,
      cpm:       impressions > 0 ? (spend / impressions) * 1000 : null,
      conv_rate: clicks > 0 ? (conversions / clicks) * 100 : null,
      // raw
      spend, revenue, conversions, clicks, impressions,
    };
  } catch (err) {
    console.error('[Benchmarks] Erro ao buscar métricas:', err.message);
    return null;
  }
};

// Calcular score e grade para uma métrica
const scoreMetric = (value, benchmark, lowerIsBetter) => {
  if (value === null || value === undefined) return { score: null, grade: 'N/A', label: 'Sem dados' };

  const { avg, good, great } = benchmark;

  let score, grade, label;

  if (lowerIsBetter) {
    // Menor é melhor (CPA, CPM)
    if (value <= great)     { score = 100; grade = 'A+'; label = 'Excelente'; }
    else if (value <= good) { score = 80;  grade = 'A';  label = 'Acima da média'; }
    else if (value <= avg)  { score = 60;  grade = 'B';  label = 'Na média'; }
    else if (value <= avg * 1.5) { score = 40; grade = 'C'; label = 'Abaixo da média'; }
    else                    { score = 20;  grade = 'D';  label = 'Precisa melhorar'; }
  } else {
    // Maior é melhor (ROAS, CTR, Conv Rate)
    if (value >= great)     { score = 100; grade = 'A+'; label = 'Excelente'; }
    else if (value >= good) { score = 80;  grade = 'A';  label = 'Acima da média'; }
    else if (value >= avg)  { score = 60;  grade = 'B';  label = 'Na média'; }
    else if (value >= avg * 0.7) { score = 40; grade = 'C'; label = 'Abaixo da média'; }
    else                    { score = 20;  grade = 'D';  label = 'Precisa melhorar'; }
  }

  return { score, grade, label };
};

// ─── GET /api/benchmarks ──────────────────────────────────────────────────────
// Retorna benchmarks + métricas do usuário + análise comparativa
router.get('/', requireAuth, async (req, res) => {
  try {
    const niche = req.query.niche || 'ecommerce';
    const benchmark = BENCHMARKS[niche];

    if (!benchmark) {
      return res.status(400).json({ error: 'Nicho inválido' });
    }

    const userMetrics = await getUserMetrics(req.user.id);
    const analysis = {};
    let totalScore = 0;
    let scoredCount = 0;

    for (const [key, ref] of Object.entries(benchmark.metrics)) {
      const value = userMetrics ? userMetrics[key] : null;
      const scored = scoreMetric(value, ref, ref.lower_is_better);

      analysis[key] = {
        your_value: value !== null ? parseFloat(value.toFixed(2)) : null,
        benchmark_avg:   ref.avg,
        benchmark_good:  ref.good,
        benchmark_great: ref.great,
        unit:            ref.unit,
        lower_is_better: ref.lower_is_better,
        ...scored,
      };

      if (scored.score !== null) {
        totalScore += scored.score;
        scoredCount++;
      }
    }

    const overallScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : null;
    let overallGrade = 'N/A';
    if (overallScore >= 90)     overallGrade = 'A+';
    else if (overallScore >= 75) overallGrade = 'A';
    else if (overallScore >= 55) overallGrade = 'B';
    else if (overallScore >= 35) overallGrade = 'C';
    else if (overallScore !== null) overallGrade = 'D';

    res.json({
      niche,
      niche_label:   benchmark.label,
      niche_icon:    benchmark.icon,
      overall_score: overallScore,
      overall_grade: overallGrade,
      metrics:       analysis,
      raw_metrics:   userMetrics,
      available_niches: Object.entries(BENCHMARKS).map(([k, v]) => ({
        key: k, label: v.label, icon: v.icon
      })),
    });

  } catch (error) {
    console.error('[Benchmarks] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao carregar benchmarks' });
  }
});

module.exports = router;
