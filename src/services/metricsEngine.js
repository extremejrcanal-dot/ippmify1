const { query } = require('../config/database');
const { setEx } = require('../config/redis');

// ─── ENGINE DE METRICAS ────────────────────────────────────────────────────
// Calcula lucro real e todas as metricas de performance

// Formula central de calculo de metricas
const calculateMetrics = (spend, revenue, conversions, impressions, clicks) => {
  const profit   = revenue - spend;
  const roas     = spend > 0 ? revenue / spend : 0;
  const cpa      = conversions > 0 ? spend / conversions : 0;
  const ctr      = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpm      = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const cpc      = clicks > 0 ? spend / clicks : 0;
  const roi      = spend > 0 ? ((profit / spend) * 100) : 0;
  const convRate = clicks > 0 ? (conversions / clicks) * 100 : 0;

  return {
    spend:       parseFloat(spend.toFixed(2)),
    revenue:     parseFloat(revenue.toFixed(2)),
    profit:      parseFloat(profit.toFixed(2)),
    roas:        parseFloat(roas.toFixed(4)),
    cpa:         parseFloat(cpa.toFixed(2)),
    ctr:         parseFloat(ctr.toFixed(4)),
    cpm:         parseFloat(cpm.toFixed(2)),
    cpc:         parseFloat(cpc.toFixed(2)),
    roi_pct:     parseFloat(roi.toFixed(2)),
    conv_rate:   parseFloat(convRate.toFixed(4)),
    conversions: Math.round(conversions),
    impressions: Math.round(impressions),
    clicks:      Math.round(clicks),
  };
};

// ─── DEDUPLICACAO PIXEL + WEBHOOK ─────────────────────────────────────────
// Regra: se a campanha tem vendas via webhook → usa SO webhook (pixel ignorado)
//        se nao tem webhook → usa contagem do pixel como fallback
// Isso evita dupla contagem sem precisar cruzar eventos individuais.
//
// Exemplo:
//   webhook=3, pixel=5  → usa 3 (webhook e fonte de verdade)
//   webhook=0, pixel=5  → usa 5 (pixel como fallback)
//   webhook=0, pixel=0  → usa 0
const dedupeConversions = (webhookCount, pixelCount) =>
  webhookCount > 0 ? webhookCount : pixelCount;

// ─── OVERVIEW GERAL ───────────────────────────────────────────────────────
// Calcula metricas gerais de um usuario (todas as campanhas)
const calculateOverview = async (userId, days = 7) => {
  const cacheKey = `metrics:overview:${userId}:${days}d`;

  // Deduplication per-campanha: decide qual fonte usar, depois agrega
  // Isso garante que campanhas com webhook usem so webhook, e as sem
  // webhook ainda mostrem as conversoes do pixel
  const result = await query(`
    WITH campaign_metrics AS (
      SELECT
        c.id,
        COALESCE(SUM(am.spend), 0)                              AS spend,
        COALESCE(SUM(am.impressions), 0)                        AS impressions,
        COALESCE(SUM(am.clicks), 0)                             AS clicks,
        COUNT(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL)   AS webhook_conv,
        COALESCE(SUM(s.net_revenue), 0)                         AS revenue,
        COALESCE(SUM(am.pixel_purchase_count), 0)               AS pixel_conv
      FROM campaigns c
      LEFT JOIN ad_metrics am
        ON am.campaign_id = c.id
        AND am.date >= CURRENT_DATE - INTERVAL '${days - 1} days'
      LEFT JOIN sales s
        ON s.utm_campaign = c.external_id
        AND s.user_id = c.user_id
        AND s.status = 'approved'
        AND DATE(s.sale_date) >= CURRENT_DATE - INTERVAL '${days - 1} days'
      WHERE c.user_id = $1
      GROUP BY c.id
    ),
    refund_data AS (
      SELECT COALESCE(SUM(gross_revenue), 0) AS total_refunds
      FROM sales
      WHERE user_id = $1
        AND status = 'refunded'
        AND DATE(sale_date) >= CURRENT_DATE - INTERVAL '${days - 1} days'
    )
    SELECT
      COALESCE(SUM(cm.spend), 0)       AS total_spend,
      COALESCE(SUM(cm.revenue), 0)     AS total_revenue,
      COALESCE(SUM(cm.impressions), 0) AS total_impressions,
      COALESCE(SUM(cm.clicks), 0)      AS total_clicks,
      -- Dedup: por campanha escolhe webhook ou pixel, nunca os dois
      COALESCE(SUM(
        CASE WHEN cm.webhook_conv > 0 THEN cm.webhook_conv ELSE cm.pixel_conv END
      ), 0) AS total_conversions,
      rd.total_refunds
    FROM campaign_metrics cm
    CROSS JOIN refund_data rd
    GROUP BY rd.total_refunds
  `, [userId]);

  const row = result.rows[0] || {
    total_spend: 0, total_revenue: 0, total_impressions: 0,
    total_clicks: 0, total_conversions: 0, total_refunds: 0,
  };

  const metrics = calculateMetrics(
    parseFloat(row.total_spend),
    parseFloat(row.total_revenue),
    parseInt(row.total_conversions),
    parseInt(row.total_impressions),
    parseInt(row.total_clicks)
  );

  metrics.total_refunds = parseFloat(row.total_refunds);
  metrics.refund_rate   = metrics.conversions > 0
    ? parseFloat(((row.total_refunds / (metrics.revenue + row.total_refunds)) * 100).toFixed(2))
    : 0;
  metrics.period_days = days;

  // Cache por 15 minutos
  await setEx(cacheKey, metrics, 15 * 60);

  return metrics;
};

