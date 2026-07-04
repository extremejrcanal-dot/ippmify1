const express = require('express');
const { query } = require('../config/database');
const { sendEvent } = require('../utils/metaCapi');

const router = express.Router();
const APP_URL = process.env.APP_URL || 'https://ippmify1-production.up.railway.app';

// ═══════════════════════════════════════════════════════════════════════════
// KIRVANO — GERENCIAR ASSINATURAS DO IPPMIFY
// POST /api/webhook/kirvano
// ═══════════════════════════════════════════════════════════════════════════

function verifyKirvanoToken(req) {
  const secret = process.env.KIRVANO_WEBHOOK_TOKEN;
  if (!secret) return true;
  const h1 = req.headers['x-kirvano-token'];
  const h2 = req.headers['authorization']?.replace('Bearer ', '');
  const bodyToken = req.body?.token;
  return h1 === secret || h2 === secret || bodyToken === secret;
}
function extractKirvanoEmail(body) {
  return body?.data?.buyer?.email || body?.data?.customer?.email ||
    body?.buyer?.email || body?.customer?.email ||
    body?.data?.email || body?.email || null;
}
function extractKirvanoSubscriberId(body) {
  return body?.data?.subscription?.id || body?.data?.id ||
    body?.subscription?.id || body?.id || null;
}
const KIRVANO_ACTIVATE = new Set([
  'purchase_approved','purchase_complete','sale_approved',
  'subscription_activated','subscription_renewed','subscription_reactivated',
]);
const KIRVANO_CANCEL = new Set([
  'purchase_refunded','purchase_chargeback','purchase_refused',
  'sale_refunded','sale_chargeback','subscription_canceled',
  'subscription_cancelled','subscription_expired','subscription_overdue',
]);

