const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { generateInsights } = require('../services/aiInsights');
const { calculateOverview } = require('../services/metricsEngine');
const { sendWhatsAppDailyReport } = require('../services/alertService');

const router = express.Router();
router.use(requireAuth);

// ─── GET /api/reports/schedule ─────────────────────────────────────────────
// Retorna configuracao de agendamento de relatorios do usuario
router.get('/schedule', async (req, res) => {
  try {
    const result = await query(
      'SELECT report_freq, report_times, report_days FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0] || {};
    res.json({
      report_freq:  row.report_freq  ?? 0,
      report_times: row.report_times ?? '',
      report_days:  row.report_days  ?? 7,
    });
  } catch (err) {
    console.error('[Reports] Erro ao buscar schedule:', err.message);
    res.status(500).json({ error: 'Erro ao buscar agendamento' });
  }
});

// ─── POST /api/reports/schedule ────────────────────────────────────────────
// Salva configuracao de agendamento de relatorios
router.post('/schedule', async (req, res) => {
  try {
    const { report_freq, report_times, report_days } = req.body;

    const freq  = parseInt(report_freq ?? 0);
    const days  = parseInt(report_days ?? 7);
    const times = typeof report_times === 'string' ? report_times.trim() : '';

    if (![0, 1, 2, 3].includes(freq)) {
      return res.status(400).json({ error: 'report_freq deve ser 0, 1, 2 ou 3' });
    }
    if (![1, 7, 30].includes(days)) {
      return res.status(400).json({ error: 'report_days deve ser 1, 7 ou 30' });
    }

    await query(
      `UPDATE users SET
         report_freq  = $1,
         report_times = $2,
         report_days  = $3,
         updated_at   = NOW()
       WHERE id = $4`,
      [freq, times, days, req.user.id]
    );

    res.json({
      message: 'Agendamento salvo com sucesso',
      report_freq: freq,
      report_times: times,
      report_days: days,
    });
  } catch (err) {
    console.error('[Reports] Erro ao salvar schedule:', err.message);
    res.status(500).json({ error: 'Erro ao salvar agendamento' });
  }
});

// ─── POST /api/reports/send-whatsapp ──────────────────────────────────────
// Envia relatorio imediato via WhatsApp (CallMeBot)
// Body: { days: 7 }
router.post('/send-whatsapp', async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 7;

    const userResult = await query(
      'SELECT whatsapp, whatsapp_key FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0] || {};

    if (!user.whatsapp) {
      return res.status(400).json({ error: 'Numero de WhatsApp nao configurado. Va em Configuracoes e adicione seu numero.' });
    }
    if (!user.whatsapp_key) {
      return res.status(400).json({ error: 'Chave CallMeBot nao configurada. Va em Configuracoes e adicione sua API Key.' });
    }

    const [metrics, insights] = await Promise.all([
      calculateOverview(req.user.id, days),
      generateInsights(req.user.id, days).catch(() => ({ top_action: 'Monitore suas campanhas', insights: [] })),
    ]);

    await sendWhatsAppDailyReport(req.user.id, metrics, insights);

    res.json({ message: `Relatorio dos ultimos ${days} dias enviado para o seu WhatsApp!` });
  } catch (err) {
    console.error('[Reports] Erro ao enviar WhatsApp:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar relatorio' });
  }
});

module.exports = router;