// ─── METRICAS POR CAMPANHA ────────────────────────────────────────────────
const calculateByCampaign = async (userId, days = 7) => {
  const result = await query(`
    SELECT
      c.id   AS campaign_id,
      c.name AS campaign_name,
      c.external_id,
      c.status     AS campaign_status,
      c.daily_budget,
      COALESCE(SUM(am.spend), 0)                              AS total_spend,
      COALESCE(SUM(am.impressions), 0)                        AS total_impressions,
      COALESCE(SUM(am.clicks), 0)                             AS total_clicks,
      COALESCE(SUM(s.net_revenue), 0)                         AS total_revenue,
      COUNT(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL)   AS webhook_conversions,
      COALESCE(SUM(am.pixel_purchase_count), 0)               AS pixel_conversions
    FROM campaigns c
    LEFT JOIN ad_metrics am
      ON am.campaign_id = c.id
      AND am.date >= CURRENT_DATE - INTERVAL '${days - 1} days'
    LEFT JOIN sales s
      ON s.utm_campaign = c.external_id
      AND s.status = 'approved'
      AND s.user_id = c.user_id
      AND DATE(s.sale_date) >= CURRENT_DATE - INTERVAL '${days - 1} days'
    WHERE c.user_id = $1
    GROUP BY c.id, c.name, c.external_id, c.status, c.daily_budget
    ORDER BY total_spend DESC
  `, [userId]);

  return result.rows.map(row => {
    const webhook = parseInt(row.webhook_conversions || 0);
    const pixel   = parseInt(row.pixel_conversions   || 0);
    return {
      campaign_id:       row.campaign_id,
      campaign_name:     row.campaign_name,
      external_id:       row.external_id,
      status:            row.campaign_status,
      daily_budget:      parseFloat(row.daily_budget || 0),
      conversion_source: webhook > 0 ? 'webhook' : (pixel > 0 ? 'pixel' : 'none'),
      ...calculateMetrics(
        parseFloat(row.total_spend),
        parseFloat(row.total_revenue),
        dedupeConversions(webhook, pixel),
        parseInt(row.total_impressions),
        parseInt(row.total_clicks)
      )
    };
  });
};

// ─── HISTORICO DIARIO ─────────────────────────────────────────────────────
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
      COALESCE(SUM(am.spend), 0)                              AS spend,
      COALESCE(SUM(am.impressions), 0)                        AS impressions,
      COALESCE(SUM(am.clicks), 0)                             AS clicks,
      COALESCE(SUM(s.net_revenue), 0)                         AS revenue,
      COUNT(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL)   AS webhook_conversions,
      COALESCE(SUM(am.pixel_purchase_count), 0)               AS pixel_conversions
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

  return result.rows.map(row => {
    const webhook = parseInt(row.webhook_conversions || 0);
    const pixel   = parseInt(row.pixel_conversions   || 0);
    return {
      date: row.date,
      ...calculateMetrics(
        parseFloat(row.spend),
        parseFloat(row.revenue),
        dedupeConversions(webhook, pixel),
        parseInt(row.impressions),
        parseInt(row.clicks)
      )
    };
  });
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
