const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../services/encryptionService');
const { getOAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, getAdAccounts, runFullSync: metaSync, pauseEntity, getIntegrationToken } = require('../services/metaAds');
const { getAccessToken, runFullSync: hotmartSync, processWebhook: hotmartWebhook } = require('../services/hotmart');
const { processWebhook: kirvanoWebhook } = require('../services/kirvano');
const { sendCallMeBot } = require('../services/alertService');
const { sendEvent: sendCapi } = require('../utils/metaCapi');

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

    // Disparar sync imediato em background (nao bloqueia a resposta)
    const userId = req.user.id;
    setImmediate(() => {
      metaSync(userId)
        .then(r => console.log(`[Meta Token] Sync imediato concluido: ${r?.total || 0} contas`))
        .catch(err => console.error('[Meta Token] Sync imediato falhou:', err.message));
    });

    res.json({ message: `Conta conectada: ${accountName}. Sincronizando dados em segundo plano...` });
  } catch (error) {
    console.error('[Meta Token] Erro:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Sincronizar Meta Ads manualmente
// POST /api/integrations/meta-ads/sync
router.post('/meta-ads/sync', requireAuth, async (req, res) => {
  // Responde imediatamente — sync roda em background para evitar timeout do Railway
  res.json({ message: 'Sincronizacao iniciada! Aguarde alguns segundos e recarregue o dashboard.' });
  setImmediate(async () => {
    try {
      const result = await metaSync(req.user.id);
      if (result) {
        console.log(`[Meta Sync] Concluido: ${result.total} contas, ${result.errors} erros`);
      } else {
        console.log('[Meta Sync] Nenhuma integracao ativa encontrada');
      }
    } catch (err) {
      console.error('[Meta Sync] Erro:', err.message);
    }
  });
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
    const payload = req.body;

    if (!payload.data) return res.sendStatus(400);

    // Buscar usuario pela integracao
    const intResult = await query(
      "SELECT user_id, id FROM integrations WHERE platform = 'hotmart' AND is_active = true LIMIT 1"
    );

    if (intResult.rows.length > 0) {
      const { user_id, id } = intResult.rows[0];
      await hotmartWebhook(user_id, id, payload);

      // ── CAPI do assinante: dispara Purchase em vendas aprovadas ──────────
      const hotmartApproved = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE', 'PURCHASE_CONFIRMED', 'PURCHASE_BILLET_PRINTED'];
      const evtName = (payload.event || payload.data?.event || '').toUpperCase();
      if (hotmartApproved.includes(evtName) || payload.data?.purchase?.status === 'APPROVED') {
        const purchase = payload.data?.purchase || {};
        const buyer    = payload.data?.buyer    || {};
        fireSubscriberCapi(user_id, {
          status:      'approved',
          gross:       parseFloat(purchase.price?.value || 0),
          currency:    purchase.price?.currency_value || 'BRL',
          buyerEmail:  buyer.email || null,
          productName: payload.data?.product?.name || null,
          platform:    'hotmart',
        }).catch(() => {});
      }
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

      // ── CAPI do assinante: dispara Purchase em vendas aprovadas ──────────
      const kirvanoApproved = new Set([
        'SALE_APPROVED','SALE_COMPLETE','SALE_CONFIRMED',
        'PURCHASE_APPROVED','PURCHASE_COMPLETE','PURCHASE_CONFIRMED',
        'AFFILIATE_SALE_APPROVED','AFFILIATE_SALE_COMPLETE','AFFILIATE_SALE_CONFIRMED',
        'AFFILIATE_PURCHASE_APPROVED','COMMISSION_APPROVED','COMMISSION_CONFIRMED',
      ]);
      if (kirvanoApproved.has((payload.event || '').toUpperCase())) {
        const customer = payload.customer || {};
        const product  = payload.products?.[0] || {};
        let gross = parseFloat(payload.total_price || 0);
        if (gross > 10000) gross = gross / 100; // centavos → reais
        fireSubscriberCapi(user_id, {
          status:      'approved',
          gross,
          currency:    'BRL',
          buyerEmail:  customer.email || null,
          productName: product.name   || payload.product_name || null,
          platform:    'kirvano',
        }).catch(() => {});
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('[Kirvano Webhook] Erro:', error.message);
    res.sendStatus(500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════════════════════

// Inserir venda na tabela sales (padrão upsert)
const insertSale = async (userId, integrationId, platform, externalId, data) => {
  const {
    status       = 'approved',
    gross        = 0,
    fee          = 0,
    net          = null,
    currency     = 'BRL',
    buyerEmail   = null,
    productName  = null,
    saleDate     = new Date(),
  } = data;

  const netRevenue = net !== null ? net : gross - fee;

  await query(`
    INSERT INTO sales
      (user_id, integration_id, external_id, platform, product_name,
       status, gross_revenue, platform_fee, net_revenue, currency,
       buyer_email, sale_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
      status       = EXCLUDED.status,
      net_revenue  = EXCLUDED.net_revenue,
      updated_at   = NOW()
  `, [
    userId, integrationId, String(externalId), platform, productName,
    status, gross, fee, netRevenue, currency,
    buyerEmail, saleDate,
  ]);
};

// Buscar integracao ativa por plataforma — usando webhook_key ou account_id para multi-tenant
const findIntegration = async (platform, webhookKey = null) => {
  if (webhookKey) {
    const r = await query(
      `SELECT id, user_id, access_token, refresh_token FROM integrations
       WHERE platform = $1 AND account_id = $2 AND is_active = true LIMIT 1`,
      [platform, webhookKey]
    );
    return r.rows[0] || null;
  }
  const r = await query(
    `SELECT id, user_id, access_token, refresh_token FROM integrations
     WHERE platform = $1 AND is_active = true LIMIT 1`,
    [platform]
  );
  return r.rows[0] || null;
};

// ─── CAPI POR ASSINANTE ───────────────────────────────────────────────────────
// Dispara um evento Purchase no pixel Meta do assinante (se ele tiver configurado).
// Fire-and-forget: nunca bloqueia nem propaga erro para o webhook principal.
const fireSubscriberCapi = async (userId, { status, gross, currency = 'BRL', buyerEmail, productName, platform } = {}) => {
  if (status !== 'approved') return; // só dispara em vendas aprovadas

  try {
    const r = await query(
      'SELECT meta_pixel_id, meta_access_token FROM users WHERE id = $1',
      [userId]
    );
    const user = r.rows[0];
    if (!user?.meta_pixel_id || !user?.meta_access_token) return; // assinante não configurou

    const customData = { currency };
    if (gross  > 0)      customData.value        = gross;
    if (productName)     customData.content_name  = productName;
    if (platform)        customData.content_type  = platform;

    await sendCapi({
      eventName:    'Purchase',
      email:        buyerEmail || undefined,
      eventId:      `purchase_${userId}_${Date.now()}`,
      actionSource: 'system_generated',  // evento vindo do webhook, sem browser
      customData,
      pixelId:      user.meta_pixel_id,
      accessToken:  user.meta_access_token,
    });
  } catch (err) {
    // Nunca deixa o CAPI quebrar o fluxo do webhook
    console.error(`[CAPI Assinante] Erro ao disparar Purchase para user ${userId}: ${err.message}`);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// EDUZZ
// ═══════════════════════════════════════════════════════════════════════════

router.post('/eduzz/connect', requireAuth, async (req, res) => {
  try {
    const { public_key } = req.body;
    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='eduzz'`, [req.user.id]);
    await query(
      `INSERT INTO integrations (user_id, platform, account_name, account_id, is_active)
       VALUES ($1, 'eduzz', 'Eduzz', $2, true)`,
      [req.user.id, public_key || null]
    );
    res.json({ message: 'Eduzz configurado! Adicione a URL do webhook no painel Eduzz.' });
  } catch (error) {
    console.error('[Eduzz] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao configurar Eduzz' });
  }
});

router.post('/webhook/eduzz', async (req, res) => {
  res.sendStatus(200); // Responde imediatamente
  try {
    const body = req.body;
    console.log('[Eduzz Webhook] Evento recebido:', body?.trans_status);

    const integ = await findIntegration('eduzz');
    if (!integ) return;

    // Eduzz envia: trans_cod, trans_status (3=pago, 8=reembolso), price_total, client_email, cus_name
    const transId = body.trans_cod || body.transaction;
    if (!transId) return;

    const statusMap = { '3': 'approved', '8': 'refunded', '1': 'pending', '4': 'cancelled' };
    const status = statusMap[String(body.trans_status)] || 'pending';

    const eduzzGross = parseFloat(body.price_total || body.price || 0);
    await insertSale(integ.user_id, integ.id, 'eduzz', transId, {
      status,
      gross: eduzzGross,
      fee:   eduzzGross * 0.05, // ~5% Eduzz fee estimado
      buyerEmail:  body.client_email || null,
      productName: body.pro_name || null,
      saleDate:    body.trans_createdate ? new Date(body.trans_createdate) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross: eduzzGross, buyerEmail: body.client_email || null, productName: body.pro_name || null, platform: 'eduzz' }).catch(() => {});

    console.log(`[Eduzz Webhook] Venda ${transId} processada: ${status}`);
  } catch (error) {
    console.error('[Eduzz Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MONETIZZE
// ═══════════════════════════════════════════════════════════════════════════

router.post('/monetizze/connect', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='monetizze'`, [req.user.id]);
    await query(`INSERT INTO integrations (user_id, platform, account_name, is_active) VALUES ($1, 'monetizze', 'Monetizze', true)`, [req.user.id]);
    res.json({ message: 'Monetizze configurado! Adicione a URL do webhook no painel Monetizze.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao configurar Monetizze' });
  }
});

router.post('/webhook/monetizze', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[Monetizze Webhook] Evento:', body?.tipoEvento?.codigo);

    const integ = await findIntegration('monetizze');
    if (!integ) return;

    const venda = body.venda;
    if (!venda) return;

    // tipoEvento.codigo: 1=pago, 2=reembolso, 3=chargeback
    const evtCode = body.tipoEvento?.codigo;
    const statusMap = { 1: 'approved', 2: 'refunded', 3: 'chargedback' };
    const status = statusMap[evtCode] || 'pending';

    const transId = venda.codigoMonetizze || venda.numero;
    if (!transId) return;

    const mzGross = parseFloat(venda.valorTotal || 0);
    await insertSale(integ.user_id, integ.id, 'monetizze', transId, {
      status,
      gross: mzGross,
      fee:   mzGross * 0.049, // ~4.9% Monetizze
      buyerEmail:  venda.comprador?.email || null,
      productName: venda.produto?.nome || null,
      saleDate:    venda.dataVenda ? new Date(venda.dataVenda) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross: mzGross, buyerEmail: venda.comprador?.email || null, productName: venda.produto?.nome || null, platform: 'monetizze' }).catch(() => {});

    console.log(`[Monetizze Webhook] Venda ${transId} processada: ${status}`);
  } catch (error) {
    console.error('[Monetizze Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BRAIP
// ═══════════════════════════════════════════════════════════════════════════

router.post('/braip/connect', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='braip'`, [req.user.id]);
    await query(`INSERT INTO integrations (user_id, platform, account_name, is_active) VALUES ($1, 'braip', 'Braip', true)`, [req.user.id]);
    res.json({ message: 'Braip configurado! Adicione a URL do webhook no painel Braip.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao configurar Braip' });
  }
});

router.post('/webhook/braip', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[Braip Webhook] Evento:', body?.status || body?.sale_status);

    const integ = await findIntegration('braip');
    if (!integ) return;

    const transId = body.transaction || body.sale_id;
    if (!transId) return;

    const rawStatus = (body.status || body.sale_status || '').toLowerCase();
    const statusMap = {
      'paid': 'approved', 'approved': 'approved', 'pago': 'approved',
      'refunded': 'refunded', 'cancelled': 'cancelled', 'chargeback': 'chargedback',
    };
    const status = statusMap[rawStatus] || 'pending';

    const braipGross = parseFloat(body.price || body.sale_amount || 0);
    const braipEmail = body.buyer_email || body.customer?.email || null;
    await insertSale(integ.user_id, integ.id, 'braip', transId, {
      status,
      gross: braipGross,
      fee:   braipGross * 0.05,
      buyerEmail:  braipEmail,
      productName: body.product_name || null,
      saleDate:    body.date_created ? new Date(body.date_created) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross: braipGross, buyerEmail: braipEmail, productName: body.product_name || null, platform: 'braip' }).catch(() => {});

    console.log(`[Braip Webhook] Venda ${transId} processada: ${status}`);
  } catch (error) {
    console.error('[Braip Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERFECTPAY
// ═══════════════════════════════════════════════════════════════════════════

router.post('/perfectpay/connect', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='perfectpay'`, [req.user.id]);
    await query(`INSERT INTO integrations (user_id, platform, account_name, is_active) VALUES ($1, 'perfectpay', 'PerfectPay', true)`, [req.user.id]);
    res.json({ message: 'PerfectPay configurado! Adicione a URL do webhook no painel PerfectPay.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao configurar PerfectPay' });
  }
});

router.post('/webhook/perfectpay', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[PerfectPay Webhook] Evento:', body?.sale_status);

    const integ = await findIntegration('perfectpay');
    if (!integ) return;

    const transId = body.sale_id || body.id;
    if (!transId) return;

    const rawStatus = (body.sale_status || '').toLowerCase();
    const statusMap = {
      'approved': 'approved', 'paid': 'approved', 'complete': 'approved',
      'refunded': 'refunded', 'cancelled': 'cancelled', 'chargeback': 'chargedback',
    };
    const status = statusMap[rawStatus] || 'pending';

    const ppGross = parseFloat(body.sale_amount || body.total || 0);
    const ppEmail = body.buyer_email || body.customer?.email || null;
    await insertSale(integ.user_id, integ.id, 'perfectpay', transId, {
      status,
      gross: ppGross,
      fee:   ppGross * 0.049,
      buyerEmail:  ppEmail,
      productName: body.product_name || null,
      saleDate:    body.created_at ? new Date(body.created_at) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross: ppGross, buyerEmail: ppEmail, productName: body.product_name || null, platform: 'perfectpay' }).catch(() => {});

    console.log(`[PerfectPay Webhook] Venda ${transId} processada: ${status}`);
  } catch (error) {
    console.error('[PerfectPay Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TICTO
// ═══════════════════════════════════════════════════════════════════════════

router.post('/ticto/connect', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='ticto'`, [req.user.id]);
    await query(`INSERT INTO integrations (user_id, platform, account_name, is_active) VALUES ($1, 'ticto', 'Ticto', true)`, [req.user.id]);
    res.json({ message: 'Ticto configurado! Adicione a URL do webhook no painel Ticto.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao configurar Ticto' });
  }
});

router.post('/webhook/ticto', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[Ticto Webhook] Evento:', body?.event);

    const integ = await findIntegration('ticto');
    if (!integ) return;

    // Ticto envia: event, order.id, order.total, order.customer.email
    const order = body.order || body;
    const transId = order.id || order.order_id;
    if (!transId) return;

    const evtStatus = (body.event || '').toLowerCase();
    const statusMap = {
      'order.paid': 'approved', 'order.approved': 'approved',
      'order.refunded': 'refunded', 'order.cancelled': 'cancelled',
      'order.chargeback': 'chargedback',
    };
    const status = statusMap[evtStatus] || 'pending';

    const tictoGross = parseFloat(order.total || order.amount || 0);
    const tictoEmail = order.customer?.email || order.buyer_email || null;
    await insertSale(integ.user_id, integ.id, 'ticto', transId, {
      status,
      gross: tictoGross,
      fee:   tictoGross * 0.05,
      buyerEmail:  tictoEmail,
      productName: order.product?.name || null,
      saleDate:    order.created_at ? new Date(order.created_at) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross: tictoGross, buyerEmail: tictoEmail, productName: order.product?.name || null, platform: 'ticto' }).catch(() => {});

    console.log(`[Ticto Webhook] Venda ${transId} processada: ${status}`);
  } catch (error) {
    console.error('[Ticto Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MERCADO PAGO (Gateway)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/mercadopago/connect', requireAuth, async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) return res.status(400).json({ error: 'access_token e obrigatorio' });

    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='mercadopago'`, [req.user.id]);
    await query(
      `INSERT INTO integrations (user_id, platform, access_token, account_name, is_active) VALUES ($1, 'mercadopago', $2, 'Mercado Pago', true)`,
      [req.user.id, encrypt(access_token)]
    );
    res.json({ message: 'Mercado Pago conectado! Configure a URL de webhook no painel MP.' });
  } catch (error) {
    console.error('[MercadoPago] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao conectar Mercado Pago' });
  }
});

router.post('/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[MercadoPago Webhook] Acao:', body?.action, '| ID:', body?.data?.id);

    // Mercado Pago envia: action, data.id
    if (!body?.data?.id || body?.action !== 'payment.updated') return;

    const paymentId = String(body.data.id);

    // Buscar integracao e ir buscar dados do pagamento via API
    const integ = await findIntegration('mercadopago');
    if (!integ) return;

    const accessToken = decrypt(integ.access_token);

    const axios = require('axios');
    const mpRes = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` }, timeout: 10000 }
    );

    const payment = mpRes.data;
    const statusMap = {
      'approved': 'approved', 'authorized': 'approved',
      'refunded': 'refunded', 'cancelled': 'cancelled',
      'charged_back': 'chargedback', 'in_process': 'pending', 'pending': 'pending',
    };

    const gross = parseFloat(payment.transaction_amount || 0);
    const fee   = parseFloat(payment.fee_details?.reduce((s, f) => s + (f.amount || 0), 0) || gross * 0.0399);

    const mpStatus = statusMap[payment.status] || 'pending';
    const mpEmail  = payment.payer?.email || null;
    await insertSale(integ.user_id, integ.id, 'mercadopago', paymentId, {
      status:      mpStatus,
      gross,
      fee,
      currency:    payment.currency_id || 'BRL',
      buyerEmail:  mpEmail,
      productName: payment.description || null,
      saleDate:    payment.date_approved ? new Date(payment.date_approved) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status: mpStatus, gross, currency: payment.currency_id || 'BRL', buyerEmail: mpEmail, productName: payment.description || null, platform: 'mercadopago' }).catch(() => {});

    console.log(`[MercadoPago Webhook] Pagamento ${paymentId} processado: ${payment.status}`);
  } catch (error) {
    console.error('[MercadoPago Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STRIPE (Gateway)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/stripe/connect', requireAuth, async (req, res) => {
  try {
    const { secret_key, webhook_secret } = req.body;
    if (!secret_key) return res.status(400).json({ error: 'secret_key e obrigatorio' });

    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='stripe'`, [req.user.id]);
    await query(
      `INSERT INTO integrations (user_id, platform, access_token, refresh_token, account_name, is_active) VALUES ($1, 'stripe', $2, $3, 'Stripe', true)`,
      [req.user.id, encrypt(secret_key), webhook_secret ? encrypt(webhook_secret) : null]
    );
    res.json({ message: 'Stripe conectado! Configure a URL de webhook no painel Stripe.' });
  } catch (error) {
    console.error('[Stripe] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao conectar Stripe' });
  }
});

