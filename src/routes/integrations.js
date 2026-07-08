const express = require('express');
const axios   = require('axios');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../services/encryptionService');

// Google Ads service -- carregado opcionalmente
let syncGoogleAds = null, listGoogleAdsAccounts = null, getAccountDetails = null;
try {
  const gads = require('../services/googleAdsService');
  syncGoogleAds         = gads.syncGoogleAds;
  listGoogleAdsAccounts = gads.listGoogleAdsAccounts;
  getAccountDetails     = gads.getAccountDetails;
} catch (e) {
  console.warn('[Integrations] googleAdsService nao encontrado -- Google Ads desativado');
}

const router = express.Router();
router.use(requireAuth);

const appBaseUrl = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

const upsertIntegration = async (userId, platform, fields) => {
  const r = await query(`
    INSERT INTO integrations
      (user_id, platform, access_token, refresh_token, account_id, account_name, is_active)
    VALUES ($1,$2,$3,$4,$5,$6,true)
    ON CONFLICT (user_id, platform) DO UPDATE SET
      access_token  = COALESCE(EXCLUDED.access_token,  integrations.access_token),
      refresh_token = COALESCE(EXCLUDED.refresh_token, integrations.refresh_token),
      account_id    = COALESCE(EXCLUDED.account_id,    integrations.account_id),
      account_name  = EXCLUDED.account_name,
      is_active     = true,
      updated_at    = NOW()
    RETURNING id
  `, [userId, platform, fields.access_token||null, fields.refresh_token||null,
      fields.account_id||null, fields.account_name||platform]);
  return r.rows[0].id;
};

// GET /api/integrations
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, platform, account_id, account_name, is_active, last_synced_at, created_at,
              token_expires_at, meta
       FROM integrations WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Integrations] Erro ao listar:', err.message);
    res.status(500).json({ error: 'Erro ao buscar integracoes' });
  }
});

// GET /api/integrations/status
router.get('/status', async (req, res) => {
  try {
    const result = await query(
      `SELECT platform, is_active, account_name, last_synced_at FROM integrations WHERE user_id=$1`,
      [req.user.id]
    );
    const platforms = ['meta_ads','google_ads','hotmart','kiwify'];
    const status = {};
    platforms.forEach(p => {
      const found = result.rows.find(r => r.platform === p);
      status[p] = { connected: !!found?.is_active, account_name: found?.account_name||null, last_synced_at: found?.last_synced_at||null };
    });
    res.json({ data: status });
  } catch (err) {
    console.error('[Integrations] Erro status:', err.message);
    res.status(500).json({ error: 'Erro ao buscar status das integracoes' });
  }
});

// ============================================================
// META ADS
// ============================================================

// POST /api/integrations/meta-ads/connect-token
router.post('/meta-ads/connect-token', async (req, res) => {
  try {
    const { access_token, ad_account_id } = req.body;
    if (!access_token) return res.status(400).json({ error: 'access_token e obrigatorio' });

    let accountName = 'Meta Ads';
    let accountId   = ad_account_id || null;

    try {
      const { getAdAccounts } = require('../services/metaAds');
      const accounts = await getAdAccounts(access_token);
      if (accounts && accounts.length > 0) {
        const target = ad_account_id
          ? accounts.find(a => a.id === ad_account_id || a.account_id === ad_account_id)
          : accounts[0];
        if (target) {
          accountId   = target.id || target.account_id || ad_account_id;
          accountName = target.name || 'Conta ' + accountId;
        }
      }
    } catch (apiErr) {
      if (apiErr.response?.data?.error?.code === 190)
        return res.status(400).json({ error: 'Token invalido ou expirado. Gere um novo token no Meta Business Suite.' });
      console.warn('[Integrations] Nao foi possivel verificar contas Meta:', apiErr.message);
    }

    const r = await query(`
      INSERT INTO integrations (user_id, platform, access_token, account_id, account_name, is_active)
      VALUES ($1, 'meta_ads', $2, $3, $4, true)
      ON CONFLICT (user_id, platform) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        account_id   = COALESCE(EXCLUDED.account_id,   integrations.account_id),
        account_name = COALESCE(EXCLUDED.account_name, integrations.account_name),
        is_active    = true,
        updated_at   = NOW()
      RETURNING id
    `, [req.user.id, encrypt(access_token), accountId, accountName]);

    res.json({ message: 'Meta Ads conectado! Conta: ' + accountName, integration_id: r.rows[0].id, account_name: accountName });
  } catch (err) {
    console.error('[Integrations] Meta Ads connect-token erro:', err.message);
    res.status(500).json({ error: 'Erro ao conectar Meta Ads: ' + err.message });
  }
});

