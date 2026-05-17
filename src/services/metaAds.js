const axios = require('axios');
const { query } = require('../config/database');
const { decrypt } = require('./encryptionService');

const META_API_VERSION = 'v20.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ─── GERAR URL DE LOGIN DO META ADS ───────────────────────────────────────
const getOAuthUrl = (userId) => {
  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  process.env.META_REDIRECT_URI,
    scope:         'ads_read,ads_management,business_management',
    response_type: 'code',
    state:         userId,
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
  return response.data;
};

// ─── TROCAR TOKEN DE CURTA DURACAO POR LONGA DURACAO (60 dias) ────────────
const exchangeForLongLivedToken = async (shortToken) => {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    console.log('[Meta] App ID/Secret nao configurados — mantendo token original');
    return shortToken;
  }
  try {
    const response = await axios.get(`${META_BASE_URL}/oauth/access_token`, {
      params: {
        grant_type:        'fb_exchange_token',
        client_id:         process.env.META_APP_ID,
        client_secret:     process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      }
    });
    const longToken = response.data.access_token;
    console.log('[Meta] Token de longa duracao obtido com sucesso');
    return longToken;
  } catch (err) {
    console.log('[Meta] Nao foi possivel obter token longa duracao:', err.response?.data?.error?.message || err.message);
    return shortToken; // usa o original se falhar
  }
};

// ─── BUSCAR CONTAS DE ANUNCIO ──────────────────────────────────────────────
const getAdAccounts = async (accessToken) => {
  const response = await axios.get(`${META_BASE_URL}/me/adaccounts`, {
    params: { access_token: accessToken, fields: 'id,name,account_status,currency,timezone_name' }
  });
  return response.data.data || [];
};

// ─── BUSCAR TODAS AS INTEGRACOES META ATIVAS ──────────────────────────────
const getAllIntegrations = async (userId) => {
  const result = await query(
    'SELECT * FROM integrations WHERE user_id = $1 AND platform = $2 AND is_active = true ORDER BY created_at ASC',
    [userId, 'meta_ads']
  );
  return result.rows.map(row => ({
    accessToken: decrypt(row.access_token),
    adAccountId: `act_${row.account_id}`,
    integration: row,
  }));
};

// ─── BUSCAR PRIMEIRA INTEGRACAO (compatibilidade) ─────────────────────────
const getIntegrationToken = async (userId) => {
  const integrations = await getAllIntegrations(userId);
  return integrations.length > 0 ? integrations[0] : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// SYNC NIVEL 1 — CAMPANHAS
// ═══════════════════════════════════════════════════════════════════════════

const syncCampaigns = async (integrationId, userId, accessToken, adAccountId) => {
  console.log(`[Meta] Sincronizando campanhas da conta ${adAccountId}`);
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/campaigns`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time',
      limit: 200,
    }
  });
  const campaigns = response.data.data || [];
  for (const c of campaigns) {
    await query(`
      INSERT INTO campaigns (user_id, integration_id, external_id, name, status, objective,
        daily_budget, lifetime_budget, start_time, stop_time, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (user_id, external_id) DO UPDATE SET
        name=EXCLUDED.name, status=EXCLUDED.status,
        daily_budget=EXCLUDED.daily_budget, synced_at=NOW()
    `, [userId, integrationId, c.id, c.name, c.status, c.objective,
        parseFloat(c.daily_budget||0)/100, parseFloat(c.lifetime_budget||0)/100,
        c.start_time, c.stop_time]);
  }
  console.log(`[Meta] ${campaigns.length} campanhas sincronizadas`);
  return campaigns.length;
};

// ═══════════════════════════════════════════════════════════════════════════
// SYNC NIVEL 2 — CONJUNTOS DE ANUNCIOS (Ad Sets)
// ═══════════════════════════════════════════════════════════════════════════

const syncAdSets = async (integrationId, userId, accessToken, adAccountId) => {
  console.log(`[Meta] Sincronizando conjuntos da conta ${adAccountId}`);
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/adsets`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,status,campaign_id,daily_budget,lifetime_budget',
      limit: 500,
    }
  });
  const adSets = response.data.data || [];
  let synced = 0;
  for (const adSet of adSets) {
    const campResult = await query(
      'SELECT id FROM campaigns WHERE user_id = $1 AND external_id = $2',
      [userId, adSet.campaign_id]
    );
    if (campResult.rows.length === 0) continue;
    const campaignId = campResult.rows[0].id;
    await query(`
      INSERT INTO ad_sets (user_id, integration_id, campaign_id, external_id, name, status,
        daily_budget, lifetime_budget, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (user_id, external_id) DO UPDATE SET
        name=EXCLUDED.name, status=EXCLUDED.status,
        daily_budget=EXCLUDED.daily_budget, synced_at=NOW()
    `, [userId, integrationId, campaignId, adSet.id, adSet.name, adSet.status,
        parseFloat(adSet.daily_budget||0)/100, parseFloat(adSet.lifetime_budget||0)/100]);
    synced++;
  }
  console.log(`[Meta] ${synced} conjuntos sincronizados`);
  return synced;
};

