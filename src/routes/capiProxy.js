/**
 * IPPMIFY — Proxy CAPI para assinantes
 *
 * Endpoint público que recebe eventos do snippet JS instalado no funil do assinante
 * e os repassa server-side ao Meta CAPI usando as credenciais de pixel configuradas.
 *
 * POST /api/s/:apiKey/event
 *   Autenticação: via apiKey na URL (chave única por assinante)
 *   CORS: aberto (*) — chamado de domínios externos
 */

const express = require('express');
const { query } = require('../config/database');
const { sendEvent: sendCapi } = require('../utils/metaCapi');

const router = express.Router();

// ── CORS aberto: este endpoint é chamado do site/funil do assinante ──────────
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Eventos permitidos (evita spam / eventos inventados)
const ALLOWED_EVENTS = new Set([
  'PageView', 'ViewContent', 'InitiateCheckout', 'AddToCart',
  'Lead', 'CompleteRegistration', 'Contact', 'Subscribe',
  'Search', 'Purchase', 'CustomEvent',
]);

// ── PROXY PRINCIPAL ────────────────────────────────────────────────────────────
// POST /api/s/:apiKey/event
// Body JSON enviado pelo snippet JS do assinante
router.post('/:apiKey/event', async (req, res) => {
  // Responde 200 imediatamente — nunca bloqueia o funil do assinante
  res.json({ ok: true });

  try {
    const { apiKey } = req.params;
    if (!apiKey || apiKey.length < 32) return;

    // Buscar assinante pela chave de integração
    const result = await query(
      `SELECT id, meta_pixel_id, meta_access_token
       FROM users
       WHERE capi_api_key = $1 AND is_active = true
       LIMIT 1`,
      [apiKey]
    );

    if (!result.rows.length) return;
    const user = result.rows[0];

    // Sem pixel configurado → ignora silenciosamente
    if (!user.meta_pixel_id || !user.meta_access_token) return;

    const {
      event_name,
      event_source_url,
      event_id,
      user_data   = {},
      custom_data = {},
    } = req.body;

    if (!event_name || !ALLOWED_EVENTS.has(event_name)) return;

    // IP real atravessando o proxy do Railway
    const clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    await sendCapi({
      eventName:      event_name,
      // PII: email e phone são hasheados dentro de sendCapi
      email:          user_data.em  || null,
      phone:          user_data.ph  || null,
      // Cookies Meta: passados como estão (já são hashes/tokens do Meta)
      fbp:            user_data.fbp || null,
      fbc:            user_data.fbc || null,
      clientIp,
      userAgent:      user_data.client_user_agent || req.headers['user-agent'],
      eventSourceUrl: event_source_url || null,
      eventId:        event_id || null,
      customData:     custom_data,
      actionSource:   'website',
      pixelId:        user.meta_pixel_id,
      accessToken:    user.meta_access_token,
    });

    console.log(`[CAPI Proxy] ✓ "${event_name}" → user ${user.id}`);
  } catch (err) {
    // Nunca propaga erro — o funil do assinante não pode ser afetado
    console.error('[CAPI Proxy] Erro:', err.message);
  }
});

module.exports = router;
