const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const axios    = require('axios');
const { query }  = require('../config/database');
const { setEx, get, del } = require('../config/redis');
const { generateTokens, requireAuth } = require('../middleware/auth');
const { sendEvent } = require('../utils/metaCapi');

const router = express.Router();

// Helper: extrai IP real passando por proxy Railway
const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.headers['x-real-ip'] ||
  req.ip;

// ─── MAILER (Resend — HTTP API, funciona no Railway) ───────────────────────
const sendResetEmail = async (toEmail, toName, resetUrl) => {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#0D1B2A;color:#E6F0FF;border-radius:12px;overflow:hidden;">
      <div style="background:#146EF5;padding:24px 32px;">
        <div style="font-size:22px;font-weight:800;letter-spacing:2px;">IPPMIFY</div>
        <div style="font-size:12px;opacity:.7;margin-top:4px;">Profit Intelligence System</div>
      </div>
      <div style="padding:32px;">
        <div style="font-size:18px;font-weight:700;margin-bottom:12px;">Ola, ${toName}!</div>
        <p style="color:#8BA3BC;line-height:1.6;margin-bottom:24px;">
          Recebemos uma solicitacao para redefinir a senha da sua conta IPPMIFY.<br>
          Clique no botao abaixo para criar uma nova senha. O link expira em <strong style="color:#E6F0FF;">1 hora</strong>.
        </p>
        <a href="${resetUrl}" style="display:inline-block;background:#146EF5;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;">
          Redefinir minha senha
        </a>
        <p style="color:#4A6580;font-size:12px;margin-top:24px;line-height:1.6;">
          Se voce nao solicitou a redefinicao, ignore este email - sua senha permanece a mesma.<br>
          Por seguranca, nunca compartilhe este link com ninguem.
        </p>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #1E3A5F;font-size:11px;color:#4A6580;text-align:center;">
        IPPMIFY - ippmify@gmail.com
      </div>
    </div>
  `;

  const response = await axios.post(
    'https://api.resend.com/emails',
    {
      from:    'IPPMIFY <onboarding@resend.dev>',
      to:      [toEmail],
      subject: 'Redefinir sua senha - IPPMIFY',
      html,
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      timeout: 10000,
    }
  );

  console.log(`[Auth] Resend resposta: ${response.status} - id: ${response.data?.id}`);
};

// ─── REGISTRO ──────────────────────────────────────────────────────────────
// POST /api/auth/register
// Se trial_code for um UUID válido em demo_tokens → cria conta com plan='trial' por 7 dias
// O token é de uso único: marcado como usado logo após o cadastro
router.post('/register', async (req, res) => {
  try {
    const { email, name, password, trial_code } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, nome e senha sao obrigatorios' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres' });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Email invalido' });
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Este email ja esta cadastrado' });
    }

    // ── Verificar token demo de uso único ─────────────────────────────────
    let isTrial    = false;
    let trialExpiry = null;
    let tokenId    = null;

    if (trial_code) {
      // UUID format check (evita SQL injection e lookup desnecessário)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(trial_code)) {
        const tokenResult = await query(
          `SELECT id FROM demo_tokens
           WHERE id = $1
             AND used_at IS NULL
             AND expires_at > NOW()`,
          [trial_code]
        );
        if (tokenResult.rows.length > 0) {
          isTrial     = true;
          tokenId     = tokenResult.rows[0].id;
          trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias
        }
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (email, name, password_hash, plan, trial_expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, plan, created_at`,
      [email.toLowerCase(), name, passwordHash, isTrial ? 'trial' : 'starter', trialExpiry]
    );

    const user = result.rows[0];
    const { accessToken, refreshToken } = generateTokens(user.id);

    await setEx(`refresh:${user.id}`, refreshToken, 30 * 24 * 60 * 60);

    // ── Marcar token como usado (uso único) ───────────────────────────────
    if (isTrial && tokenId) {
      await query(
        `UPDATE demo_tokens SET used_at = NOW(), used_by_email = $1 WHERE id = $2`,
        [email.toLowerCase(), tokenId]
      );
      console.log(`[Auth] Novo trial ativado: ${email} | token: ${tokenId} | expira em: ${trialExpiry.toISOString()}`);
    } else {
      console.log(`[Auth] Novo usuario registrado: ${email}`);
    }

    // ── Tracking Meta CAPI ────────────────────────────────────────────────
    const appUrl = process.env.APP_URL || 'https://ippmify1-production.up.railway.app';
    sendEvent({
      eventName:      'CompleteRegistration',
      email:          email.toLowerCase(),
      clientIp:       getClientIp(req),
      userAgent:      req.headers['user-agent'],
      eventSourceUrl: appUrl,
      customData:     { status: isTrial ? 'trial' : 'starter' },
    }).catch(() => {});

    if (isTrial) {
      sendEvent({
        eventName:      'StartTrial',
        email:          email.toLowerCase(),
        clientIp:       getClientIp(req),
        userAgent:      req.headers['user-agent'],
        eventSourceUrl: appUrl,
        customData:     { predicted_ltv: 97, currency: 'BRL' },
      }).catch(() => {});
    }

    res.status(201).json({
      message: isTrial ? 'Trial ativado! 7 dias de acesso completo liberados.' : 'Conta criada com sucesso!',
      user:     { id: user.id, email: user.email, name: user.name, plan: user.plan },
      is_trial: isTrial,
      trial_expires_at: trialExpiry,
      accessToken,
      refreshToken
    });

  } catch (error) {
    console.error('[Auth] Erro no registro:', error.message);
    res.status(500).json({ error: 'Erro ao criar conta. Tente novamente.' });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────
// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha sao obrigatorios' });
    }

    const result = await query(
      'SELECT id, email, name, plan, password_hash, is_active FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    await setEx(`refresh:${user.id}`, refreshToken, 30 * 24 * 60 * 60);

    console.log(`[Auth] Login: ${email}`);

    // ── Tracking Meta CAPI ────────────────────────────────────────────────
    const appUrl = process.env.APP_URL || 'https://ippmify1-production.up.railway.app';
    sendEvent({
      eventName:      'Login',
      email:          email.toLowerCase(),
      clientIp:       getClientIp(req),
      userAgent:      req.headers['user-agent'],
      eventSourceUrl: appUrl,
    }).catch(() => {});

    res.json({
      message: 'Login realizado com sucesso!',
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
      accessToken,
      refreshToken
    });

  } catch (error) {
    console.error('[Auth] Erro no login:', error.message);
    res.status(500).json({ error: 'Erro ao fazer login. Tente novamente.' });
  }
});