router.post('/webhook/stripe', async (req, res) => {
  res.sendStatus(200);
  try {
    // Nota: verificacao de assinatura Stripe requer raw body (express.json() ja parseia)
    // Para habilitar verificacao, adicione rawBody middleware no index.js antes de express.json()
    const event = req.body;

    console.log('[Stripe Webhook] Evento:', event?.type);

    const typeMap = {
      'payment_intent.succeeded':       'approved',
      'charge.succeeded':               'approved',
      'payment_intent.payment_failed':  'cancelled',
      'charge.refunded':                'refunded',
      'charge.dispute.created':         'chargedback',
    };

    const status = typeMap[event.type];
    if (!status) return; // Ignorar eventos não mapeados

    const obj = event.data?.object;
    if (!obj) return;

    const integ = await findIntegration('stripe');
    if (!integ) return;

    const transId  = obj.id;
    const gross    = parseFloat((obj.amount || obj.amount_received || 0) / 100);
    const fee      = parseFloat((obj.application_fee_amount || 0) / 100) || gross * 0.0399;
    const currency = (obj.currency || 'brl').toUpperCase();
    const stripeEmail = obj.receipt_email || obj.customer_email || null;

    await insertSale(integ.user_id, integ.id, 'stripe', transId, {
      status,
      gross,
      fee,
      currency,
      buyerEmail:  stripeEmail,
      productName: obj.description || null,
      saleDate:    obj.created ? new Date(obj.created * 1000) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross, currency, buyerEmail: stripeEmail, productName: obj.description || null, platform: 'stripe' }).catch(() => {});

    console.log(`[Stripe Webhook] ${event.type} ${transId} processado`);
  } catch (error) {
    console.error('[Stripe Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ASAAS (Gateway)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/asaas/connect', requireAuth, async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) return res.status(400).json({ error: 'api_key e obrigatoria' });

    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='asaas'`, [req.user.id]);
    await query(
      `INSERT INTO integrations (user_id, platform, access_token, account_name, is_active) VALUES ($1, 'asaas', $2, 'Asaas', true)`,
      [req.user.id, encrypt(api_key)]
    );
    res.json({ message: 'Asaas conectado! Configure a URL de webhook no painel Asaas.' });
  } catch (error) {
    console.error('[Asaas] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao conectar Asaas' });
  }
});

router.post('/webhook/asaas', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[Asaas Webhook] Evento:', body?.event);

    const integ = await findIntegration('asaas');
    if (!integ) return;

    // Asaas envia: event, payment.id, payment.value, payment.netValue, payment.billingType
    const payment = body.payment;
    if (!payment?.id) return;

    const statusMap = {
      'PAYMENT_RECEIVED':           'approved',
      'PAYMENT_CONFIRMED':          'approved',
      'PAYMENT_OVERDUE':            'pending',
      'PAYMENT_REFUNDED':           'refunded',
      'PAYMENT_CHARGEBACK_DISPUTE': 'chargedback',
      'PAYMENT_DELETED':            'cancelled',
    };

    const status = statusMap[body.event] || 'pending';
    const gross  = parseFloat(payment.value || 0);
    const net    = parseFloat(payment.netValue || gross * 0.97);

    const asaasEmail = payment.customer?.email || null;
    await insertSale(integ.user_id, integ.id, 'asaas', payment.id, {
      status,
      gross,
      fee: gross - net,
      net,
      buyerEmail:  asaasEmail,
      productName: payment.description || null,
      saleDate:    payment.paymentDate ? new Date(payment.paymentDate) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross, buyerEmail: asaasEmail, productName: payment.description || null, platform: 'asaas' }).catch(() => {});

    console.log(`[Asaas Webhook] Pagamento ${payment.id} processado: ${status}`);
  } catch (error) {
    console.error('[Asaas Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAGAR.ME (Gateway)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/pagarme/connect', requireAuth, async (req, res) => {
  try {
    const { secret_key } = req.body;
    if (!secret_key) return res.status(400).json({ error: 'secret_key e obrigatorio' });

    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='pagarme'`, [req.user.id]);
    await query(
      `INSERT INTO integrations (user_id, platform, access_token, account_name, is_active) VALUES ($1, 'pagarme', $2, 'Pagar.me', true)`,
      [req.user.id, encrypt(secret_key)]
    );
    res.json({ message: 'Pagar.me conectado! Configure a URL de webhook no painel Pagar.me.' });
  } catch (error) {
    console.error('[Pagarme] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao conectar Pagar.me' });
  }
});

