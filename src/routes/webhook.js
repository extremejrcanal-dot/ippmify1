const express = require('express');
const { query } = require('../config/database');

const router = express.Router();

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Verifica o token de segurança enviado pelo Cakto.
 * Configure CAKTO_WEBHOOK_TOKEN no Railway com o mesmo valor
 * que você cadastrou no painel do Cakto em Webhooks → Token.
 */
function verifyToken(req) {
  const secret = process.env.CAKTO_WEBHOOK_TOKEN;
  if (!secret) return true; // sem token configurado = aceitar tudo (apenas em dev)

  // Cakto envia o token no header Authorization ou no body como "token"
  const headerToken = req.headers['authorization']?.replace('Bearer ', '');
  const bodyToken   = req.body?.token;

  return headerToken === secret || bodyToken === secret;
}

/**
 * Extrai o e-mail do cliente do payload do Cakto.
 * O Cakto pode variar o formato — cobrimos as principais variações.
 */
function extractEmail(body) {
  return (
    body?.data?.customer?.email ||
    body?.customer?.email        ||
    body?.email                  ||
    body?.data?.email            ||
    null
  );
}

/**
 * Extrai o ID da assinatura do payload.
 */
function extractSubscriberId(body) {
  return (
    body?.data?.subscription?.id ||
    body?.subscription?.id       ||
    body?.data?.id               ||
    body?.id                     ||
    null
  );
}

// ─── EVENTOS SUPORTADOS ──────────────────────────────────────────────────────

// Eventos que ativam o plano
const ACTIVATE_EVENTS = new Set([
  'sale_approved',
  'payment_approved',
  'subscription_activated',
  'subscription_renewed',
  'purchase_approved',
]);

// Eventos que cancelam o plano
const CANCEL_EVENTS = new Set([
  'sale_refunded',
  'sale_chargeback',
  'subscription_canceled',
  'subscription_cancelled',
  'subscription_expired',
  'payment_refunded',
  'purchase_refunded',
]);

// ─── ENDPOINT PRINCIPAL ──────────────────────────────────────────────────────
// POST /api/webhook/cakto
router.post('/cakto', async (req, res) => {
  const body  = req.body;
  const event = body?.event || body?.type || 'unknown';

  console.log(`[Webhook/Cakto] Evento recebido: ${event}`);
  console.log('[Webhook/Cakto] Payload:', JSON.stringify(body, null, 2));

  // 1. Verificar autenticidade
  if (!verifyToken(req)) {
    console.warn('[Webhook/Cakto] Token inválido — ignorando.');
    return res.status(401).json({ error: 'Token inválido' });
  }

  // 2. Extrair e-mail
  const email = extractEmail(body);
  if (!email) {
    console.warn('[Webhook/Cakto] E-mail não encontrado no payload.');
    return res.status(200).json({ ok: true, msg: 'email_not_found' }); // 200 para Cakto não retentar
  }

  // 3. Buscar usuário no banco
  const userResult = await query(
    'SELECT id, email, plan FROM users WHERE email = $1',
    [email.toLowerCase()]
  );

  if (userResult.rows.length === 0) {
    // Usuário ainda não cadastrado — vai se cadastrar depois, guardamos para referência
    console.log(`[Webhook/Cakto] Usuário ${email} não encontrado — nenhuma ação.`);
    return res.status(200).json({ ok: true, msg: 'user_not_found' });
  }

  const user = userResult.rows[0];
  const subscriberId = extractSubscriberId(body);

  // 4. Aplicar ação conforme evento
  if (ACTIVATE_EVENTS.has(event)) {
    // Ativar plano — expira em 35 dias (margem para renovação mensal)
    await query(
      `UPDATE users
       SET plan = 'active',
           plan_expires_at = NOW() + INTERVAL '35 days',
           cakto_subscriber_id = COALESCE($1, cakto_subscriber_id),
           updated_at = NOW()
       WHERE id = $2`,
      [subscriberId, user.id]
    );
    console.log(`[Webhook/Cakto] ✅ Plano ATIVADO para ${email}`);
    return res.json({ ok: true, action: 'activated', email });
  }

  if (CANCEL_EVENTS.has(event)) {
    // Cancelar — rebaixar para trial (acesso limitado) ou expired
    await query(
      `UPDATE users
       SET plan = 'expired',
           plan_expires_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );
    console.log(`[Webhook/Cakto] ⏹ Plano CANCELADO para ${email}`);
    return res.json({ ok: true, action: 'cancelled', email });
  }

  // Evento desconhecido — logar e responder OK
  console.log(`[Webhook/Cakto] Evento ignorado: ${event}`);
  return res.json({ ok: true, action: 'ignored', event });
});

// ─── ENDPOINT DE TESTE (apenas desenvolvimento) ──────────────────────────────
// POST /api/webhook/cakto/test?action=activate|cancel&email=xxx
router.post('/cakto/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const { action, email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });

  if (action === 'activate') {
    await query(
      `UPDATE users SET plan='active', plan_expires_at=NOW()+INTERVAL '35 days' WHERE email=$1`,
      [email.toLowerCase()]
    );
    return res.json({ ok: true, msg: `Plano ativado para ${email}` });
  }

  if (action === 'cancel') {
    await query(
      `UPDATE users SET plan='expired', plan_expires_at=NOW() WHERE email=$1`,
      [email.toLowerCase()]
    );
    return res.json({ ok: true, msg: `Plano cancelado para ${email}` });
  }

  return res.status(400).json({ error: 'action deve ser activate ou cancel' });
});

module.exports = router;
