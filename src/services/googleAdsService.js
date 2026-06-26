const axios = require('axios');
const { query } = require('../config/database');
const { decrypt, encrypt } = require('./encryptionService');

// ─── GOOGLE ADS SERVICE ────────────────────────────────────────────────────
// Documentacao: https://developers.google.com/google-ads/api/docs/first-call/overview

const GOOGLE_TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const GOOGLE_ADS_BASE    = 'https://googleads.googleapis.com/v16';

// ─── RENOVAR ACCESS TOKEN ─────────────────────────────────────────────────
const refreshGoogleToken = async (integration) => {
  const refreshToken = decrypt(integration.refresh_token);

  const response = await axios.post(GOOGLE_TOKEN_URL, {
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });

  const { access_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000);

  // Atualizar token no banco
  await query(
    `UPDATE integrations SET
       access_token     = $1,
       token_expires_at = $2,
       updated_at       = NOW()
     WHERE id = $3`,
    [encrypt(access_token), expiresAt, integration.id]
  );

  return access_token;
};

// ─── OBTER TOKEN VALIDO ───────────────────────────────────────────────────
const getValidToken = async (integration) => {
  const now = new Date();
  const expires = integration.token_expires_at ? new Date(integration.token_expires_at) : null;

  // Renovar se faltar menos de 5 minutos para expirar
  if (!expires || expires - now < 5 * 60 * 1000) {
    return await refreshGoogleToken(integration);
  }

  return decrypt(integration.access_token);
};

// ─── LISTAR CONTAS DO GOOGLE ADS ─────────────────────────────────────────
const listGoogleAdsAccounts = async (accessToken) => {
  const response = await axios.get(
    `${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`,
    {
      headers: {
        Authorization:     `Bearer ${accessToken}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      },
    }
  );
  return response.data.resourceNames || [];
};

// ─── BUSCAR DETALHES DA CONTA ─────────────────────────────────────────────
const getAccountDetails = async (accessToken, customerId) => {
  const cid = customerId.replace('customers/', '');
  const response = await axios.post(
    `${GOOGLE_ADS_BASE}/customers/${cid}/googleAds:searchStream`,
    {
      query: `SELECT customer.id, customer.descriptive_name, customer.currency_code
              FROM customer LIMIT 1`,
    },
    {
      headers: {
        Authorization:      `Bearer ${accessToken}`,
        'developer-token':  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': cid,
      },
    }
  );

  const results = response.data?.[0]?.results || [];
  if (results.length === 0) return null;
  const c = results[0].customer;
  return {
    id:       String(c.id),
    name:     c.descriptiveName,
    currency: c.currencyCode,
  };
};

// ─── SINCRONIZAR CAMPANHAS ────────────────────────────────────────────────
const syncCampaigns = async (userId, integration) => {
  const accessToken = await getValidToken(integration);
  const cid = integration.account_id;

  const response = await axios.post(
    `${GOOGLE_ADS_BASE}/customers/${cid}/googleAds:searchStream`,
    {
      query: `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name
      `,
    },
    {
      headers: {
        Authorization:      `Bearer ${accessToken}`,
        'developer-token':  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': cid,
      },
    }
  );

  const results = response.data?.[0]?.results || [];
  let synced = 0;

  for (const row of results) {
    const camp = row.campaign;
    const budget = row.campaignBudget;
    const dailyBudget = budget?.amountMicros ? parseFloat(budget.amountMicros) / 1_000_000 : 0;

    await query(
      `INSERT INTO campaigns
         (user_id, integration_id, external_id, name, status, objective, daily_budget, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, external_id) DO UPDATE SET
         name        = EXCLUDED.name,
         status      = EXCLUDED.status,
         objective   = EXCLUDED.objective,
         daily_budget = EXCLUDED.daily_budget,
         synced_at   = NOW()`,
      [
        userId,
        integration.id,
        String(camp.id),
        camp.name,
        camp.status,
        camp.advertisingChannelType || 'UNKNOWN',
        dailyBudget,
      ]
    );
    synced++;
  }

  return synced;
};

// ─── SINCRONIZAR METRICAS ─────────────────────────────────────────────────
const syncMetrics = async (userId, integration, days = 7) => {
  const accessToken = await getValidToken(integration);
  const cid = integration.account_id;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const dateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');

  const response = await axios.post(
    `${GOOGLE_ADS_BASE}/customers/${cid}/googleAds:searchStream`,
    {
      query: `
        SELECT
          campaign.id,
          segments.date,
          metrics.cost_micros,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpm,
          metrics.average_cpc,
          metrics.conversions
        FROM campaign
        WHERE segments.date >= '${dateStr}'
          AND campaign.status != 'REMOVED'
      `,
    },
    {
      headers: {
        Authorization:      `Bearer ${accessToken}`,
        'developer-token':  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': cid,
      },
    }
  );

  const results = response.data?.[0]?.results || [];
  let synced = 0;

  for (const row of results) {
    const campaignExtId = String(row.campaign.id);
    const dateRaw = row.segments?.date; // formato YYYY-MM-DD
    if (!dateRaw) continue;

    // Buscar campaign_id interno
    const campResult = await query(
      'SELECT id FROM campaigns WHERE user_id = $1 AND external_id = $2',
      [userId, campaignExtId]
    );
    if (campResult.rows.length === 0) continue;
    const campaignId = campResult.rows[0].id;

    const spend       = parseFloat(row.metrics?.costMicros || 0) / 1_000_000;
    const impressions = parseInt(row.metrics?.impressions || 0);
    const clicks      = parseInt(row.metrics?.clicks || 0);
    const ctr         = parseFloat(row.metrics?.ctr || 0);
    const cpm         = parseFloat(row.metrics?.averageCpm || 0) / 1_000_000;
    const cpc         = parseFloat(row.metrics?.averageCpc || 0) / 1_000_000;

    await query(
      `INSERT INTO ad_metrics
         (user_id, campaign_id, date, spend, impressions, clicks, ctr, cpm, cpc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, campaign_id, date) DO UPDATE SET
         spend       = EXCLUDED.spend,
         impressions = EXCLUDED.impressions,
         clicks      = EXCLUDED.clicks,
         ctr         = EXCLUDED.ctr,
         cpm         = EXCLUDED.cpm,
         cpc         = EXCLUDED.cpc`,
      [userId, campaignId, dateRaw, spend, impressions, clicks, ctr, cpm, cpc]
    );
    synced++;
  }

  // Atualizar last_synced_at
  await query(
    'UPDATE integrations SET last_synced_at = NOW() WHERE id = $1',
    [integration.id]
  );

  return synced;
};

// ─── SINCRONIZACAO COMPLETA ───────────────────────────────────────────────
const syncGoogleAds = async (userId, integration) => {
  const campaigns = await syncCampaigns(userId, integration);
  const metrics   = await syncMetrics(userId, integration, 30);
  return { campaigns, metrics };
};

module.exports = {
  listGoogleAdsAccounts,
  getAccountDetails,
  syncGoogleAds,
  syncCampaigns,
  syncMetrics,
  refreshGoogleToken,
};
