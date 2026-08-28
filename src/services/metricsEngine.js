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
      WITH bounds AS (
            SELECT ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '${days - 1} days')::date AS d0,
                         (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS d1
                             ),
                                 ad_totals AS (
                                       SELECT
                                               COALESCE(SUM(am.spend), 0)                  AS spend,
                                                       COALESCE(SUM(am.impressions), 0)            AS impressions,
                                                               COALESCE(SUM(am.clicks), 0)                 AS clicks,
                                                                       COALESCE(SUM(am.pixel_purchase_count), 0)   AS pixel_conv,
                                                                               COALESCE(SUM(am.pixel_purchase_value), 0)   AS pixel_revenue
                                                                                     FROM ad_metrics am, bounds b
                                                                                           WHERE am.user_id = $1
                                                                                                   AND am.date BETWEEN b.d0 AND b.d1
                                                                                                       ),
                                                                                                           sale_totals AS (
                                                                                                                 SELECT
                                                                                                                         COUNT(*) FILTER (WHERE s.status = 'approved')                          AS approved_count,
                                                                                                                                 COALESCE(SUM(s.net_revenue) FILTER (WHERE s.status = 'approved'), 0)   AS approved_revenue,
                                                                                                                                         COUNT(*) FILTER (WHERE s.status = 'pending')                           AS pending_count,
                                                                                                                                                 COALESCE(SUM(s.net_revenue) FILTER (WHERE s.status = 'pending'), 0)    AS pending_revenue,
                                                                                                                                                         COALESCE(SUM(s.gross_revenue) FILTER (WHERE s.status = 'refunded'), 0) AS total_refunds
                                                                                                                                                               FROM sales s, bounds b
                                                                                                                                                                     WHERE s.user_id = $1
                                                                                                                                                                             AND (s.sale_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN b.d0 AND b.d1
                                                                                                                                                                                 )
                                                                                                                                                                                     SELECT
                                                                                                                                                                                           at.spend            AS total_spend,
                                                                                                                                                                                                 at.impressions      AS total_impressions,
                                                                                                                                                                                                       at.clicks           AS total_clicks,
                                                                                                                                                                                                             at.pixel_conv       AS pixel_conversions,
                                                                                                                                                                                                                   at.pixel_revenue    AS pixel_revenue,
                                                                                                                                                                                                                         st.approved_count   AS sale_conversions,
                                                                                                                                                                                                                               st.approved_revenue AS sale_revenue,
                                                                                                                                                                                                                                     st.pending_count    AS pending_conversions,
                                                                                                                                                                                                                                           st.pending_revenue  AS pending_revenue,
                                                                                                                                                                                                                                                 st.total_refunds    AS total_refunds
                                                                                                                                                                                                                                                     FROM ad_totals at CROSS JOIN sale_totals st
                                                                                                                                                                                                                                                       `, [userId]);

    const row = result.rows[0] || {
          total_spend: 0, total_impressions: 0, total_clicks: 0,
          pixel_conversions: 0, pixel_revenue: 0,
          sale_conversions: 0, sale_revenue: 0,
          pending_conversions: 0, pending_revenue: 0, total_refunds: 0,
    };

    // Fonte da verdade: vendas via webhook. Pixel entra apenas como fallback
    // quando nao existe nenhuma venda registrada no periodo.
    const saleConv  = parseInt(row.sale_conversions || 0);
    const saleRev   = parseFloat(row.sale_revenue || 0);
    const pixelConv = parseInt(row.pixel_conversions || 0);
    const pixelRev  = parseFloat(row.pixel_revenue || 0);
    const useWebhook  = saleConv > 0 || saleRev > 0;
    const revenue     = useWebhook ? saleRev  : pixelRev;
    const conversions = useWebhook ? saleConv : pixelConv;

    const metrics = calculateMetrics(
          parseFloat(row.total_spend),
          revenue,
          conversions,
          parseInt(row.total_impressions),
          parseInt(row.total_clicks)
        );

    metrics.revenue_source      = useWebhook ? 'webhook' : ((pixelRev > 0 || pixelConv > 0) ? 'pixel' : 'none');
    metrics.pending_conversions = parseInt(row.pending_conversions || 0);
    metrics.pending_revenue     = parseFloat(row.pending_revenue || 0);

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
            AND am.date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '${days - 1} days'
    LEFT JOIN sales s
      ON s.utm_campaign = c.external_id
      AND s.status = 'approved'
      AND s.user_id = c.user_id
            AND DATE(s.sale_date) >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '${days - 1} days'
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
            AND am.date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '${days} days'
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
