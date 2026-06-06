const { query } = require('../config/database');
const { setEx } = require('../config/redis');

// ─── ENGINE DE METRICAS ────────────────────────────────────────────────────
// Calcula lucro real e todas as metricas de performance

// Formula central de calculo de metricas
const calculateMetrics = (spend, revenue, conversions, impressions, clicks) => {
  const profit    = revenue - spend;
  const roas      = spend > 0 ? revenue / spend : 0;
  const cpa       = conversions > 0 ? spend / conversions : 0;
  const ctr       = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpm       = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const cpc       = clicks > 0 ? spend / clicks : 0;
  const roi       = spend > 0 ? ((profit / spend) * 100) : 0;
  const convRate  = clicks > 0 ? (conversions / clicks) * 100 : 0;

  return {
    spend:        parseFloat(spend.toFixed(2)),
    revenue:      parseFloat(revenue.toFixed(2)),
    profit:       parseFloat(profit.toFixed(2)),
    roas:         parseFloat(roas.toFixed(4)),
    cpa:          parseFloat(cpa.toFixed(2)),
    ctr:          parseFloat(ctr.toFixed(4)),
    cpm:          parseFloat(cpm.toFixed(2)),
    cpc:          parseFloat(cpc.toFixed(2)),
    roi_pct:      parseFloat(roi.toFixed(2)),
    conv_rate:    parseFloat(convRate.toFixed(4)),
    conversions:  Math.round(conversions),
    impressions:  Math.round(impressions),
    clicks:       Math.round(clicks),
  };
};

// Calcular metricas gerais de um usuario (todas as campanhas)
const calculateOverview = async (userId, days = 7) => {
  const cacheKey = `metrics:overview:${userId}:${days}d`;

  // Query que junta gastos do Meta Ads com vendas do Hotmart/Kiwify
  // Esta e a magica do IPPMIFY: lucro REAL, nao o que o Meta reporta
  const result = await query(`
    WITH ad_data AS (
      SELECT
        COALESCE(SUM(am.spend), 0) AS total_spend,
        COALESCE(SUM(am.impressions), 0) AS total_impressions,
        COALESCE(SUM(am.clicks), 0) AS total_clicks
      FROM ad_metrics am
      WHERE am.user_id = $1
        AND am.date >= CURRENT_DATE - INTERVAL '${days} days'
    ),
    sales_data AS (
      SELECT
        COALESCE(SUM(s.net_revenue), 0) AS total_revenue,
        COUNT(s.id) AS total_conversions
      FROM sales s
      WHERE s.user_id = $1
        AND s.status = 'approved'
        AND s.sale_date >= NOW() - INTERVAL '${days} days'
    ),
    refund_data AS (
      SELECT COALESCE(SUM(s.gross_revenue), 0) AS total_refunds
      FROM sales s
      WHERE s.user_id = $1
        AND s.status = 'refunded'
        AND s.sale_date >= NOW() - INTERVAL '${days} days'
    )
    SELECT
      ad.total_spend,
      sd.total_revenue,
      rd.total_refunds,
      sd.total_conversions,
      ad.total_impressions,
      ad.total_clicks
    FROM ad_data ad, sales_data sd, refund_data rd
  `, [userId]);

  const row = result.rows[0];
  const metrics = calculateMetrics(
    parseFloat(row.total_spend),
    parseFloat(row.total_revenue),
    parseInt(row.total_conversions),
    parseInt(row.total_impressions),
    parseInt(row.total_clicks)
  );

  metrics.total_refunds = parseFloat(row.total_refunds);
  metrics.refund_rate = metrics.conversions > 0
    ? parseFloat(((row.total_refunds / (metrics.revenue + row.total_refunds)) * 100).toFixed(2))
    : 0;
  metrics.period_days = days;

  // Cache por 15 minutos
  await setEx(cacheKey, metrics, 15 * 60);

  return metrics;
};

