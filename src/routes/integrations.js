const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../services/encryptionService');
const { getOAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, getAdAccounts, runFullSync: metaSync } = require('../services/metaAds');
const { getAccessToken, runFullSync: hotmartSync, processWebhook: hotmartWebhook } = require('../services/hotmart');
const { processWebhook: kirvanoWebhook } = require('../services/kirvano');

const router = express.Router();

// ─── LISTAR INTEGRACOES ────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, platform, account_name, account_id, is_active, last_synced_at, created_at
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

// Conectar Meta Ads via Token Manual (multiplas contas suportadas)
// POST /api/integrations/meta-ads/connect-token
router.post('/meta-ads/connect-token', requireAuth, async (req, res) => {
  try {
    const { access_token, ad_account_id } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: 'access_token e obrigatorio' });
    }

    // Tentar trocar por token de longa duracao (60 dias)
    const longToken = await exchangeForLongLivedToken(access_token);

    // Buscar contas de anuncio para validar o token e obter nome da conta
    let accountId = ad_account_id ? ad_account_id.replace('act_', '') : null;
    let accountName = accountId ? `Conta ${accountId}` : 'Meta Ads';

    try {
      const accounts = await getAdAccounts(longToken);
      if (accounts.length > 0) {
        const account = ad_account_id
          ? accounts.find(a => a.id === `act_${accountId}` || a.id === ad_account_id) || accounts[0]
          : accounts[0];
        accountId = account.id.replace('act_', '');
        accountName = account.name;
      }
    } catch (err) {
      console.error('[Meta Token] Nao foi possivel buscar contas:', err.message);
      if (!accountId) {
        return res.status(400).json({ error: 'Token invalido ou sem permissao. Verifique se marcou ads_read e ads_management.' });
      }
    }

    if (!accountId) {
      return res.status(400).json({ error: 'Informe o Ad Account ID (ex: act_123456789)' });
    }

    // Verificar se esta conta ja esta conectada para este usuario
    const existing = await query(
      "SELECT id FROM integrations WHERE user_id=$1 AND platform='meta_ads' AND account_id=$2 AND is_active=true",
      [req.user.id, accountId]
    );

    if (existing.rows.length > 0) {
      // Atualizar token da conta existente
      await query(
        'UPDATE integrations SET access_token=$1, account_name=$2, last_synced_at=NULL WHERE id=$3',
        [encrypt(longToken), accountName, existing.rows[0].id]
      );
      return res.json({ message: `Token atualizado para: ${accountName}` });
    }

    // Inserir nova integracao (permite multiplas contas)
    await query(`
      INSERT INTO integrations (user_id, platform, access_token, account_id, account_name, is_active)
      VALUES ($1, 'meta_ads', $2, $3, $4, true)
    `, [req.user.id, encrypt(longToken), accountId, accountName]);

    res.json({ message: `Conta conectada: ${accountName}` });
  } catch (error) {
    console.error('[Meta Token] Erro:', error.message);
    res.status(500).json({ error: error.message });
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

// ═══════════════════════════════════════════════════════════════════════════
// PLATAFORMAS VIA WEBHOOK (Eduzz, Monetizze, Braip, PerfectPay, Ticto)
// ═══════════════════════════════════════════════════════════════════════════

const webhookPlatforms = [
  { slug: 'eduzz',      name: 'Eduzz' },
  { slug: 'monetizze',  name: 'Monetizze' },
  { slug: 'braip',      name: 'Braip' },
  { slug: 'perfectpay', name: 'PerfectPay' },
  { slug: 'ticto',      name: 'Ticto' },
];

for (const p of webhookPlatforms) {
  // Conectar (cria registro sem API key — usa webhook)
  router.post(`/${p.slug}/connect`, requireAuth, async (req, res) => {
    try {
      await query(
        `INSERT INTO integrations (user_id, platform, account_name, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT DO NOTHING`,
        [req.user.id, p.slug, p.name]
      );
      res.json({ message: `${p.name} configurado! Adicione a URL do webhook no painel ${p.name}.` });
    } catch (error) {
      console.error(`[${p.name}] Erro ao conectar:`, error.message);
      res.status(500).json({ error: `Erro ao configurar ${p.name}` });
    }
  });

  // Webhook receiver
  router.post(`/webhook/${p.slug}`, async (req, res) => {
    try {
      console.log(`[${p.name} Webhook] Evento recebido:`, req.body?.event || JSON.stringify(req.body).substring(0, 100));
      // TODO: processar eventos de venda e inserir em sales
      res.sendStatus(200);
    } catch (error) {
      console.error(`[${p.name} Webhook] Erro:`, error.message);
      res.sendStatus(500);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TOGGLE / REMOVER
// ═══════════════════════════════════════════════════════════════════════════

// Alternar is_active
// PATCH /api/integrations/:id/toggle
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'UPDATE integrations SET is_active = NOT is_active WHERE id = $1 AND user_id = $2 RETURNING is_active',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Integração não encontrada' });
    res.json({ is_active: result.rows[0].is_active });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alternar integração' });
  }
});

// Remover integracao
// DELETE /api/integrations/:id
router.delete('/:id', requireAuth, async (req, res) => {
  await query(
    'DELETE FROM integrations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Integracao removida' });
});

module.exports = router;
