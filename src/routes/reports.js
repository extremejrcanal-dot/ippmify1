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

// ─── CONFIGURAÇÕES DE AGENDAMENTO ──────────────────────────────────────────
// GET /api/reports/schedule
// Retorna as preferências de agendamento do usuário (report_freq, report_times, report_days)
router.get('/schedule', async (req, res) => {
  try {
    const result = await query(
      'SELECT report_freq, report_times, report_days FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0] || {};
    res.json({
      report_freq:  user.report_freq  ?? 0,
      report_times: user.report_times ?? '',   // nunca retorna null — evita crash no JS
      report_days:  user.report_days  ?? 7,
    });
  } catch (error) {
    console.error('[Reports] Schedule GET:', error.message);
    res.status(500).json({ error: 'Erro ao carregar configurações de relatório' });
  }
});

// POST /api/reports/schedule
// Salva as preferências de agendamento (report_freq, report_times, report_days)
router.post('/schedule', async (req, res) => {
  try {
    const { report_freq, report_times, report_days } = req.body;

    const sets = [];
    const vals = [];
    let idx = 1;

    if (report_freq !== undefined) {
      sets.push(`report_freq = $${idx++}`);
      vals.push(report_freq === '' || report_freq === null ? 0 : parseInt(report_freq));
    }
    if (report_times !== undefined) {
      sets.push(`report_times = $${idx++}`);
      vals.push(report_times === '' ? null : report_times);
    }
    if (report_days !== undefined) {
      sets.push(`report_days = $${idx++}`);
      vals.push(report_days === '' || report_days === null ? 7 : parseInt(report_days));
    }

    if (sets.length === 0) {
      return res.json({ message: 'Nada para atualizar' });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(req.user.id);

    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    console.log(`[Reports] Agendamento salvo para ${req.user.id}: freq=${report_freq}, times=${report_times}, days=${report_days}`);
    res.json({ message: 'Configurações de relatório salvas com sucesso!' });
  } catch (error) {
    console.error('[Reports] Schedule POST:', error.message);
    res.status(500).json({ error: 'Erro ao salvar configurações de relatório' });
  }
});

// PUT /api/reports/schedule (alias do POST para compatibilidade)
router.put('/schedule', async (req, res) => {
  try {
    const { report_freq, report_times, report_days } = req.body;

    const sets = [];
    const vals = [];
    let idx = 1;

    if (report_freq !== undefined) {
      sets.push(`report_freq = $${idx++}`);
      vals.push(report_freq === '' || report_freq === null ? 0 : parseInt(report_freq));
    }
    if (report_times !== undefined) {
      sets.push(`report_times = $${idx++}`);
      vals.push(report_times === '' ? null : report_times);
    }
    if (report_days !== undefined) {
      sets.push(`report_days = $${idx++}`);
      vals.push(report_days === '' || report_days === null ? 7 : parseInt(report_days));
    }

    if (sets.length === 0) {
      return res.json({ message: 'Nada para atualizar' });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(req.user.id);

    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    console.log(`[Reports] Agendamento atualizado para ${req.user.id}`);
    res.json({ message: 'Configurações de relatório salvas com sucesso!' });
  } catch (error) {
    console.error('[Reports] Schedule PUT:', error.message);
    res.status(500).json({ error: 'Erro ao salvar configurações de relatório' });
  }
});

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
