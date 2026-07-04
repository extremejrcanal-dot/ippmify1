const express  = require('express');
const bcrypt   = require('bcrypt');
const { query } = require('../config/database');
const { requireAuth, generateTokens } = require('../middleware/auth');

const router = express.Router();

// ─── REGISTRO ──────────────────────────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha sao obrigatorios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }

    // Verificar se email ja existe
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Este e-mail ja esta em uso' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // trial de 7 dias
    const trialDays = 7;
    const trialExpiresAt = new Date();
    trialExpiresAt.setDate(trialExpiresAt.getDate() + trialDays);

    const result = await query(
      `INSERT INTO users (name, email, password_hash, plan, plan_status, trial_expires_at, is_active)
       VALUES ($1, $2, $3, 'trial', 'trial', $4, true)
       RETURNING id, name, email, plan`,
      [name.trim(), email.toLowerCase().trim(), hashedPassword, trialExpiresAt]
    );

    const user = result.rows[0];
    const { accessToken, refreshToken } = generateTokens(user.id);

    res.status(201).json({
      message: 'Conta criada com sucesso',
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan },
    });
  } catch (error) {
    console.error('[Auth] Erro no registro:', error.message);
    res.status(500).json({ error: 'Erro ao criar conta' });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────
// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha sao obrigatorios' });
    }

    const result = await query(
      `SELECT id, name, email, password_hash, plan, plan_status, plan_expires_at,
              trial_expires_at, is_active, is_admin
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Conta desativada. Entre em contato com o suporte.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    res.json({
      message: 'Login realizado com sucesso',
      accessToken,
      refreshToken,
      user: {
        id:               user.id,
        name:             user.name,
        email:            user.email,
        plan:             user.plan,
        plan_status:      user.plan_status || user.plan,
        plan_expires_at:  user.plan_expires_at,
        trial_expires_at: user.trial_expires_at,
        is_admin:         user.is_admin ?? false,
      },
    });
  } catch (error) {
    console.error('[Auth] Erro no login:', error.message);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// ─── REFRESH TOKEN ─────────────────────────────────────────────────────────
// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token nao fornecido' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Token invalido' });
    }

    const result = await query(
      'SELECT id FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario nao encontrado' });
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(decoded.userId);
    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (error) {
    console.error('[Auth] Erro ao renovar token:', error.message);
    res.status(401).json({ error: 'Token expirado ou invalido. Faca login novamente.' });
  }
});

// ─── PERFIL ────────────────────────────────────────────────────────────────
// GET /api/auth/me
// Retorna no formato { data: {...} } para compatibilidade com o frontend
router.get('/me', requireAuth, async (req, res) => {
  const u = req.user;
  res.json({
    user: u,           // mantido para compatibilidade
    data: {            // formato esperado pelo frontend
      id:               u.id,
      email:            u.email,
      name:             u.name,
      plan:             u.plan,
      plan_status:      u.plan,          // alias: frontend le plan_status
      plan_expires_at:  u.plan_expires_at,
      trial_expires_at: u.trial_expires_at,
      is_admin:         u.is_admin ?? false,
      timezone:         u.timezone,
      whatsapp:         u.whatsapp,
      whatsapp_key:     u.whatsapp_key ?? null,
      cpa_target:       parseFloat(u.cpa_target  || 50),
      roas_target:      parseFloat(u.roas_target || 2),
      report_freq:      u.report_freq  ?? 0,
      report_times:     u.report_times ?? '',
      report_days:      u.report_days  ?? 7,
      capi_api_key:     u.capi_api_key ?? null,
    }
  });
});

// ─── ATUALIZAR CONFIGURACOES ───────────────────────────────────────────────
// PUT /api/auth/settings
router.put('/settings', requireAuth, async (req, res) => {
  try {
    const { cpa_target, roas_target, whatsapp, whatsapp_key, timezone } = req.body;

    await query(
      `UPDATE users SET
        cpa_target   = COALESCE($1, cpa_target),
        roas_target  = COALESCE($2, roas_target),
        whatsapp     = COALESCE($3, whatsapp),
        whatsapp_key = COALESCE($4, whatsapp_key),
        timezone     = COALESCE($5, timezone),
        updated_at   = NOW()
       WHERE id = $6`,
      [cpa_target, roas_target, whatsapp, whatsapp_key, timezone, req.user.id]
    );

    res.json({ message: 'Configuracoes atualizadas com sucesso' });
  } catch (error) {
    console.error('[Auth] Erro ao atualizar configuracoes:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar configuracoes' });
  }
});

// ─── GERAR CHAVE DE API CAPI PROXY ────────────────────────────────────────
// POST /api/auth/generate-capi-key
// Gera (ou regenera) uma chave publica unica para o snippet CAPI Proxy do usuario
router.post('/generate-capi-key', requireAuth, async (req, res) => {
  try {
    const crypto = require('crypto');
    // Chave de 32 bytes hex (64 chars) — unica e criptograficamente segura
    const newKey = crypto.randomBytes(32).toString('hex');

    await query(
      `UPDATE users SET capi_api_key = $1, updated_at = NOW() WHERE id = $2`,
      [newKey, req.user.id]
    );

    console.log(`[Auth] Chave CAPI gerada para usuario ${req.user.id}`);
    res.json({ capi_api_key: newKey });
  } catch (error) {
    console.error('[Auth] Erro ao gerar chave CAPI:', error.message);
    res.status(500).json({ error: 'Erro ao gerar chave de API' });
  }
});

module.exports = router;
