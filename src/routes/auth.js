const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { setEx, get, del } = require('../config/redis');
const { generateTokens, requireAuth } = require('../middleware/auth');

const router = express.Router();

// ─── REGISTRO ──────────────────────────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, name, password } = req.body;

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

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, plan, created_at`,
      [email.toLowerCase(), name, passwordHash]
    );

    const user = result.rows[0];
    const { accessToken, refreshToken } = generateTokens(user.id);

    await setEx(`refresh:${user.id}`, refreshToken, 30 * 24 * 60 * 60);

    console.log(`[Auth] Novo usuario registrado: ${email}`);

    res.status(201).json({
      message: 'Conta criada com sucesso!',
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
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
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatorio' });

    const result = await query(
      'SELECT id, name FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ message: 'Instrucoes enviadas.' });
    }

    const user = result.rows[0];
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');

    console.log(`[Auth] Reset de senha para: ${email} | Token: ${resetToken} | User: ${user.name}`);

    // TODO: integrar envio de email (Resend/SendGrid)
    // Por enquanto o token aparece nos logs do Railway para o admin resetar manualmente
    res.json({ message: 'Instrucoes enviadas.' });

  } catch (error) {
    console.error('[Auth] Forgot password erro:', error.message);
    res.json({ message: 'Instrucoes enviadas.' });
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
    report_freq, report_times
  } = req.user;
  res.json({
    data: {
      id, email, name, plan, plan_status,
      trial_expires_at, plan_expires_at,
      whatsapp, whatsapp_key, cpa_target, roas_target, timezone,
      report_freq, report_times
    }
  });
});

// ─── ATUALIZAR CONFIGURACOES ───────────────────────────────────────────────
// PUT /api/auth/settings
router.put('/settings', requireAuth, async (req, res) => {
  try {
    const { cpa_target, roas_target, whatsapp, whatsapp_key, timezone, report_freq, report_times } = req.body;

    await query(
      `UPDATE users SET
        cpa_target   = COALESCE($1, cpa_target),
        roas_target  = COALESCE($2, roas_target),
        whatsapp     = COALESCE($3, whatsapp),
        whatsapp_key = COALESCE($4, whatsapp_key),
        timezone     = COALESCE($5, timezone),
        report_freq  = COALESCE($7, report_freq),
        report_times = COALESCE($8, report_times),
        updated_at   = NOW()
       WHERE id = $6`,
      [cpa_target, roas_target, whatsapp, whatsapp_key || null, timezone, req.user.id,
       report_freq !== undefined ? report_freq : null,
       report_times || null]
    );

    res.json({ message: 'Configuracoes atualizadas com sucesso' });
  } catch (error) {
    console.error('[Auth] Erro ao atualizar configuracoes:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar configuracoes' });
  }
});

module.exports = router;
