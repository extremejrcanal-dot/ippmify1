/**
 * POST /api/track
 * Endpoint que recebe eventos do frontend e os repassa ao Meta CAPI server-side.
 * Requer autenticação — usa req.user.email (já validado) para o hash.
 * Fire-and-forget: sempre responde 200 imediatamente.
 */

const express = require('express');
const { sendEvent } = require('../utils/metaCapi');

const router = express.Router();

// Eventos permitidos vindos do frontend
const ALLOWED_EVENTS = new Set([
  'ViewContent',
  'InitiateCheckout',
  'Lead',
  'Search',
  'CustomEvent',
]);

router.post('/', async (req, res) => {
  // Responde imediatamente — tracking nunca atrasa a UX
  res.json({ ok: true });

  try {
    const { event_name, event_source_url, custom_data, event_id } = req.body;

    // Validação básica
    if (!event_name || !ALLOWED_EVENTS.has(event_name)) return;

    const appUrl = process.env.APP_URL || 'https://ippmify1-production.up.railway.app';

    // Extrai IP real (Railway pode usar proxy)
    const clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.ip;

    sendEvent({
      eventName:      event_name,
      email:          req.user?.email,
      clientIp,
      userAgent:      req.headers['user-agent'],
      eventSourceUrl: event_source_url || appUrl,
      eventId:        event_id,
      customData:     custom_data || {},
    }).catch(() => {}); // já trata internamente, mas garante sem throw

  } catch (err) {
    console.error('[Track] Erro interno:', err.message);
  }
});

module.exports = router;
