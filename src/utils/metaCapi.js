/**
 * IPPMIFY — Meta Conversions API (CAPI) helper
 *
 * Envia eventos server-side para o Meta sem depender de pixel no browser.
 * Todos os dados pessoais (email, phone) são hashados com SHA-256 antes de sair.
 *
 * Env vars para pixel do próprio IPPMIFY:
 *   META_PIXEL_ID      — ID do pixel (ex: 1234567890)
 *   META_ACCESS_TOKEN  — Token de acesso do Business Manager
 *
 * Para rastrear eventos dos assinantes, passe pixelId e accessToken diretamente
 * no objeto de parâmetros — eles têm precedência sobre as env vars.
 */

const crypto = require('crypto');
const axios  = require('axios');

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

// SHA-256 normalize + hash
const sha256 = (value) => {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

/**
 * Envia um evento para o Meta CAPI — fire-and-forget, nunca propaga erros.
 *
 * @param {object} opts
 * @param {string}  opts.eventName         — Nome do evento (ex: 'Purchase')
 * @param {string}  [opts.email]           — Email do usuário (será hasheado)
 * @param {string}  [opts.phone]           — Telefone (será hasheado)
 * @param {string}  [opts.fbp]             — Cookie _fbp do Meta (passado como está)
 * @param {string}  [opts.fbc]             — Cookie _fbc do Meta ou fbclid (passado como está)
 * @param {string}  [opts.clientIp]        — IP do cliente
 * @param {string}  [opts.userAgent]       — User-Agent do cliente
 * @param {string}  [opts.eventSourceUrl]  — URL de origem do evento
 * @param {string}  [opts.eventId]         — ID único do evento (dedup)
 * @param {object}  [opts.customData]      — Dados extras (value, currency, etc.)
 * @param {string}  [opts.actionSource]    — 'website' | 'system_generated' | 'app'
 * @param {string}  [opts.pixelId]         — Sobrescreve META_PIXEL_ID (por assinante)
 * @param {string}  [opts.accessToken]     — Sobrescreve META_ACCESS_TOKEN (por assinante)
 */
const sendEvent = async ({
  eventName,
  email,
  phone,
  fbp,
  fbc,
  clientIp,
  userAgent,
  eventSourceUrl,
  eventId,
  customData = {},
  actionSource = 'website',
  pixelId: pixelIdOverride,
  accessToken: accessTokenOverride,
}) => {
  // Credenciais por assinante têm precedência sobre env vars do próprio IPPMIFY
  const pixelId     = pixelIdOverride     || process.env.META_PIXEL_ID;
  const accessToken = accessTokenOverride || process.env.META_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(`[MetaCAPI] Credenciais ausentes — evento "${eventName}" ignorado`);
    return;
  }

  const userData = {};
  if (email)     userData.em  = [sha256(email)];
  if (phone)     userData.ph  = [sha256(phone)];
  if (fbp)       userData.fbp = fbp;   // cookie Meta: passado como está
  if (fbc)       userData.fbc = fbc;   // cookie Meta / fbclid: passado como está
  if (clientIp)  userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;

  const eventPayload = {
    event_name:    eventName,
    event_time:    Math.floor(Date.now() / 1000),
    action_source: actionSource,
    user_data:     userData,
  };

  if (eventSourceUrl) eventPayload.event_source_url = eventSourceUrl;
  if (eventId)        eventPayload.event_id = eventId;
  if (Object.keys(customData).length > 0) eventPayload.custom_data = customData;

  try {
    const response = await axios.post(
      `${GRAPH_URL}/${pixelId}/events`,
      { data: [eventPayload], access_token: accessToken },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    );
    const result = response.data;
    console.log(`[MetaCAPI] ✓ "${eventName}" → pixel ${pixelId} — events_received: ${result?.events_received ?? '?'}`);
  } catch (err) {
    const errData = err.response?.data?.error;
    console.error(`[MetaCAPI] ✗ "${eventName}": ${errData?.message || err.message}`);
  }
};

module.exports = { sendEvent, sha256 };
