const axios = require('axios');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('./encryptionService');

const HOTMART_BASE_URL = 'https://developers.hotmart.com/payments/api/v1';
const HOTMART_TOKEN_URL = 'https://api-sec-vlc.hotmart.com/security/oauth/token';

// ─── OBTER TOKEN DE ACESSO DO HOTMART ─────────────────────────────────────
const getAccessToken = async (clientId, clientSecret) => {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(HOTMART_TOKEN_URL,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    }
  );
  return response.data.access_token;
};

// ─── SINCRONIZAR VENDAS DO HOTMART ─────────────────────────────────────────
const syncSales = async (userId, integrationId, accessToken, daysBack = 7) => {
  console.log(`[Hotmart] Sincronizando vendas dos ultimos ${daysBack} dias`);

  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  let page = null;
  let totalSynced = 0;
  let hasMore = true;

  while (hasMore) {
    const params = {
      max_results: 50,
      start_date: since.getTime(),
      end_date: Date.now(),
    };
    if (page) params.page_token = page;

    const response = await axios.get(`${HOTMART_BASE_URL}/sales/history`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      params,
    });

    const sales = response.data.items || [];

    for (const sale of sales) {
      // Normalizar status
      const statusMap = {
        'APPROVED': 'approved',
        'COMPLETE': 'approved',
        'REFUNDED': 'refunded',
        'CHARGEBACK': 'chargeback',
        'CANCELLED': 'refunded',
        'EXPIRED': 'refunded',
      };

      const status = statusMap[sale.purchase?.status] || 'pending';
      const grossRevenue = parseFloat(sale.purchase?.price?.value || 0);
      const platformFee = parseFloat(sale.producer?.commission?.value || 0);
      const netRevenue = grossRevenue - platformFee;

      // Extrair UTMs do tracker
      const utmSource = sale.tracking?.source || null;
      const utmCampaign = sale.tracking?.external_code || null;
      const utmMedium = sale.tracking?.medium || null;

      await query(`
        INSERT INTO sales
          (user_id, integration_id, external_id, platform, product_id, product_name,
           status, gross_revenue, platform_fee, net_revenue, currency,
           buyer_email, utm_source, utm_campaign, utm_medium, sale_date)
        VALUES ($1, $2, $3, 'hotmart', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
          status = EXCLUDED.status,
          net_revenue = EXCLUDED.net_revenue
      `, [
        userId, integrationId,
        sale.purchase?.transaction,
        sale.product?.id?.toString(),
        sale.product?.name,
        status,
        grossRevenue, platformFee, netRevenue,
        sale.purchase?.price?.currency_value || 'BRL',
        sale.buyer?.email,
        utmSource, utmCampaign, utmMedium,
        new Date(sale.purchase?.approved_date || sale.purchase?.order_date),
      ]);

      totalSynced++;
    }

    // Paginacao
    page = response.data.page_info?.next_page_token;
    hasMore = !!page && sales.length > 0;
  }

  await query(
    'UPDATE integrations SET last_synced_at = NOW() WHERE id = $1',
    [integrationId]
  );

  console.log(`[Hotmart] ${totalSynced} vendas sincronizadas`);
  return totalSynced;
};

// ─── SINCRONIZACAO COMPLETA ────────────────────────────────────────────────
const runFullSync = async (userId) => {
  const intResult = await query(
    'SELECT * FROM integrations WHERE user_id = $1 AND platform = $2 AND is_active = true',
    [userId, 'hotmart']
  );

  if (intResult.rows.length === 0) return null;

  const integration = intResult.rows[0];
  const clientId     = decrypt(integration.access_token);
  const clientSecret = decrypt(integration.refresh_token);

  if (!clientId || !clientSecret) return null;

  // Renovar token (expira em 1h)
  const accessToken = await getAccessToken(clientId, clientSecret);
  await syncSales(userId, integration.id, accessToken, 7);

  return true;
};

// ─── PROCESSAR WEBHOOK DO HOTMART ─────────────────────────────────────────
const processWebhook = async (userId, integrationId, payload) => {
  const event = payload.event;
  const statusMap = {
    'PURCHASE_APPROVED':    'approved',
    'PURCHASE_COMPLETE':    'approved',
    'PURCHASE_REFUNDED':    'refunded',
    'PURCHASE_CHARGEBACK':  'chargeback',
    'PURCHASE_CANCELLED':   'refunded',
  };

  const status = statusMap[event];
  if (!status) return;

  const sale = payload.data;
  const grossRevenue = parseFloat(sale.purchase?.price?.value || 0);
  const platformFee  = parseFloat(sale.producer?.commission?.value || 0);
  const netRevenue   = grossRevenue - platformFee;

  await query(`
    INSERT INTO sales
      (user_id, integration_id, external_id, platform, product_id, product_name,
       status, gross_revenue, platform_fee, net_revenue, currency,
       buyer_email, utm_source, utm_campaign, utm_medium, sale_date)
    VALUES ($1, $2, $3, 'hotmart', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
      status = EXCLUDED.status,
      net_revenue = EXCLUDED.net_revenue
  `, [
    userId, integrationId,
    sale.purchase?.transaction,
    sale.product?.id?.toString(),
    sale.product?.name,
    status, grossRevenue, platformFee, netRevenue,
    sale.purchase?.price?.currency_value || 'BRL',
    sale.buyer?.email,
    sale.tracking?.source, sale.tracking?.external_code, sale.tracking?.medium,
    new Date(),
  ]);

  console.log(`[Hotmart Webhook] Venda ${sale.purchase?.transaction} processada: ${status}`);
};

module.exports = { getAccessToken, syncSales, runFullSync, processWebhook };
