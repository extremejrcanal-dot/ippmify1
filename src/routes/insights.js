const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { generateInsights, getLastInsights } = require('../services/aiInsights');
const { sendDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');

const router = express.Router();
router.use(requireAuth);

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


// GET /api/insights/ai-status — verifica se OpenAI está configurado
router.get('/ai-status', async (req, res) => {
  const hasKey = !!(process.env.OPENAI_API_KEY);
  // Buscar último insight gerado para este usuário
  const { query } = require('../config/database');
  let lastRun = null;
  let lastModel = null;
  try {
    const r = await query(
      `SELECT created_at, model FROM insights WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (r.rows.length > 0) { lastRun = r.rows[0].created_at; lastModel = r.rows[0].model; }
  } catch(_) {}
  res.json({
    configured: hasKey,
    model: hasKey ? 'gpt-4o' : null,
    last_run: lastRun,
    last_model: lastModel,
    message: hasKey
      ? 'OpenAI configurado. Créditos serão consumidos a cada análise.'
      : 'OPENAI_API_KEY não encontrada no Railway. Acesse Variables no Railway e adicione a chave.',
  });
});

module.exports = router;