router.post('/kirvano', async (req, res) => {
  const body  = req.body;
  const event = body?.event || body?.type || body?.status || 'unknown';
  console.log(`[Webhook/Kirvano] Evento: ${event}`);
  if (!verifyKirvanoToken(req)) {
    console.warn('[Webhook/Kirvano] Token invalido.');
    return res.status(401).json({ error: 'Token invalido' });
  }
  const email = extractKirvanoEmail(body);
  if (!email) return res.status(200).json({ ok: true, msg: 'email_not_found' });

  const userResult = await query('SELECT id, email, plan FROM users WHERE email=$1', [email.toLowerCase()]);
  if (userResult.rows.length === 0) return res.status(200).json({ ok: true, msg: 'user_not_found' });
  const user = userResult.rows[0];
  const subscriberId = extractKirvanoSubscriberId(body);

  if (KIRVANO_ACTIVATE.has(event)) {
    await query(
      `UPDATE users SET plan='active', plan_expires_at=NOW()+INTERVAL '35 days',
       cakto_subscriber_id=COALESCE($1,cakto_subscriber_id), updated_at=NOW() WHERE id=$2`,
      [subscriberId, user.id]
    );
    console.log(`[Webhook/Kirvano] Plano ATIVADO para ${email}`);
    sendEvent({
      eventName: 'Purchase', email: email.toLowerCase(),
      eventSourceUrl: APP_URL, actionSource: 'system_generated',
      customData: { value: 97, currency: 'BRL', content_name: 'IPPMIFY Mensal' },
    }).catch(() => {});
    return res.json({ ok: true, action: 'activated', email });
  }
  if (KIRVANO_CANCEL.has(event)) {
    await query(
      `UPDATE users SET plan='expired', plan_expires_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [user.id]
    );
    console.log(`[Webhook/Kirvano] Plano CANCELADO para ${email}`);
    return res.json({ ok: true, action: 'cancelled', email });
  }
  return res.json({ ok: true, action: 'ignored', event });
});

router.post('/kirvano/test', async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════════════════
// CAKTO — COMPATIBILIDADE DURANTE MIGRACAO
// POST /api/webhook/cakto
// ═══════════════════════════════════════════════════════════════════════════

function verifyCaktoToken(req) {
  const secret = process.env.CAKTO_WEBHOOK_TOKEN;
  if (!secret) return true;
  const headerToken = req.headers['authorization']?.replace('Bearer ', '');
  const bodyToken   = req.body?.token;
  return headerToken === secret || bodyToken === secret;
}
function extractCaktoEmail(body) {
  return body?.data?.customer?.email || body?.customer?.email ||
    body?.email || body?.data?.email || null;
}
function extractCaktoSubscriberId(body) {
  return body?.data?.subscription?.id || body?.subscription?.id ||
    body?.data?.id || body?.id || null;
}
const CAKTO_ACTIVATE = new Set([
  'sale_approved','payment_approved','subscription_activated',
  'subscription_renewed','purchase_approved',
]);
const CAKTO_CANCEL = new Set([
  'sale_refunded','sale_chargeback','subscription_canceled',
  'subscription_cancelled','subscription_expired',
  'payment_refunded','purchase_refunded',
]);

router.post('/cakto', async (req, res) => {
  const body  = req.body;
  const event = body?.event || body?.type || 'unknown';
  console.log(`[Webhook/Cakto] Evento: ${event}`);
  if (!verifyCaktoToken(req)) return res.status(401).json({ error: 'Token invalido' });
  const email = extractCaktoEmail(body);
  if (!email) return res.status(200).json({ ok: true, msg: 'email_not_found' });
  const userResult = await query('SELECT id, email, plan FROM users WHERE email=$1', [email.toLowerCase()]);
  if (userResult.rows.length === 0) return res.status(200).json({ ok: true, msg: 'user_not_found' });
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

// ═══════════════════════════════════════════════════════════════════════════
// RASTREAMENTO DE VENDAS DOS USUARIOS — UTM TRACKING
// Recebe vendas de Hotmart, Kiwify, Eduzz, Monetizze, Braip, PerfectPay, Ticto
// Salva na tabela sales com utm_campaign para atribuicao automatica
// POST /api/webhook/hotmart/:integrationId
// POST /api/webhook/kiwify/:integrationId
// POST /api/webhook/:platform/:integrationId  (generico)
// ═══════════════════════════════════════════════════════════════════════════

const normalizeStatus = (platform, rawStatus) => {
  const s = (rawStatus || '').toLowerCase().replace(/_/g, '');
  const maps = {
    hotmart: { approved:'approved',complete:'approved',completed:'approved',
      refunded:'refunded',cancelled:'refunded',canceled:'refunded',
      chargeback:'chargeback',
      waitingpayment:'pending',underanalisys:'pending',started:'pending',blocked:'pending' },
    kiwify:  { paid:'approved',approved:'approved',
      refunded:'refunded',refund:'refunded',chargeback:'chargeback',
      unpaid:'pending',waitingpayment:'pending',overdue:'pending' },
  };
  const m = maps[platform] || {};
  if (m[s]) return m[s];
  if (['approved','paid','complete','completed','success','active'].includes(s)) return 'approved';
  if (['refunded','refund','cancelled','canceled','reversed'].includes(s)) return 'refunded';
  if (['chargeback'].includes(s)) return 'chargeback';
  return 'pending';
};

const saveSale = async (userId, integrationId, d) => {
  await query(`
    INSERT INTO sales
      (user_id, integration_id, external_id, platform, product_id, product_name,
       status, gross_revenue, platform_fee, net_revenue, currency,
       buyer_email, utm_source, utm_campaign, utm_medium, utm_content, sale_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
      status        = EXCLUDED.status,
      gross_revenue = EXCLUDED.gross_revenue,
      platform_fee  = EXCLUDED.platform_fee,
      net_revenue   = EXCLUDED.net_revenue,
      utm_source    = COALESCE(NULLIF(EXCLUDED.utm_source,''),   sales.utm_source),
      utm_campaign  = COALESCE(NULLIF(EXCLUDED.utm_campaign,''), sales.utm_campaign),
      utm_medium    = COALESCE(NULLIF(EXCLUDED.utm_medium,''),   sales.utm_medium),
      utm_content   = COALESCE(NULLIF(EXCLUDED.utm_content,''),  sales.utm_content)
  `, [
    userId, integrationId,
    String(d.externalId).slice(0,255), d.platform,
    String(d.productId||'').slice(0,255), String(d.productName||'').slice(0,500),
    d.status,
    isNaN(d.grossRevenue) ? 0 : parseFloat(d.grossRevenue),
    isNaN(d.platformFee)  ? 0 : Math.max(0, parseFloat(d.platformFee)),
    isNaN(d.netRevenue)   ? 0 : parseFloat(d.netRevenue),
    d.currency||'BRL',
    String(d.buyerEmail||'').slice(0,255),
    String(d.utmSource||'').slice(0,255),
    String(d.utmCampaign||'').slice(0,255),
    String(d.utmMedium||'').slice(0,255),
    String(d.utmContent||'').slice(0,255),
    d.saleDate ? new Date(d.saleDate) : new Date(),
  ]);
};

const getIntegration = async (integrationId, platform) => {
  const r = await query(
    `SELECT user_id, id FROM integrations WHERE id=$1 AND platform=$2 AND is_active=true`,
    [integrationId, platform]
  );
  return r.rows[0] || null;
};

// POST /api/webhook/hotmart/:integrationId
router.post('/hotmart/:integrationId', async (req, res) => {
  try {
    const int = await getIntegration(req.params.integrationId, 'hotmart');
    if (!int) return res.status(404).json({ error: 'not found' });
    const body = req.body;
    const purchase = (body.data||{}).purchase || {};
    const product  = (body.data||{}).product  || {};
    const buyer    = (body.data||{}).buyer    || {};
    const utm      = purchase.utm || {};
    const gross = parseFloat(purchase.price?.value || 0);
    const net   = parseFloat(purchase.commission?.value || gross);
    await saveSale(int.user_id, int.id, {
      platform:'hotmart', externalId: purchase.transaction || String(Date.now()),
      productId: String(product.id||''), productName: product.name||'',
      status: normalizeStatus('hotmart', purchase.status || body.event),
      grossRevenue: gross, platformFee: gross-net, netRevenue: net,
      currency: purchase.price?.currency_value||'BRL',
      buyerEmail: buyer.email||'',
      utmSource: utm.utm_source||'', utmCampaign: utm.utm_campaign||'',
      utmMedium: utm.utm_medium||'', utmContent: utm.utm_content||'',
      saleDate: purchase.approved_date || purchase.order_date || new Date(),
    });
    console.log(`[Webhook/Hotmart] ${body.event||'evento'} salvo — user ${int.user_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Webhook/Hotmart] Erro:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/webhook/kiwify/:integrationId
router.post('/kiwify/:integrationId', async (req, res) => {
  try {
    const int = await getIntegration(req.params.integrationId, 'kiwify');
    if (!int) return res.status(404).json({ error: 'not found' });
    const body  = req.body;
    const utms  = body.UTMs || body.utms || {};
    const comms = body.Commissions || {};
    const gross = parseFloat(body.amount||0) / 100;
    const net   = comms.producer_commission_amount ? parseFloat(comms.producer_commission_amount)/100 : gross;
    await saveSale(int.user_id, int.id, {
      platform:'kiwify', externalId: body.order_id || body.order_ref || String(Date.now()),
      productId: String(body.Product?.id||''), productName: body.Product?.name||'',
      status: normalizeStatus('kiwify', body.order_status),
      grossRevenue: gross, platformFee: gross-net, netRevenue: net, currency:'BRL',
      buyerEmail: body.Customer?.email||'',
      utmSource: utms.utm_source||utms.src||'', utmCampaign: utms.utm_campaign||'',
      utmMedium: utms.utm_medium||'', utmContent: utms.utm_content||'',
      saleDate: body.created_at || new Date(),
    });
    console.log(`[Webhook/Kiwify] ${body.order_status} salvo — user ${int.user_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Webhook/Kiwify] Erro:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/webhook/:platform/:integrationId  (Eduzz, Monetizze, Braip, PerfectPay, Ticto, etc.)
router.post('/:platform/:integrationId', async (req, res) => {
  const { platform, integrationId } = req.params;
  // Ignorar rotas de teste que caem aqui (kirvano/test, cakto/test ja tratados acima)
  if (integrationId === 'test') return res.status(404).json({ error: 'not found' });
  try {
    const int = await getIntegration(integrationId, platform);
    if (!int) return res.status(404).json({ error: 'not found' });
    const body = req.body;
    const utm  = body.utm || body.UTMs || body.tracking || {};
    const rawAmount = body.amount || body.value || body.price || body.gross_amount || 0;
    const gross = rawAmount > 1000 ? parseFloat(rawAmount)/100 : parseFloat(rawAmount);
    const rawNet = body.net_amount || body.net_value || body.producer_amount || body.commission || gross;
    const net   = rawNet > 1000 ? parseFloat(rawNet)/100 : parseFloat(rawNet);
    await saveSale(int.user_id, int.id, {
      platform,
      externalId:   String(body.id||body.order_id||body.transaction||Date.now()),
      productId:    String(body.product_id||body.product?.id||''),
      productName:  body.product_name||body.product?.name||body.Product?.name||'',
      status:       normalizeStatus(platform, body.status||body.order_status||body.event||'pending'),
      grossRevenue: isNaN(gross)?0:gross, platformFee: Math.max(0,(isNaN(gross)?0:gross)-(isNaN(net)?0:net)),
      netRevenue:   isNaN(net)?0:net, currency: body.currency||'BRL',
      buyerEmail:   body.email||body.buyer?.email||body.Customer?.email||body.customer?.email||'',
      utmSource:    utm.utm_source||body.utm_source||'',
      utmCampaign:  utm.utm_campaign||body.utm_campaign||'',
      utmMedium:    utm.utm_medium||body.utm_medium||'',
      utmContent:   utm.utm_content||body.utm_content||'',
      saleDate:     body.created_at||body.date||new Date(),
    });
    console.log(`[Webhook/${platform}] evento salvo — user ${int.user_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[Webhook/${platform}] Erro:`, err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
