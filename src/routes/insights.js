const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { generateInsights, getLastInsights } = require('../services/aiInsights');
const { sendDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');

const router = express.Router();
router.use(requireAuth);

// ─── LISTAR INSIGHTS SALVOS ────────────────────────────────────────────────
// GET /api/insights
router.get('/', async (req, res) => {
  try {
    const insights = await getLastInsights(req.user.id, 10);
    res.json({ data: insights });
  } catch (error) {
    console.error('[Insights] Erro ao listar:', error.message);
    res.status(500).json({ error: 'Erro ao buscar insights' });
  }
});

// ─── GERAR INSIGHT SOB DEMANDA ─────────────────────────────────────────────
// POST /api/insights/generate
router.post('/generate', async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 7;
    console.log(`[Insights] Gerando insight sob demanda para ${req.user.email}`);
    const insights = await generateInsights(req.user.id, days);
    res.json({ data: insights });
  } catch (error) {
    console.error('[Insights] Erro ao gerar:', error.message);
    res.status(500).json({ error: 'Erro ao gerar insights. Verifique sua chave OpenAI.' });
  }
});

// ─── ENVIAR RELATORIO DIARIO MANUALMENTE ──────────────────────────────────
// POST /api/insights/send-report
router.post('/send-report', async (req, res) => {
  try {
    const insights = await generateInsights(req.user.id, 7);
    const metrics  = await calculateOverview(req.user.id, 7);
    await sendDailyReport(req.user.id, metrics, insights);
    res.json({ message: 'Relatorio diario enviado com sucesso!' });
  } catch (error) {
    console.error('[Insights] Erro ao enviar relatorio:', error.message);
    res.status(500).json({ error: 'Erro ao enviar relatorio' });
  }
});

module.exports = router;
