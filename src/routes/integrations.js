const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../services/encryptionService');
const { getOAuthUrl, exchangeCodeForToken, getAdAccounts, runFullSync: metaSync } = require('../services/metaAds');
const { getAccessToken, runFullSync: hotmartSync, processWebhook: hotmartWebhook } = require('../services/hotmart');
const { processWebhook: kirvanoWebhook } = require('../services/kirvano');

const router = express.Router();

// ─── LISTAR INTEGRACOES ────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, platform, account_name, is_active, last_synced_at, created_at
     FROM integrations WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ data: result.rows });
});

// ═══════════════════════════════════════════════════════════════════════════
// META ADS
// ═══════════════════════════════════════════════════════════════════════════

// Iniciar OAuth do Meta Ads
// GET /api/integrations/meta-ads/connect
router.get('/meta-ads/connect', requireAuth, (req, res) => {
  if (!process.env.META_APP_ID) {
    return res.status(400).json({ error: 'META_APP_ID nao configurado no servidor' });
  }
  const url = getOAuthUrl(req.user.id);
  res.json({ url }); // Frontend vai redirecionar para esta URL
});

// Callback do OAuth Meta Ads
// GET /api/integrations/meta-ads/callback
router.get('/meta-ads/callback', async (req, res) => {
  try {
    const { code, state: userId } = req.query;

    if (!code || !userId) {
      return res.status(400).send('Parametros invalidos');
    }

    // Trocar code por token
    const tokenData = await exchangeCodeForToken(code);
    const accessToken = tokenData.access_token;

    // Buscar contas de anuncio
    const adAccounts = await getAdAccounts(accessToken);
    if (adAccounts.length === 0) {
      return res.status(400).send('Nenhuma conta de anuncio encontrada');
    }

    // Usar a primeira conta (ou a mais relevante)
    const account = adAccounts[0];
    const accountId = account.id.replace('act_', '');

    // Salvar integracao
    await query(`
      INSERT INTO integrations
        (user_id, platform, access_token, account_id, account_name, is_active)
      VALUES ($1, 'meta_ads', $2, $3, $4, true)
      ON CONFLICT DO NOTHING
    `, [userId, encrypt(accessToken), accountId, account.name]);

    // Redirecionar para o app com sucesso
    res.redirect(`${process.env.APP_URL || ''}/?meta=connected`);

  } catch (error) {
    console.error('[Meta OAuth] Erro:', error.message);
    res.status(500).send(`Erro ao conectar Meta Ads: ${error.message}`);
  }
});

// Sincronizar Meta Ads manualmente
// POST /api/integrations/meta-ads/sync
router.post('/meta-ads/sync', requireAuth, async (req, res) => {
  try {
    const result = await metaSync(req.user.id);
    if (!result) return res.status(400).json({ error: 'Integracao com Meta Ads nao encontrada' });
    res.json({ message: 'Sincronizacao do Meta Ads concluida com sucesso!' });
  } catch (error) {
    console.error('[Meta Sync] Erro:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HOTMART
// ═══════════════════════════════════════════════════════════════════════════

// Conectar Hotmart com Client ID + Client Secret
// POST /api/integrations/hotmart/connect
router.post('/hotmart/connect', requireAuth, async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;
    if (!client_id || !client_secret) {
      return res.status(400).json({ error: 'client_id e client_secret sao obrigatorios' });
    }

    // Testar as credenciais
    const token = await getAccessToken(client_id, client_secret);
    if (!token) return res.status(400).json({ error: 'Credenciais invalidas' });

    // Salvar integracao (salvamos client_id e client_secret criptografados)
    await query(`
      INSERT INTO integrations
        (user_id, platform, access_token, refresh_token, account_name, is_active)
      VALUES ($1, 'hotmart', $2, $3, 'Hotmart', true)
      ON CONFLICT DO NOTHING
    `, [req.user.id, encrypt(client_id), encrypt(client_secret)]);

    res.json({ message: 'Hotmart conectado com sucesso!' });
  } catch (error) {
    console.error('[Hotmart] Erro ao conectar:', error.message);
    res.status(500).json({ error: 'Erro ao conectar Hotmart. Verifique suas credenciais.' });
  }
});

// Sincronizar Hotmart manualmente
// POST /api/integrations/hotmart/sync
router.post('/hotmart/sync', requireAuth, async (req, res) => {
  try {
    const result = await hotmartSync(req.user.id);
    if (!result) return res.status(400).json({ error: 'Integracao com Hotmart nao encontrada' });
    res.json({ message: 'Sincronizacao do Hotmart concluida com sucesso!' });
  } catch (error) {
    console.error('[Hotmart Sync] Erro:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Webhook do Hotmart (notificacoes em tempo real)
// POST /api/webhooks/hotmart
router.post('/webhook/hotmart', async (req, res) => {
  try {
    const hottok = req.headers['x-hotmart-hottok'];
    const payload = req.body;

    if (!payload.data) return res.sendStatus(400);

    // Buscar usuario pela integracao
    const intResult = await query(
      "SELECT user_id, id FROM integrations WHERE platform = 'hotmart' AND is_active = true LIMIT 1"
    );

    if (intResult.rows.length > 0) {
      await hotmartWebhook(intResult.rows[0].user_id, intResult.rows[0].id, payload);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('[Hotmart Webhook] Erro:', error.message);
    res.sendStatus(500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// KIWIFY
// ═══════════════════════════════════════════════════════════════════════════

// Conectar Kiwify com API Key
// POST /api/integrations/kiwify/connect
router.post('/kiwify/connect', requireAuth, async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) return res.status(400).json({ error: 'api_key e obrigatoria' });

    await query(`
      INSERT INTO integrations
        (user_id, platform, access_token, account_name, is_active)
      VALUES ($1, 'kiwify', $2, 'Kiwify', true)
      ON CONFLICT DO NOTHING
    `, [req.user.id, encrypt(api_key)]);

    res.json({ message: 'Kiwify conectado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao conectar Kiwify' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// KIRVANO
// ═══════════════════════════════════════════════════════════════════════════

// Conectar Kirvano (cria registro de integracao — sem API key)
// POST /api/integrations/kirvano/connect
router.post('/kirvano/connect', requireAuth, async (req, res) => {
  try {
    await query(`
      INSERT INTO integrations
        (user_id, platform, account_name, is_active)
      VALUES ($1, 'kirvano', 'Kirvano', true)
      ON CONFLICT DO NOTHING
    `, [req.user.id]);

    res.json({ message: 'Kirvano configurado! Agora adicione a URL do webhook no seu painel Kirvano.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao configurar Kirvano' });
  }
});

// Webhook da Kirvano (notificacoes em tempo real)
// POST /api/integrations/webhook/kirvano
router.post('/webhook/kirvano', async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.event) return res.sendStatus(400);

    console.log(`[Kirvano Webhook] Evento recebido: ${payload.event}`);

    // Buscar integracao ativa da Kirvano
    const intResult = await query(
      "SELECT user_id, id FROM integrations WHERE platform = 'kirvano' AND is_active = true LIMIT 1"
    );

    if (intResult.rows.length > 0) {
      const { user_id, id } = intResult.rows[0];
      await kirvanoWebhook(user_id, id, payload);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('[Kirvano Webhook] Erro:', error.message);
    res.sendStatus(500);
  }
});

// Remover integracao
// DELETE /api/integrations/:id
router.delete('/:id', requireAuth, async (req, res) => {
  await query(
    'UPDATE integrations SET is_active = false WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Integracao removida' });
});

module.exports = router;