router.post('/webhook/pagarme', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[Pagarme Webhook] Tipo:', body?.type);

    const integ = await findIntegration('pagarme');
    if (!integ) return;

    // Pagar.me v5: type, data.id, data.charges[0].last_transaction.amount
    const data = body.data;
    if (!data?.id) return;

    const typeMap = {
      'order.paid':              'approved',
      'charge.paid':             'approved',
      'order.payment_failed':    'cancelled',
      'charge.refunded':         'refunded',
      'charge.chargedback':      'chargedback',
      'order.canceled':          'cancelled',
    };

    const status = typeMap[body.type] || 'pending';

    // Pegar amount do primeiro charge ou do order
    const charge = data.charges?.[0];
    const amountCents = charge?.last_transaction?.amount || data.amount || 0;
    const gross = amountCents / 100;
    const fee   = gross * 0.0399; // estimativa Pagar.me

    const buyerEmail = data.customer?.email || charge?.customer?.email || null;

    await insertSale(integ.user_id, integ.id, 'pagarme', data.id, {
      status,
      gross,
      fee,
      currency: (data.currency || 'BRL').toUpperCase(),
      buyerEmail,
      productName: data.items?.[0]?.description || null,
      saleDate:    data.created_at ? new Date(data.created_at) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross, currency: (data.currency || 'BRL').toUpperCase(), buyerEmail, productName: data.items?.[0]?.description || null, platform: 'pagarme' }).catch(() => {});

    console.log(`[Pagarme Webhook] Order ${data.id} processado: ${status}`);
  } catch (error) {
    console.error('[Pagarme Webhook] Erro:', error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAGSEGURO (Gateway)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/pagseguro/connect', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token de acesso e obrigatorio' });

    await query(`DELETE FROM integrations WHERE user_id=$1 AND platform='pagseguro'`, [req.user.id]);
    await query(
      `INSERT INTO integrations (user_id, platform, access_token, account_name, is_active) VALUES ($1, 'pagseguro', $2, 'PagSeguro', true)`,
      [req.user.id, encrypt(token)]
    );
    res.json({ message: 'PagSeguro conectado! Configure a URL de webhook (notificacoes) no painel PagSeguro.' });
  } catch (error) {
    console.error('[PagSeguro] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao conectar PagSeguro' });
  }
});

