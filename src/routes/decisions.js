const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { runDecisionEngine } = require('../services/decisionEngine');
const { sendAlert, sendTestAlert } = require('../services/alertService');

const router = express.Router();
router.use(requireAuth);

// ─── LISTAR DECISOES ───────────────────────────────────────────────────────
// GET /api/decisions?limit=20&severity=7
router.get('/', async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit) || 20, 100);
    const severity = parseInt(req.query.severity) || 0;

    const result = await query(`
      SELECT
        d.id, d.type, d.severity, d.title, d.description,
        d.recommendation, d.action_type, d.data_snapshot,
        d.is_read, d.is_acted, d.triggered_at,
        c.name AS campaign_name
      FROM decisions d
      LEFT JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.user_id = $1
        AND ($2 = 0 OR d.severity >= $2)
      ORDER BY d.triggered_at DESC
      LIMIT $3
    `, [req.user.id, severity, limit]);

    res.json({ data: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('[Decisions] Erro ao listar:', error.message);
    res.status(500).json({ error: 'Erro ao buscar decisoes' });
  }
});

// ─── MARCAR COMO LIDA ──────────────────────────────────────────────────────
// PATCH /api/decisions/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    await query(
      'UPDATE decisions SET is_read = true WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Marcado como lido' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar decisao' });
  }
});

// ─── EXECUTAR MOTOR DE DECISAO MANUALMENTE ────────────────────────────────
// POST /api/decisions/run
router.post('/run', async (req, res) => {
  try {
    const result = await runDecisionEngine(req.user.id);

    // Enviar alertas para decisoes criticas
    for (const decision of result.critical) {
      await sendAlert(req.user.id, decision);
    }

    res.json({
      message: `Motor executado. ${result.all.length} decisoes geradas, ${result.critical.length} alertas enviados.`,
      decisions: result.all,
      critical_count: result.critical.length
    });
  } catch (error) {
    console.error('[Decisions] Erro ao executar motor:', error.message);
    res.status(500).json({ error: 'Erro ao executar motor de decisao' });
  }
});

// ─── TESTE DE ALERTA ───────────────────────────────────────────────────────
// POST /api/decisions/test-alert
// Body: { channel: 'whatsapp' | 'email' | 'all' }
router.post('/test-alert', async (req, res) => {
  try {
    const channel = req.body.channel || 'all';
    if (!['whatsapp', 'email', 'all'].includes(channel)) {
      return res.status(400).json({ error: 'Canal invalido. Use: whatsapp, email ou all' });
    }

    const result = await sendTestAlert(req.user.id, channel);
    res.json({
      message: `Alerta de teste enviado com sucesso para o canal: ${channel}`,
      ...result
    });
  } catch (error) {
    console.error('[Decisions] Erro ao enviar teste de alerta:', error.message);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