// ═══════════════════════════════════════════════════════════════════════════
// SYNC NIVEL 3 — ANUNCIOS INDIVIDUAIS
// ═══════════════════════════════════════════════════════════════════════════

const syncAds = async (integrationId, userId, accessToken, adAccountId) => {
  console.log(`[Meta] Sincronizando anuncios da conta ${adAccountId}`);
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/ads`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,status,campaign_id,adset_id,creative{id}',
      limit: 500,
    }
  });
  const ads = response.data.data || [];
  let synced = 0;
  for (const ad of ads) {
    const campResult  = await query('SELECT id FROM campaigns WHERE user_id=$1 AND external_id=$2', [userId, ad.campaign_id]);
    const adSetResult = await query('SELECT id FROM ad_sets WHERE user_id=$1 AND external_id=$2', [userId, ad.adset_id]);
    if (campResult.rows.length === 0) continue;
    await query(`
      INSERT INTO ads (user_id, integration_id, campaign_id, ad_set_id, external_id, name, status, creative_id, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (user_id, external_id) DO UPDATE SET
        name=EXCLUDED.name, status=EXCLUDED.status, synced_at=NOW()
    `, [userId, integrationId, campResult.rows[0].id, adSetResult.rows[0]?.id||null,
        ad.id, ad.name, ad.status, ad.creative?.id||null]);
    synced++;
  }
  console.log(`[Meta] ${synced} anuncios sincronizados`);
  return synced;
};

// ═══════════════════════════════════════════════════════════════════════════
// METRICAS NIVEL CAMPANHA
// ═══════════════════════════════════════════════════════════════════════════

const syncAdMetrics = async (userId, accessToken, adAccountId, integrationId, daysBack = 7) => {
  const since = new Date(); since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = new Date().toISOString().split('T')[0];
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      fields: 'campaign_id,spend,impressions,clicks,reach,cpm,ctr,cpc',
      time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
      level: 'campaign', time_increment: 1, limit: 500,
    }
  });
  const insights = response.data.data || [];
  for (const insight of insights) {
    const campResult = await query('SELECT id FROM campaigns WHERE user_id=$1 AND external_id=$2', [userId, insight.campaign_id]);
    if (campResult.rows.length === 0) continue;
    await query(`
      INSERT INTO ad_metrics (user_id, campaign_id, date, spend, impressions, clicks, cpm, ctr, cpc)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING
    `, [userId, campResult.rows[0].id, insight.date_start,
        parseFloat(insight.spend||0), parseInt(insight.impressions||0), parseInt(insight.clicks||0),
        parseFloat(insight.cpm||0), parseFloat(insight.ctr||0), parseFloat(insight.cpc||0)]).catch(()=>{});
  }
  // Atualizar timestamp desta integracao especifica
  if (integrationId) {
    await query('UPDATE integrations SET last_synced_at=NOW() WHERE id=$1', [integrationId]);
  }
  console.log(`[Meta] ${insights.length} metricas de campanha sincronizadas`);
};

// ═══════════════════════════════════════════════════════════════════════════
// METRICAS NIVEL AD SET
// ═══════════════════════════════════════════════════════════════════════════

const syncAdSetMetrics = async (userId, accessToken, adAccountId, daysBack = 7) => {
  const since = new Date(); since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = new Date().toISOString().split('T')[0];
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      fields: 'adset_id,campaign_id,spend,impressions,clicks,reach,cpm,ctr,cpc',
      time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
      level: 'adset', time_increment: 1, limit: 1000,
    }
  });
  const insights = response.data.data || [];
  for (const insight of insights) {
    const adSetResult = await query('SELECT id, campaign_id FROM ad_sets WHERE user_id=$1 AND external_id=$2', [userId, insight.adset_id]);
    if (adSetResult.rows.length === 0) continue;
    const { id: adSetId, campaign_id: campaignId } = adSetResult.rows[0];
    await query(`
      INSERT INTO ad_set_metrics (user_id, ad_set_id, campaign_id, date, spend, impressions, clicks, reach, cpm, ctr, cpc)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (ad_set_id, date) DO UPDATE SET
        spend=EXCLUDED.spend, impressions=EXCLUDED.impressions,
        clicks=EXCLUDED.clicks, cpm=EXCLUDED.cpm, ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc
    `, [userId, adSetId, campaignId, insight.date_start,
        parseFloat(insight.spend||0), parseInt(insight.impressions||0), parseInt(insight.clicks||0),
        parseInt(insight.reach||0), parseFloat(insight.cpm||0), parseFloat(insight.ctr||0), parseFloat(insight.cpc||0)]).catch(()=>{});
  }
  console.log(`[Meta] ${insights.length} metricas de conjuntos sincronizadas`);
};

// ═══════════════════════════════════════════════════════════════════════════
// METRICAS NIVEL ANUNCIO INDIVIDUAL
// ═══════════════════════════════════════════════════════════════════════════

const syncAdLevelMetrics = async (userId, accessToken, adAccountId, daysBack = 7) => {
  const since = new Date(); since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = new Date().toISOString().split('T')[0];
  const response = await axios.get(`${META_BASE_URL}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      fields: 'ad_id,adset_id,campaign_id,spend,impressions,clicks,reach,cpm,ctr,cpc',
      time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
      level: 'ad', time_increment: 1, limit: 2000,
    }
  });
  const insights = response.data.data || [];
  for (const insight of insights) {
    const adResult = await query('SELECT id, ad_set_id, campaign_id FROM ads WHERE user_id=$1 AND external_id=$2', [userId, insight.ad_id]);
    if (adResult.rows.length === 0) continue;
    const { id: adId, ad_set_id: adSetId, campaign_id: campaignId } = adResult.rows[0];
    await query(`
      INSERT INTO ad_level_metrics (user_id, ad_id, ad_set_id, campaign_id, date, spend, impressions, clicks, reach, cpm, ctr, cpc)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (ad_id, date) DO UPDATE SET
        spend=EXCLUDED.spend, impressions=EXCLUDED.impressions,
        clicks=EXCLUDED.clicks, cpm=EXCLUDED.cpm, ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc
    `, [userId, adId, adSetId, campaignId, insight.date_start,
        parseFloat(insight.spend||0), parseInt(insight.impressions||0), parseInt(insight.clicks||0),
        parseInt(insight.reach||0), parseFloat(insight.cpm||0), parseFloat(insight.ctr||0), parseFloat(insight.cpc||0)]).catch(()=>{});
  }
  console.log(`[Meta] ${insights.length} metricas de anuncios sincronizadas`);
};

