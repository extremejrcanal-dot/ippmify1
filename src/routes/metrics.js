const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { calculateOverview, calculateByCampaign, calculateDailyHistory } = require('../services/metricsEngine');
const { get, setEx } = require('../config/redis');

const router = express.Router();

router.use(requireAuth);

router.get('/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cacheKey = `metrics:overview:${req.user.id}:${days}d`;
    const cached = await get(cacheKey);
    if (cached) return res.json({ data: cached, cached: true });
    const metrics = await calculateOverview(req.user.id, days);
    res.json({ data: metrics, cached: false });
  } catch (error) {
    console.error('[Metrics] Erro overview:', error.message);
    res.status(500).json({ error: 'Erro ao calcular metricas' });
  }
});

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

router.get('/tree', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const userId = req.user.id;
    const { query } = require('../config/database');

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

    const campResult = await query(`
      SELECT c.id, c.name, c.status, c.external_id,
        COALESCE(SUM(am.spend), 0)::numeric       AS spend,
        COALESCE(SUM(am.impressions), 0)::integer AS impressions,
        COALESCE(SUM(am.clicks), 0)::integer      AS clicks,
        COALESCE(AVG(am.cpm), 0)::numeric         AS cpm,
        COALESCE(AVG(am.ctr), 0)::numeric         AS ctr
      FROM campaigns c
      LEFT JOIN ad_metrics am ON am.campaign_id = c.id
        AND am.date >= CURRENT_DATE - $2::integer
      WHERE c.user_id = $1
      GROUP BY c.id, c.name, c.status, c.external_id
      ORDER BY spend DESC
    `, [userId, days]);

    const adSetResult = await query(`
      SELECT ads.id, ads.name, ads.status, ads.campaign_id, ads.external_id,
        COALESCE(SUM(asm.spend), 0)::numeric       AS spend,
        COALESCE(SUM(asm.impressions), 0)::integer AS impressions,
        COALESCE(SUM(asm.clicks), 0)::integer      AS clicks,
        COALESCE(AVG(asm.cpm), 0)::numeric         AS cpm,
        COALESCE(AVG(asm.ctr), 0)::numeric         AS ctr
      FROM ad_sets ads
      LEFT JOIN ad_set_metrics asm ON asm.ad_set_id = ads.id
        AND asm.date >= CURRENT_DATE - $2::integer
      WHERE ads.user_id = $1
      GROUP BY ads.id, ads.name, ads.status, ads.campaign_id, ads.external_id
      ORDER BY spend DESC
    `, [userId, days]);

    const adsResult = await query(`
      SELECT a.id, a.name, a.status, a.campaign_id, a.ad_set_id, a.external_id,
        COALESCE(SUM(alm.spend), 0)::numeric       AS spend,
        COALESCE(SUM(alm.impressions), 0)::integer AS impressions,
        COALESCE(SUM(alm.clicks), 0)::integer      AS clicks,
        COALESCE(AVG(alm.cpm), 0)::numeric         AS cpm,
        COALESCE(AVG(alm.ctr), 0)::numeric         AS ctr
      FROM ads a
      LEFT JOIN ad_level_metrics alm ON alm.ad_id = a.id
        AND alm.date >= CURRENT_DATE - $2::integer
      WHERE a.user_id = $1
      GROUP BY a.id, a.name, a.status, a.campaign_id, a.ad_set_id, a.external_id
      ORDER BY spend DESC
    `, [userId, days]);

    const revenueBycamp = await query(`
      SELECT utm_campaign, SUM(net_revenue) AS revenue, COUNT(*) AS conversions
      FROM sales
      WHERE user_id=$1 AND status='approved'
        AND sale_date >= CURRENT_DATE - $2::integer
      GROUP BY utm_campaign
    `, [userId, days]);

    const revenueByAd = await query(`
      SELECT utm_content, SUM(net_revenue) AS revenue, COUNT(*) AS conversions
      FROM sales
      WHERE user_id=$1 AND status='approved'
        AND sale_date >= CURRENT_DATE - $2::integer
      GROUP BY utm_content
    `, [userId, days]);

    const campRevMap = {};
    revenueBycamp.rows.forEach(r => { campRevMap[r.utm_campaign] = { revenue: parseFloat(r.revenue||0), conversions: parseInt(r.conversions||0) }; });

    const adRevMap = {};
    revenueByAd.rows.forEach(r => { adRevMap[r.utm_content] = { revenue: parseFloat(r.revenue||0), conversions: parseInt(r.conversions||0) }; });

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
      return {
        id: c.id, name: c.name, status: c.status, external_id: c.external_id,
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

module.exports = router;
