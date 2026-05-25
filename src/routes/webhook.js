const express = require('express');
const { query } = require('../config/database');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════════
// KIRVANO WEBHOOK
// POST /api/webhook/kirvano
// ═══════════════════════════════════════════════════════════════════════════════

function verifyKirvanoToken(req) {
  const secret = process.env.KIRVANO_WEBHOOK_TOKEN;
  if (!secret) return true; // dev: aceitar sem token

  // Kirvano envia o token no header x-kirvano-token ou authorization
  const h1 = req.headers['x-kirvano-token'];
  const h2 = req.headers['authorization']?.replace('Bearer ', '');
  const bodyToken = req.body?.token;

  return h1 === secret || h2 === secret || bodyToken === secret;
}

function extractKirvanoEmail(body) {
  return (
    body?.data?.buyer?.email       ||
    body?.data?.customer?.email    ||
    body?.buyer?.email             ||
    body?.customer?.email          ||
    body?.data?.email              ||
    body?.email                    ||
    null
  );
}

function extractKirvanoSubscriberId(body) {
  return (
    body?.data?.subscription?.id   ||
    body?.data?.id                 ||
    body?.subscription?.id         ||
    body?.id                       ||
    null
  );
}

// Eventos Kirvano que ATIVAM o plano
const KIRVANO_ACTIVATE = new Set([
  'purchase_approved',
  'purchase_complete',
  'sale_approved',
  'subscription_activated',
  'subscription_renewed',
  'subscription_reactivated',
]);

// Eventos Kirvano que CANCELAM o plano
const KIRVANO_CANCEL = new Set([
  'purchase_refunded',
  'purchase_chargeback',
  'purchase_refused',
  'sale_refunded',
  'sale_chargeback',
  'subscription_canceled',
  'subscription_cancelled',
  'subscription_expired',
  'subscription_overdue',
]);