// ═══════════════════════════════════════════════════════════════════════════
// ACOES AUTOMATICAS — EXECUCAO VIA API META
// ═══════════════════════════════════════════════════════════════════════════

const setEntityStatus = async (entityId, status, accessToken) => {
  await axios.post(`${META_BASE_URL}/${entityId}`, null, {
    params: { access_token: accessToken, status }
  });
  console.log(`[Meta Action] STATUS=${status}: ${entityId}`);
};

const pauseEntity = async (entityId, accessToken) => setEntityStatus(entityId, 'PAUSED', accessToken);

const updateDailyBudget = async (entityId, newBudgetReais, accessToken) => {
  const budgetCentavos = Math.round(newBudgetReais * 100);
  await axios.post(`${META_BASE_URL}/${entityId}`, null, {
    params: { access_token: accessToken, daily_budget: budgetCentavos }
  });
  console.log(`[Meta Action] BUDGET: ${entityId} → R$${newBudgetReais}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// SINCRONIZACAO DE UMA INTEGRACAO ESPECIFICA
// ═══════════════════════════════════════════════════════════════════════════

const syncOneIntegration = async (userId, integrationData) => {
  const { accessToken, adAccountId, integration } = integrationData;
  console.log(`[Meta] Sincronizando conta ${adAccountId} (${integration.account_name})`);

  await syncCampaigns(integration.id, userId, accessToken, adAccountId);
  await syncAdSets(integration.id, userId, accessToken, adAccountId);
  await syncAds(integration.id, userId, accessToken, adAccountId);
  await syncAdMetrics(userId, accessToken, adAccountId, integration.id, 7);
  await syncAdSetMetrics(userId, accessToken, adAccountId, 7);
  await syncAdLevelMetrics(userId, accessToken, adAccountId, 7);

  console.log(`[Meta] Conta ${adAccountId} sincronizada com sucesso`);
};

// ═══════════════════════════════════════════════════════════════════════════
// SINCRONIZACAO COMPLETA — TODAS AS CONTAS DO USUARIO
// ═══════════════════════════════════════════════════════════════════════════

const runFullSync = async (userId) => {
  const integrations = await getAllIntegrations(userId);
  if (integrations.length === 0) return null;

  let errors = 0;
  for (const integrationData of integrations) {
    try {
      await syncOneIntegration(userId, integrationData);
    } catch (err) {
      errors++;
      console.error(`[Meta] Erro ao sincronizar conta ${integrationData.adAccountId}:`, err.message);
      // Continua para a proxima conta mesmo com erro
    }
  }

  console.log(`[Meta] Sync completo: ${integrations.length} contas processadas, ${errors} com erro`);
  return { total: integrations.length, errors };
};

module.exports = {
  getOAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, getAdAccounts,
  getAllIntegrations, getIntegrationToken,
  syncCampaigns, syncAdSets, syncAds,
  syncAdMetrics, syncAdSetMetrics, syncAdLevelMetrics,
  setEntityStatus, pauseEntity, updateDailyBudget,
  syncOneIntegration, runFullSync,
};
