/**
 * IPPMIFY — Meta Conversions API (CAPI) helper — Multi-Pixel
 *
 * Suporte a múltiplos pixels por usuário.
 * Pixels configurados via /api/integrations/meta-capi/pixels
 * Dados pessoais (email, phone) hashados com SHA-256 antes de sair.
 *
 * SECURITY: este arquivo NÃO deve ser atualizado no Railway via deploy automático.
 */
const crypto = require('crypto');
const axios  = require('axios');

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

const sha256 = (value) => {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
};

// Enviar um evento para UM pixel específico
const sendEventToPixel = async (pixelId, accessToken, eventPayload) => {
  try {
    const response = await axios.post(
      `${GRAPH_URL}/${pixelId}/events`,
      { data: [eventPayload], access_token: accessToken },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`[MetaCAPI] ✓ "${eventPayload.event_name}" → pixel ${pixelId} — events_received: ${response.data?.events_received ?? '?'}`);
    return { pixelId, success: true };
  } catch (err) {
    const errData = err.response?.data?.error;
    console.error(`[MetaCAPI] ✗ "${eventPayload.event_name}" pixel ${pixelId}: ${errData?.message || err.message}`);
    return { pixelId, success: false, error: errData?.message || err.message };
  }
};

/**
 * Envia um evento para TODOS os pixels ativos do usuário.
 * Se userId é fornecido, busca os pixels do banco.
 * Se pixelId/accessToken são fornecidos diretamente, usa eles (modo legacy).
 */
const sendEvent = async ({
  eventName,
  userId,         // ID do usuário IPPMIFY (para buscar pixels do banco)
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

  // Construir payload do evento (igual para todos os pixels)
  const userData = {};
  if (email)     userData.em  = [sha256(email)];
  if (phone)     userData.ph  = [sha256(phone)];
  if (fbp)       userData.fbp = fbp;
  if (fbc)       userData.fbc = fbc;
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

  // Modo override direto (retrocompatível)
  if (pixelIdOverride && accessTokenOverride) {
    return sendEventToPixel(pixelIdOverride, accessTokenOverride, eventPayload);
  }

  // Modo multi-pixel: buscar pixels do banco
  const pixels = [];

  if (userId) {
    try {
      const { query } = require('../config/database');
      const { decrypt } = require('../services/encryptionService');
      const result = await query(
        `SELECT account_id AS pixel_id, access_token
         FROM integrations
         WHERE user_id=$1 AND platform LIKE 'meta_pixel:%' AND is_active=true`,
        [userId]
      );
      for (const row of result.rows) {
        try {
          pixels.push({ pixelId: row.pixel_id, accessToken: decrypt(row.access_token) });
        } catch (_) { /* token corrompido, pular */ }
      }
    } catch (dbErr) {
      console.warn('[MetaCAPI] Erro ao buscar pixels do banco:', dbErr.message);
    }
  }

  // Fallback para env vars se não houver pixels no banco
  if (pixels.length === 0 && process.env.META_PIXEL_ID && process.env.META_ACCESS_TOKEN) {
    pixels.push({ pixelId: process.env.META_PIXEL_ID, accessToken: process.env.META_ACCESS_TOKEN });
  }

  if (pixels.length === 0) {
    console.warn(`[MetaCAPI] Nenhum pixel configurado — evento "${eventName}" ignorado`);
    return { success: false, reason: 'no_pixels' };
  }

  // Enviar em paralelo para todos os pixels
  const results = await Promise.all(
    pixels.map(p => sendEventToPixel(p.pixelId, p.accessToken, eventPayload))
  );

  const sent = results.filter(r => r.success).length;
  console.log(`[MetaCAPI] "${eventName}" enviado para ${sent}/${pixels.length} pixel(s)`);
  return { success: sent > 0, results };
};

module.exports = { sendEvent, sha256 };