// ─── ESQUECEU A SENHA ──────────────────────────────────────────────────────
// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  // Sempre responde com sucesso (nao revela se email existe)
  res.json({ message: 'Se esse email estiver cadastrado, voce recebera as instrucoes em breve.' });

  try {
    const { email } = req.body;
    if (!email) return;

    const result = await query(
      'SELECT id, name FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) return;

    const user       = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    // Salva token no banco
    await query(
      `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [resetToken, expiresAt, user.id]
    );

    const appUrl  = process.env.APP_URL || 'https://ippmify1-production.up.railway.app';
    const resetUrl = `${appUrl}/?reset=${resetToken}`;

    await sendResetEmail(email.toLowerCase(), user.name, resetUrl);
    console.log(`[Auth] Email de reset enviado para: ${email}`);

  } catch (error) {
    console.error('[Auth] Erro ao enviar email de reset:', error.message);
  }
});

// ─── REDEFINIR SENHA ───────────────────────────────────────────────────────
// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token e nova senha sao obrigatorios' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres' });
    }

    const result = await query(
      `SELECT id, email FROM users
       WHERE reset_token = $1
         AND reset_token_expires > NOW()
         AND is_active = true`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Link invalido ou expirado. Solicite um novo.' });
    }

    const user         = result.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
      [passwordHash, user.id]
    );

    console.log(`[Auth] Senha redefinida para: ${user.email}`);
    res.json({ message: 'Senha redefinida com sucesso! Faca login com a nova senha.' });

  } catch (error) {
    console.error('[Auth] Erro ao redefinir senha:', error.message);
    res.status(500).json({ error: 'Erro ao redefinir senha. Tente novamente.' });
  }
});

// ─── RENOVAR TOKEN ─────────────────────────────────────────────────────────
// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token nao fornecido' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Token invalido' });
    }

    const storedToken = await get(`refresh:${decoded.userId}`);
    if (!storedToken || storedToken !== refreshToken) {
      return res.status(401).json({ error: 'Sessao expirada. Faca login novamente.' });
    }

    const tokens = generateTokens(decoded.userId);
    await setEx(`refresh:${decoded.userId}`, tokens.refreshToken, 30 * 24 * 60 * 60);

    res.json(tokens);

  } catch (error) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
});

// ─── LOGOUT ────────────────────────────────────────────────────────────────
// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await del(`refresh:${req.user.id}`);
    res.json({ message: 'Logout realizado com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao fazer logout' });
  }
});

// ─── PERFIL ────────────────────────────────────────────────────────────────
// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const {
    id, email, name, plan, plan_status,
    trial_expires_at, plan_expires_at,
    whatsapp, whatsapp_key, cpa_target, roas_target, timezone,
    report_freq, report_times, report_days, is_admin,
    meta_pixel_id, meta_access_token, capi_api_key,
  } = req.user;
  res.json({
    data: {
      id, email, name, plan, plan_status,
      trial_expires_at, plan_expires_at,
      whatsapp, whatsapp_key, cpa_target, roas_target, timezone,
      report_freq, report_times, report_days,
      is_admin: !!is_admin,
      meta_pixel_id:        meta_pixel_id  || null,
      meta_access_token:    meta_access_token  ? '••••••••' : null, // nunca expõe o token completo
      meta_capi_configured: !!(meta_pixel_id && meta_access_token),
      capi_api_key:         capi_api_key   || null,
    }
  });
});

// ─── ATUALIZAR CONFIGURACOES ───────────────────────────────────────────────
// PUT /api/auth/settings
router.put('/settings', requireAuth, async (req, res) => {
  try {
    const allowed = ['cpa_target','roas_target','whatsapp','whatsapp_key','timezone','report_freq','report_times','report_days','meta_pixel_id','meta_access_token'];
    const sets = [];
    const vals = [];
    let idx = 1;

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        let val = req.body[field];
        if (field === 'report_freq' || field === 'report_days') val = val === '' ? null : parseInt(val);
        if (field === 'report_times' && val === '') val = null;
        if (field === 'cpa_target'  || field === 'roas_target') val = val === '' ? null : parseFloat(val);
        sets.push(`${field} = $${idx}`);
        vals.push(val ?? null);
        idx++;
      }
    }

    if (sets.length === 0) return res.json({ message: 'Nada para atualizar' });

    sets.push(`updated_at = NOW()`);
    vals.push(req.user.id);

    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ message: 'Configuracoes atualizadas com sucesso' });
  } catch (error) {
    console.error('[Auth] Erro ao atualizar configuracoes:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar configuracoes' });
  }
});

// POST /api/auth/generate-capi-key
// Gera (ou rotaciona) a capi_api_key publica do assinante para o proxy de eventos
router.post('/generate-capi-key', requireAuth, async (req, res) => {
  try {
    const newKey = crypto.randomBytes(32).toString('hex'); // 64 chars hex
    await query(
      'UPDATE users SET capi_api_key = $1, updated_at = NOW() WHERE id = $2',
      [newKey, req.user.id]
    );
    res.json({ capi_api_key: newKey });
  } catch (error) {
    console.error('[Auth] Erro ao gerar capi_api_key:', error.message);
    res.status(500).json({ error: 'Erro ao gerar chave CAPI' });
  }
});

module.exports = router;