router.post('/webhook/pagseguro', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('[PagSeguro Webhook] Notificacao recebida');

    const integ = await findIntegration('pagseguro');
    if (!integ) return;

    // PagSeguro Checkout API v4 (JSON):
    // id, status, charges[0].amount.value, customer.email
    // Status: PAID, DECLINED, CANCELED, REFUNDED
    const chargeId = body.id || body.charges?.[0]?.id;
    if (!chargeId) return;

    const charge = body.charges?.[0] || body;
    const psStatus = (body.status || charge.status || '').toUpperCase();

    const statusMap = {
      'PAID': 'approved', 'AUTHORIZED': 'approved',
      'DECLINED': 'cancelled', 'CANCELED': 'cancelled',
      'REFUNDED': 'refunded', 'CHARGED_BACK': 'chargedback',
    };
    const status = statusMap[psStatus] || 'pending';

    const amountObj  = charge.amount || body.amount || {};
    const gross      = parseFloat((amountObj.value || 0) / 100);
    const fee        = gross * 0.0399;

    const psEmail = body.customer?.email || charge.customer?.email || null;
    await insertSale(integ.user_id, integ.id, 'pagseguro', chargeId, {
      status,
      gross,
      fee,
      buyerEmail:  psEmail,
      productName: body.reference_id || null,
      saleDate:    body.created_at ? new Date(body.created_at) : new Date(),
    });
    fireSubscriberCapi(integ.user_id, { status, gross, buyerEmail: psEmail, productName: body.reference_id || null, platform: 'pagseguro' }).catch(() => {});

    console.log(`[PagSeguro Webhook] Charge ${chargeId} processado: ${status}`);
  } catch (error) {
    console.error('[PagSeguro Webhook] Erro:', error.message);
  }
});

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
// Remover integracao
// DELETE /api/integrations/:id
router.delete('/:id', requireAuth, async (req, res) => {
  await query(
    'DELETE FROM integrations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Integracao removida' });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIRMACAO DE PAUSA VIA LINK (CallMeBot — sem Twilio)
// ═══════════════════════════════════════════════════════════════════════════
// O usuario recebe no WhatsApp um link como:
//   https://ippmify1-production.up.railway.app/api/integrations/confirm/UUID
// Clicar no link executa a pausa imediatamente.
// Rota publica (sem requireAuth) pois e acessada direto do WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/confirm/:token', async (req, res) => {
  const { token } = req.params;

  // Validar formato UUID para evitar SQL injection
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(token)) {
    return res.status(400).send(confirmPage('❌ Link inválido.', '', false));
  }

  try {
    // Buscar acao pendente pelo UUID (o ID e o token)
    const actionResult = await query(`
      SELECT pa.*, u.name AS user_name, u.whatsapp
      FROM pending_actions pa
      JOIN users u ON u.id = pa.user_id
      WHERE pa.id = $1
    `, [token]);

    if (!actionResult.rows.length) {
      return res.send(confirmPage('❌ Link não encontrado.', 'Este link pode já ter sido usado ou nunca existiu.', false));
    }

    const action = actionResult.rows[0];

    // Verificar se ainda e valido
    if (action.status !== 'pending_approval') {
      const msg = action.status === 'executed'
        ? '✅ Esta ação já foi executada anteriormente.'
        : '❌ Esta ação foi cancelada.';
      return res.send(confirmPage(msg, `Campanha: ${action.entity_name}`, false));
    }

    if (new Date(action.expires_at) < new Date()) {
      return res.send(confirmPage('⏰ Link expirado.', `A confirmação de "${action.entity_name}" expirou. O motor gerará um novo alerta no próximo ciclo.`, false));
    }

    // Executar a pausa no Meta Ads
    const tokenData = await getIntegrationToken(action.user_id);
    if (!tokenData || !tokenData.accessToken) {
      return res.send(confirmPage('❌ Erro de autenticação.', 'Token do Meta Ads não encontrado. Reconecte sua conta Meta Ads no painel.', false));
    }

    await pauseEntity(action.entity_external_id, tokenData.accessToken);

    // Marcar como executada
    await query(`
      UPDATE pending_actions
      SET status = 'executed', executed_at = NOW()
      WHERE id = $1
    `, [action.id]);

    // Registrar em automated_actions
    await query(`
      INSERT INTO automated_actions
        (user_id, decision_id, entity_type, entity_id, entity_name,
         action_type, old_value, new_value, status, executed_at)
      VALUES ($1,$2,$3,$4,$5,'PAUSE','{"status":"ACTIVE"}','{"status":"PAUSED"}','executed',NOW())
    `, [action.user_id, action.decision_id, action.entity_type,
        action.entity_external_id, action.entity_name]);

    console.log(`[Confirm] PAUSE executada: "${action.entity_name}" — aprovada por ${action.user_name}`);

    // Enviar confirmacao via WhatsApp (CallMeBot)
    if (action.whatsapp) {
      const tipo = action.entity_type === 'campaign' ? 'Campanha'
        : action.entity_type === 'ad_set' ? 'Conjunto' : 'Anuncio';
      await sendCallMeBot(action.whatsapp,
        `✅ IPPMIFY - ${tipo} pausado!\n\n"${action.entity_name}" foi pausado com sucesso.\n\nVoce pode reativar no painel do Meta Ads.\n— IPPMIFY`
      );
    }

    return res.send(confirmPage(
      `✅ "${action.entity_name}" pausada com sucesso!`,
      `A campanha foi pausada. Você receberá uma confirmação no WhatsApp.\nPode reativar a qualquer momento no painel do Meta Ads.`,
      true
    ));

  } catch (err) {
    console.error('[Confirm] Erro ao executar pausa:', err.message);
    return res.send(confirmPage('❌ Erro ao pausar.', `Detalhe: ${err.message}\n\nTente pausar manualmente no Meta Ads.`, false));
  }
});

// Gerar pagina HTML de resposta para o link de confirmacao
function confirmPage(title, detail, success) {
  const color = success ? '#2E7D32' : '#C62828';
  const bg    = success ? '#E8F5E9' : '#FFEBEE';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IPPMIFY</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex;
           align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 400px;
            width: 90%; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,.1); }
    .icon { font-size: 64px; margin-bottom: 20px; }
    h1 { color: ${color}; font-size: 22px; margin: 0 0 12px; }
    p { color: #666; font-size: 15px; line-height: 1.5; white-space: pre-line; }
    .badge { background: ${bg}; color: ${color}; padding: 8px 16px;
             border-radius: 20px; font-size: 13px; display: inline-block; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✅' : '⚠️'}</div>
    <h1>${title}</h1>
    <p>${detail}</p>
    <div class="badge">IPPMIFY Profit Intelligence</div>
  </div>
</body>
</html>`;
}

module.exports = router;
