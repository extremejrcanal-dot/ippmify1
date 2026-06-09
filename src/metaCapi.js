/**
 * IPPMIFY — Meta Conversions API (CAPI) helper
 *
 * Envia eventos server-side para o Meta sem depender de pixel no browser.
 * Todos os dados pessoais (email, IP) são hashados com SHA-256 antes de sair.
 *
 * Env vars necessárias no Railway:
 *   META_PIXEL_ID      — ID do pixel (ex: 1234567890)
 *   META_ACCESS_TOKEN  — Token de acesso do usuário de sistema do Business Manager
 *   APP_URL            — URL base do app (ex: https://ippmify.com)
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

// Envia um evento para o Meta CAPI — fire-and-forget, nunca propaga erros
const sendEvent = async ({
  eventName,
  email,
  phone,
  clientIp,
  userAgent,
  eventSourceUrl,
  eventId,
  customData = {},
  actionSource = 'website',
}) => {
  const pixelId     = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(`[MetaCAPI] Credenciais ausentes — evento "${eventName}" ignorado`);
    return;
  }

  const userData = {};
  if (email)     userData.em  = [sha256(email)];
  if (phone)     userData.ph  = [sha256(phone)];
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
    console.log(`[MetaCAPI] ✓ "${eventName}" — events_received: ${result?.events_received ?? '?'}`);
  } catch (err) {
    const errData = err.response?.data?.error;
    console.error(`[MetaCAPI] ✗ "${eventName}": ${errData?.message || err.message}`);
  }
};

module.exports = { sendEvent, sha256 };