// POST /api/integrations/meta-ads/sync
router.post('/meta-ads/sync', async (req, res) => {
  try {
    const { runFullSync } = require('../services/metaAds');
    const result = await runFullSync(req.user.id);
    res.json({ message: 'Sincronizacao Meta Ads concluida!', ...result });
  } catch (err) {
    console.error('[Integrations] Meta Ads sync erro:', err.message);
    res.status(500).json({ error: 'Erro ao sincronizar Meta Ads: ' + err.message });
  }
});

// POST /api/integrations/meta-capi/setup
router.post('/meta-capi/setup', async (req, res) => {
  try {
    const { pixel_id, access_token } = req.body;
    if (!pixel_id) return res.status(400).json({ error: 'pixel_id e obrigatorio' });

    const encToken = access_token ? encrypt(access_token) : null;
    await query(
      `UPDATE users SET
         meta_pixel_id     = $1,
         meta_access_token = COALESCE($2, meta_access_token),
         updated_at        = NOW()
       WHERE id = $3`,
      [pixel_id, encToken, req.user.id]
    );
    res.json({ message: 'Meta CAPI configurado com sucesso!' });
  } catch (err) {
    console.error('[Integrations] Meta CAPI setup erro:', err.message);
    res.status(500).json({ error: 'Erro ao configurar Meta CAPI: ' + err.message });
  }
});

// ============================================================
// GOOGLE ADS
// ============================================================

router.get('/google-ads/auth-url', (req, res) => {
  if (!listGoogleAdsAccounts)
    return res.status(503).json({ error: 'Integracao Google Ads ainda nao disponivel neste servidor.' });
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REDIRECT_URI)
    return res.status(500).json({ error: 'Google Ads nao configurado. Adicione GOOGLE_CLIENT_ID e GOOGLE_REDIRECT_URI.' });
  const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const GOOGLE_SCOPES   = ['https://www.googleapis.com/auth/adwords','https://www.googleapis.com/auth/userinfo.email'].join(' ');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code', scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent', state: req.user.id,
  });
  res.json({ url: GOOGLE_AUTH_URL + '?' + params.toString() });
});