// Calcular metricas por campanha
const calculateByCampaign = async (userId, days = 7) => {
  const result = await query(`
    SELECT
      c.id AS campaign_id,
      c.name AS campaign_name,
      c.external_id,
      c.status AS campaign_status,
      c.daily_budget,
      COALESCE(SUM(am.spend), 0) AS total_spend,
      COALESCE(SUM(am.impressions), 0) AS total_impressions,
      COALESCE(SUM(am.clicks), 0) AS total_clicks,
      COALESCE(SUM(s.net_revenue), 0) AS total_revenue,
      COUNT(s.id) AS total_conversions
    FROM campaigns c
    LEFT JOIN ad_metrics am
      ON am.campaign_id = c.id
      AND am.date >= CURRENT_DATE - INTERVAL '${days} days'
    LEFT JOIN sales s
      ON s.utm_campaign = c.external_id
      AND s.status = 'approved'
      AND s.user_id = c.user_id
      AND s.sale_date >= NOW() - INTERVAL '${days} days'
    WHERE c.user_id = $1
    GROUP BY c.id, c.name, c.external_id, c.status, c.daily_budget
    ORDER BY
      CASE WHEN c.status = 'ACTIVE' THEN 0 ELSE 1 END ASC,
      total_spend DESC
  `, [userId]);

  return result.rows.map(row => ({
    campaign_id:   row.campaign_id,
    campaign_name: row.campaign_name,
    external_id:   row.external_id,
    status:        row.campaign_status,
    daily_budget:  parseFloat(row.daily_budget || 0),
    ...calculateMetrics(
      parseFloat(row.total_spend),
      parseFloat(row.total_revenue),
      parseInt(row.total_conversions),
      parseInt(row.total_impressions),
      parseInt(row.total_clicks)
    )
  }));
};

// Calcular metricas historicas (ultimos N dias, agrupado por dia)
const calculateDailyHistory = async (userId, campaignId = null, days = 30) => {
  const params = [userId];
  let campaignFilter = '';

  if (campaignId) {
    params.push(campaignId);
    campaignFilter = `AND am.campaign_id = $${params.length}`;
  }

  const result = await query(`
    SELECT
      am.date,
      COALESCE(SUM(am.spend), 0) AS spend,
      COALESCE(SUM(am.impressions), 0) AS impressions,
      COALESCE(SUM(am.clicks), 0) AS clicks,
      COALESCE(SUM(s.net_revenue), 0) AS revenue,
      COUNT(s.id) AS conversions
    FROM ad_metrics am
    LEFT JOIN campaigns c ON c.id = am.campaign_id
    LEFT JOIN sales s
      ON s.utm_campaign = c.external_id
      AND s.user_id = $1
      AND s.status = 'approved'
      AND DATE(s.sale_date) = am.date
    WHERE am.user_id = $1
      AND am.date >= CURRENT_DATE - INTERVAL '${days} days'
      ${campaignFilter}
    GROUP BY am.date
    ORDER BY am.date ASC
  `, params);

  return result.rows.map(row => ({
    date: row.date,
    ...calculateMetrics(
      parseFloat(row.spend),
      parseFloat(row.revenue),
      parseInt(row.conversions),
      parseInt(row.impressions),
      parseInt(row.clicks)
    )
  }));
};

// Salvar snapshot de metricas calculadas no banco
const saveSnapshot = async (userId, campaignId, metrics, period) => {
  await query(`
    INSERT INTO profit_snapshots
      (user_id, campaign_id, period_start, period_end,
       total_spend, total_revenue, total_profit,
       roas, cpa, ctr, cpm, conversions, impressions, clicks)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT DO NOTHING
  `, [
    userId, campaignId,
    period.start, period.end,
    metrics.spend, metrics.revenue, metrics.profit,
    metrics.roas, metrics.cpa, metrics.ctr, metrics.cpm,
    metrics.conversions, metrics.impressions, metrics.clicks
  ]);
};

module.exports = {
  calculateMetrics,
  calculateOverview,
  calculateByCampaign,
  calculateDailyHistory,
  saveSnapshot
};
