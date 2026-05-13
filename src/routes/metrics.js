const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { calculateOverview, calculateByCampaign, calculateDailyHistory } = require('../services/metricsEngine');
const { get, setEx } = require('../config/redis');

const router = express.Router();

// Todas as rotas exigem login
router.use(requireAuth);

// ─── VISAO GERAL ───────────────────────────────────────────────────────────
// GET /api/metrics/overview?days=7
router.get('/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cacheKey = `metrics:overview:${req.user.id}:${days}d`;

    // Tentar cache primeiro
    const cached = await get(cacheKey);
    if (cached) return res.json({ data: cached, cached: true });

    const metrics = await calculateOverview(req.user.id, days);
    res.json({ data: metrics, cached: false });
  } catch (error) {
    console.error('[Metrics] Erro overview:', error.message);
    res.status(500).json({ error: 'Erro ao calcular metricas' });
  }
});

// ─── METRICAS POR CAMPANHA ─────────────────────────────────────────────────
// GET /api/metrics/campaigns?days=7
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

// ─── HISTORICO DIARIO ──────────────────────────────────────────────────────
// GET /api/metrics/history?days=30&campaign_id=xxx
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

module.exports = router;