router.get('/google-ads/callback', async (req, res) => {
  try {
    const { code, state: userId, error } = req.query;
    if (error) return res.redirect('/?integration_error=' + encodeURIComponent(error));
    if (!code || !userId) return res.status(400).json({ error: 'Parametros invalidos no callback' });
    const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const tokenRes = await axios.post(GOOGLE_TOKEN_URL, {
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt  = new Date(Date.now() + expires_in * 1000);
    const accounts   = await listGoogleAdsAccounts(access_token);
    if (accounts.length === 0) return res.redirect('/?integration_error=Nenhuma conta Google Ads encontrada');
    const accountDetails = await getAccountDetails(access_token, accounts[0]);
    const accountId   = accountDetails?.id || accounts[0].replace('customers/', '');
    const accountName = accountDetails?.name || 'Conta ' + accountId;
    await query(
      `INSERT INTO integrations (user_id, platform, access_token, refresh_token, token_expires_at, account_id, account_name, is_active)
       VALUES ($1,'google_ads',$2,$3,$4,$5,$6,true)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
         token_expires_at=EXCLUDED.token_expires_at, account_id=EXCLUDED.account_id,
         account_name=EXCLUDED.account_name, is_active=true`,
      [userId, encrypt(access_token), encrypt(refresh_token), expiresAt, accountId, accountName]
    );
    res.redirect('/?integration_success=google_ads');
  } catch (err) {
    console.error('[Integrations] Erro no callback Google Ads:', err.message);
    res.redirect('/?integration_error=' + encodeURIComponent(err.message));
  }
});

router.post('/google-ads/sync', async (req, res) => {
  if (!syncGoogleAds) return res.status(503).json({ error: 'Integracao Google Ads ainda nao disponivel.' });
  try {
    const result = await query(`SELECT * FROM integrations WHERE user_id=$1 AND platform='google_ads' AND is_active=true LIMIT 1`, [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Integracao com Google Ads nao encontrada' });
    const { campaigns, metrics } = await syncGoogleAds(req.user.id, result.rows[0]);
    res.json({ message: 'Sincronizacao concluida', campaigns_synced: campaigns, metrics_synced: metrics });
  } catch (err) {
    console.error('[Integrations] Erro ao sincronizar Google Ads:', err.message);
    res.status(500).json({ error: 'Erro na sincronizacao: ' + err.message });
  }
});

// ============================================================
// CHECKOUTS / WEBHOOK
// ============================================================

router.post('/hotmart/connect', async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;
    if (!client_id || !client_secret)
      return res.status(400).json({ error: 'Client ID e Client Secret sao obrigatorios' });
    const integrationId = await upsertIntegration(req.user.id, 'hotmart', {
      access_token: encrypt(client_id), refresh_token: encrypt(client_secret),
      account_id: client_id, account_name: 'Hotmart',
    });
    const webhookUrl = appBaseUrl(req) + '/api/webhook/hotmart/' + integrationId;
    res.json({ message: 'Hotmart conectado! Configure o webhook no painel da Hotmart.', webhook_url: webhookUrl, integration_id: integrationId });
  } catch (err) {
    console.error('[Integrations] Hotmart connect erro:', err.message);
    res.status(500).json({ error: 'Erro ao conectar Hotmart' });
  }
});

router.post('/kiwify/connect', async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) return res.status(400).json({ error: 'API Key e obrigatoria' });
    const integrationId = await upsertIntegration(req.user.id, 'kiwify', {
      access_token: encrypt(api_key), account_id: 'kiwify', account_name: 'Kiwify',
    });
    const webhookUrl = appBaseUrl(req) + '/api/webhook/kiwify/' + integrationId;
    res.json({ message: 'Kiwify conectado! Configure o webhook no painel da Kiwify.', webhook_url: webhookUrl, integration_id: integrationId });
  } catch (err) {
    console.error('[Integrations] Kiwify connect erro:', err.message);
    res.status(500).json({ error: 'Erro ao conectar Kiwify' });
  }
});

// POST /api/integrations/:platform/connect (Kirvano, Eduzz, etc)
const WEBHOOK_PLATFORMS = ['kirvano','eduzz','monetizze','braip','perfectpay','ticto','yampi','appmax'];
router.post('/:platform/connect', async (req, res) => {
  const { platform } = req.params;
  if (!WEBHOOK_PLATFORMS.includes(platform))
    return res.status(400).json({ error: 'Plataforma ' + platform + ' nao suportada via este endpoint' });
  try {
    const integrationId = await upsertIntegration(req.user.id, platform, {
      account_name: platform.charAt(0).toUpperCase() + platform.slice(1),
    });
    const webhookUrl = appBaseUrl(req) + '/api/webhook/' + platform + '/' + integrationId;
    res.json({ message: platform + ' conectado! Use a URL do webhook abaixo.', webhook_url: webhookUrl, integration_id: integrationId });
  } catch (err) {
    console.error('[Integrations] ' + platform + ' connect erro:', err.message);
    res.status(500).json({ error: 'Erro ao conectar ' + platform });
  }
});

// PATCH /api/integrations/:id/toggle
router.patch('/:id/toggle', async (req, res) => {
  try {
    const result = await query(
      `UPDATE integrations SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING is_active`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Integracao nao encontrada' });
    res.json({ is_active: result.rows[0].is_active });
  } catch (err) {
    console.error('[Integrations] Toggle erro:', err.message);
    res.status(500).json({ error: 'Erro ao alternar integracao' });
  }
});

// DELETE /api/integrations/:id
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM integrations WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ message: 'Integracao removida com sucesso' });
  } catch (err) {
    console.error('[Integrations] Erro ao remover:', err.message);
    res.status(500).json({ error: 'Erro ao remover integracao' });
  }
});

module.exports = router;