router.post('/kirvano', async (req, res) => {
  const body  = req.body;
  const event = body?.event || body?.type || body?.status || 'unknown';

  console.log(`[Webhook/Kirvano] Evento: ${event}`);
  console.log('[Webhook/Kirvano] Payload:', JSON.stringify(body, null, 2));

  if (!verifyKirvanoToken(req)) {
    console.warn('[Webhook/Kirvano] Token invalido.');
    return res.status(401).json({ error: 'Token invalido' });
  }

  const email = extractKirvanoEmail(body);
  if (!email) {
    console.warn('[Webhook/Kirvano] Email nao encontrado no payload.');
    return res.status(200).json({ ok: true, msg: 'email_not_found' });
  }

  const userResult = await query(
    'SELECT id, email, plan FROM users WHERE email = $1',
    [email.toLowerCase()]
  );

  if (userResult.rows.length === 0) {
    console.log(`[Webhook/Kirvano] Usuario ${email} nao encontrado.`);
    return res.status(200).json({ ok: true, msg: 'user_not_found' });
  }

  const user = userResult.rows[0];
  const subscriberId = extractKirvanoSubscriberId(body);

  if (KIRVANO_ACTIVATE.has(event)) {
    await query(
      `UPDATE users
       SET plan = 'active',
           plan_expires_at = NOW() + INTERVAL '35 days',
           cakto_subscriber_id = COALESCE($1, cakto_subscriber_id),
           updated_at = NOW()
       WHERE id = $2`,
      [subscriberId, user.id]
    );
    console.log(`[Webhook/Kirvano] Plano ATIVADO para ${email}`);
    return res.json({ ok: true, action: 'activated', email });
  }

  if (KIRVANO_CANCEL.has(event)) {
    await query(
      `UPDATE users
       SET plan = 'expired',
           plan_expires_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );
    console.log(`[Webhook/Kirvano] Plano CANCELADO para ${email}`);
    return res.json({ ok: true, action: 'cancelled', email });
  }

  console.log(`[Webhook/Kirvano] Evento ignorado: ${event}`);
  return res.json({ ok: true, action: 'ignored', event });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT DE TESTE
// POST /api/webhook/kirvano/test?action=activate|cancel&email=xxx
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/kirvano/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const { action, email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatorio' });

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

// ═══════════════════════════════════════════════════════════════════════════════
// CAKTO WEBHOOK (mantido para compatibilidade durante migração)
// POST /api/webhook/cakto
// ═══════════════════════════════════════════════════════════════════════════════

function verifyCaktoToken(req) {
  const secret = process.env.CAKTO_WEBHOOK_TOKEN;
  if (!secret) return true;
  const headerToken = req.headers['authorization']?.replace('Bearer ', '');
  const bodyToken   = req.body?.token;
  return headerToken === secret || bodyToken === secret;
}

function extractCaktoEmail(body) {
  return (
    body?.data?.customer?.email ||
    body?.customer?.email        ||
    body?.email                  ||
    body?.data?.email            ||
    null
  );
}

function extractCaktoSubscriberId(body) {
  return (
    body?.data?.subscription?.id ||
    body?.subscription?.id       ||
    body?.data?.id               ||
    body?.id                     ||
    null
  );
}

const CAKTO_ACTIVATE = new Set([
  'sale_approved', 'payment_approved', 'subscription_activated',
  'subscription_renewed', 'purchase_approved',
]);

const CAKTO_CANCEL = new Set([
  'sale_refunded', 'sale_chargeback', 'subscription_canceled',
  'subscription_cancelled', 'subscription_expired',
  'payment_refunded', 'purchase_refunded',
]);

router.post('/cakto', async (req, res) => {
  const body  = req.body;
  const event = body?.event || body?.type || 'unknown';

  console.log(`[Webhook/Cakto] Evento: ${event}`);

  if (!verifyCaktoToken(req)) {
    return res.status(401).json({ error: 'Token invalido' });
  }

  const email = extractCaktoEmail(body);
  if (!email) return res.status(200).json({ ok: true, msg: 'email_not_found' });

  const userResult = await query(
    'SELECT id, email, plan FROM users WHERE email = $1',
    [email.toLowerCase()]
  );

  if (userResult.rows.length === 0) {
    return res.status(200).json({ ok: true, msg: 'user_not_found' });
  }

  const user = userResult.rows[0];
  const subscriberId = extractCaktoSubscriberId(body);

  if (CAKTO_ACTIVATE.has(event)) {
    await query(
      `UPDATE users SET plan='active', plan_expires_at=NOW()+INTERVAL '35 days',
       cakto_subscriber_id=COALESCE($1,cakto_subscriber_id), updated_at=NOW() WHERE id=$2`,
      [subscriberId, user.id]
    );
    console.log(`[Webhook/Cakto] Plano ATIVADO para ${email}`);
    return res.json({ ok: true, action: 'activated', email });
  }

  if (CAKTO_CANCEL.has(event)) {
    await query(
      `UPDATE users SET plan='expired', plan_expires_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [user.id]
    );
    console.log(`[Webhook/Cakto] Plano CANCELADO para ${email}`);
    return res.json({ ok: true, action: 'cancelled', email });
  }

  return res.json({ ok: true, action: 'ignored', event });
});

// Teste Cakto (compatibilidade)
router.post('/cakto/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const { action, email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatorio' });
  if (action === 'activate') {
    await query(`UPDATE users SET plan='active', plan_expires_at=NOW()+INTERVAL '35 days' WHERE email=$1`, [email.toLowerCase()]);
    return res.json({ ok: true, msg: `Plano ativado para ${email}` });
  }
  if (action === 'cancel') {
    await query(`UPDATE users SET plan='expired', plan_expires_at=NOW() WHERE email=$1`, [email.toLowerCase()]);
    return res.json({ ok: true, msg: `Plano cancelado para ${email}` });
  }
  return res.status(400).json({ error: 'action deve ser activate ou cancel' });
});

module.exports = router;
