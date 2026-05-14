const axios = require('axios');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('./encryptionService');

const META_API_VERSION = 'v20.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ─── GERAR URL DE LOGIN DO META ADS ───────────────────────────────────────
const getOAuthUrl = (userId) => {
  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  process.env.META_REDIRECT_URI,
    scope:         'ads_read,ads_management,business_management',
    response_type: 'code',
    state:         userId, // Usar userId como state para segurança
  });
  return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?${params.toString()}`;
};

// ─── TROCAR CODE POR ACCESS TOKEN ─────────────────────────────────────────
const exchangeCodeForToken = async (code) => {
  const response = await axios.get(`${META_BASE_URL}/oauth/access_token`, {
    params: {
      client_id:     process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri:  process.env.META_REDIRECT_URI,
      code,
    }
  });
  return response.data; // { access_token, token_type, expires_in }
};

// ─── BUSCAR CONTAS DE ANUNCIO DO USUARIO ──────────────────────────────────
const getAdAccounts = async (accessToken) => {
  const response = await axios.get(`${META_BASE_URL}/me/adaccounts`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,account_status,currency,timezone_name',
    }
  });
  return response.data.data || [];
};

// ─── SINCRONIZAR CAMPANHAS ─────────────────────────────────────────────────
const syncCampaigns = async (integrationId, userId, accessToken, adAccountId) => {
  console.log(`[Meta] Sincronizando campanhas da conta ${adAccountId}`);

  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/campaigns`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time',
      limit: 100,
    }
  });

  const campaigns = response.data.data || [];
  let synced = 0;

  for (const campaign of campaigns) {
    await query(`
      INSERT INTO campaigns
        (user_id, integration_id, external_id, name, status, objective,
         daily_budget, lifetime_budget, start_time, stop_time, synced_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (user_id, external_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        daily_budget = EXCLUDED.daily_budget,
        synced_at = NOW()
    `, [
      userId, integrationId,
      campaign.id, campaign.name, campaign.status, campaign.objective,
      parseFloat(campaign.daily_budget || 0) / 100,   // Meta retorna em centavos
      parseFloat(campaign.lifetime_budget || 0) / 100,
      campaign.start_time, campaign.stop_time
    ]);
    synced++;
  }

  console.log(`[Meta] ${synced} campanhas sincronizadas`);
  return synced;
};

// ─── SINCRONIZAR METRICAS DE ANUNCIOS ─────────────────────────────────────
const syncAdMetrics = async (userId, accessToken, adAccountId, daysBack = 7) => {
  console.log(`[Meta] Sincronizando metricas dos ultimos ${daysBack} dias`);

  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = new Date().toISOString().split('T')[0];

  // Buscar metricas agrupadas por campanha e dia
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,reach,cpm,ctr,cpc,actions',
      time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
      level: 'campaign',
      time_increment: 1,  // Um resultado por dia
      limit: 500,
    }
  });

  const insights = response.data.data || [];
  let synced = 0;

  for (const insight of insights) {
    // Buscar campaign_id interno
    const campResult = await query(
      'SELECT id FROM campaigns WHERE user_id = $1 AND external_id = $2',
      [userId, insight.campaign_id]
    );
    if (campResult.rows.length === 0) continue;

    const campaignId = campResult.rows[0].id;

    await query(`
      INSERT INTO ad_metrics
        (user_id, campaign_id, date, spend, impressions, clicks, cpm, ctr, cpc)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (ad_id, date) DO NOTHING
    `, [
      userId, campaignId,
      insight.date_start,
      parseFloat(insight.spend || 0),
      parseInt(insight.impressions || 0),
      parseInt(insight.clicks || 0),
      parseFloat(insight.cpm || 0),
      parseFloat(insight.ctr || 0),
      parseFloat(insight.cpc || 0),
    ]).catch(() => {
      // Ignora conflito de unique constraint
    });

    synced++;
  }

  // Atualizar ultima sincronizacao
  await query(
    'UPDATE integrations SET last_synced_at = NOW() WHERE user_id = $1 AND platform = $2',
    [userId, 'meta_ads']
  );

  console.log(`[Meta] ${synced} registros de metricas sincronizados`);
  return synced;
};

// ─── SINCRONIZACAO COMPLETA ────────────────────────────────────────────────
const runFullSync = async (userId) => {
  // Buscar integracao ativa do Meta Ads
  const intResult = await query(
    'SELECT * FROM integrations WHERE user_id = $1 AND platform = $2 AND is_active = true',
    [userId, 'meta_ads']
  );

  if (intResult.rows.length === 0) {
    console.log(`[Meta] Usuario ${userId} nao tem integracao com Meta Ads`);
    return null;
  }

  const integration = intResult.rows[0];
  const accessToken = decrypt(integration.access_token);

  if (!accessToken) {
    console.error(`[Meta] Token invalido para usuario ${userId}`);
    return null;
  }

  const adAccountId = `act_${integration.account_id}`;

  await syncCampaigns(integration.id, userId, accessToken, adAccountId);
  await syncAdMetrics(userId, accessToken, adAccountId, 7);

  return true;
};

module.exports = { getOAuthUrl, exchangeCodeForToken, getAdAccounts, syncCampaigns, syncAdMetrics, runFullSync };
