const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const {
  generateReportPDF,
  generateWhatsAppMessage,
  sendWhatsApp,
} = require('../services/reportService');

const router = express.Router();
router.use(requireAuth);

// ─── BAIXAR PDF ────────────────────────────────────────────────────────────
// GET /api/reports/pdf?days=7
router.get('/pdf', async (req, res) => {
  try {
    const days   = parseInt(req.query.days) || 7;
    const buffer = await generateReportPDF(req.user.id, days);
    const fname  = `relatorio-ippmify-${new Date().toISOString().split('T')[0]}.pdf`;
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Content-Length':      buffer.length,
    });
    res.send(buffer);
  } catch (error) {
    console.error('[Reports] PDF:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── ENVIAR VIA WHATSAPP ───────────────────────────────────────────────────
// POST /api/reports/send-whatsapp  { days: 7 }
router.post('/send-whatsapp', async (req, res) => {
  try {
    const days       = parseInt(req.body.days) || 7;
    const userResult = await query(
      'SELECT whatsapp, whatsapp_key FROM users WHERE id=$1',
      [req.user.id]
    );
    const user = userResult.rows[0];

    if (!user?.whatsapp || !user?.whatsapp_key) {
      return res.status(400).json({
        error: 'Configure seu WhatsApp e a CallMeBot API Key nas Configurações antes de enviar.',
      });
    }

    const message = await generateWhatsAppMessage(req.user.id, days);
    await sendWhatsApp(user.whatsapp, user.whatsapp_key, message);

    res.json({ message: '✅ Relatório enviado via WhatsApp com sucesso!' });
  } catch (error) {
    console.error('[Reports] WhatsApp:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── PREVIEW DA MENSAGEM WA ────────────────────────────────────────────────
// GET /api/reports/preview?days=7
router.get('/preview', async (req, res) => {
  try {
    const days    = parseInt(req.query.days) || 7;
    const message = await generateWhatsAppMessage(req.user.id, days);
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
