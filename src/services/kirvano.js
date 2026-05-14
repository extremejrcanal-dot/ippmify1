const { query } = require('../config/database');

// ─── PROCESSAR WEBHOOK DA KIRVANO ─────────────────────────────────────────
const processWebhook = async (userId, integrationId, payload) => {
  const eventMap = {
    'SALE_APPROVED':   'approved',
    'SALE_COMPLETE':   'approved',
    'SALE_REFUNDED':   'refunded',
    'SALE_CHARGEBACK': 'chargeback',
    'SALE_CANCELLED':  'refunded',
    'PURCHASE_APPROVED': 'approved',
    'PURCHASE_COMPLETE': 'approved',
    'PURCHASE_REFUNDED': 'refunded',
  };

  const status = eventMap[payload.event];
  if (!status) {
    console.log(`[Kirvano] Evento ignorado: ${payload.event}`);
    return;
  }

  // Kirvano envia preco em centavos ou reais — detectar pelo valor
  let grossRevenue = parseFloat(payload.total_price || 0);
  if (grossRevenue > 10000) grossRevenue = grossRevenue / 100; // centavos → reais

  const platformFee = 0;
  const netRevenue  = grossRevenue;

  const product  = payload.products?.[0] || {};
  const customer = payload.customer || {};

  await query(`
    INSERT INTO sales
      (user_id, integration_id, external_id, platform, product_id, product_name,
       status, gross_revenue, platform_fee, net_revenue, currency,
       buyer_email, utm_source, utm_campaign, utm_medium, sale_date)
    VALUES ($1, $2, $3, 'kirvano', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
      status      = EXCLUDED.status,
      net_revenue = EXCLUDED.net_revenue,
      updated_at  = NOW()
  `, [
    userId, integrationId,
    payload.sale_id || payload.checkout_id || String(Date.now()),
    product.id?.toString() || null,
    product.name || payload.product_name || null,
    status,
    grossRevenue, platformFee, netRevenue,
    'BRL',
    customer.email || null,
    null, null, null, // UTMs nao disponiveis no webhook basico
    new Date(payload.created_at || payload.finished_at || Date.now()),
  ]);

  console.log(`[Kirvano Webhook] Venda ${payload.sale_id} processada: ${status} — R$ ${grossRevenue}`);
};

module.exports = { processWebhook };
