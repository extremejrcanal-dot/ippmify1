const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { query } = require('../config/database');
const { requireAuth, generateTokens } = require('../middleware/auth');

let encrypt = (v) => v, decrypt = (v) => v;
try {
  const enc = require('../services/encryptionService');
  encrypt = enc.encrypt; decrypt = enc.decrypt;
} catch (_) {}

const router = express.Router();

// --- REGISTRO ---
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nome, e-mail e senha sao obrigatorios' });
    if (password.length < 6)
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });

    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0)
      return res.status(400).json({ error: 'Este e-mail ja esta em uso' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const trialExpiresAt = new Date();
    trialExpiresAt.setDate(trialExpiresAt.getDate() + 7);

    const result = await query(
      `INSERT INTO users (name, email, password_hash, plan, trial_expires_at, is_active)
       VALUES ($1, $2, $3, 'trial', $4, true)
       RETURNING id, name, email, plan`,
      [name.trim(), email.toLowerCase().trim(), hashedPassword, trialExpiresAt]
    );
    const user = result.rows[0];
    const { accessToken, refreshToken } = generateTokens(user.id);
    res.status(201).json({
      message: 'Conta criada com sucesso', accessToken, refreshToken,
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan },
    });
  } catch (error) {
    console.error('[Auth] Erro no registro:', error.message);
    res.status(500).json({ error: 'Erro ao criar conta' });
  }
});

// --- LOGIN ---
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'E-mail e senha sao obrigatorios' });

    const result = await query(
      `SELECT id, name, email, password_hash, plan, plan_expires_at,
              trial_expires_at, is_active, is_admin
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });

    const user = result.rows[0];
    if (!user.is_active)
      return res.status(401).json({ error: 'Conta desativada. Entre em contato com o suporte.' });

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch)
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });

    const { accessToken, refreshToken } = generateTokens(user.id);
    res.json({
      message: 'Login realizado com sucesso', accessToken, refreshToken,
      user: {
        id: user.id, name: user.name, email: user.email,
        plan: user.plan, plan_status: user.plan,
        plan_expires_at: user.plan_expires_at,
        trial_expires_at: user.trial_expires_at,
        is_admin: user.is_admin ?? false,
      },
    });
  } catch (error) {
    console.error('[Auth] Erro no login:', error.message);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// --- REFRESH TOKEN ---
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token nao fornecido' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Token invalido' });
    const result = await query('SELECT id FROM users WHERE id = $1 AND is_active = true', [decoded.userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario nao encontrado' });
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(decoded.userId);
    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (error) {
    console.error('[Auth] Erro ao renovar token:', error.message);
    res.status(401).json({ error: 'Token expirado ou invalido. Faca login novamente.' });
  }
});

// --- PERFIL ---
router.get('/me', requireAuth, async (req, res) => {
  const u = req.user;
  res.json({
    user: u,
    data: {
      id:                   u.id,
      email:                u.email,
      name:                 u.name,
      plan:                 u.plan,
      plan_status:          u.plan,
      plan_expires_at:      u.plan_expires_at,
      trial_expires_at:     u.trial_expires_at,
      is_admin:             u.is_admin ?? false,
      timezone:             u.timezone,
      whatsapp:             u.whatsapp,
      whatsapp_key:         u.whatsapp_key ?? null,
      cpa_target:           parseFloat(u.cpa_target  || 50),
      roas_target:          parseFloat(u.roas_target || 2),
      report_freq:          u.report_freq  ?? 0,
      report_times:         u.report_times ?? '',
      report_days:          u.report_days  ?? 7,
      capi_api_key:         u.capi_api_key ?? null,
      meta_pixel_id:        u.meta_pixel_id ?? null,
      meta_capi_configured: u.meta_capi_configured ?? false,
    }
  });
});

// --- ATUALIZAR CONFIGURACOES ---
router.put('/settings', requireAuth, async (req, res) => {
  try {
    const { cpa_target, roas_target, whatsapp, whatsapp_key, timezone,
            meta_pixel_id, meta_access_token } = req.body;

    const encryptedToken = meta_access_token ? encrypt(meta_access_token) : null;

    await query(
      `UPDATE users SET
        cpa_target         = COALESCE($1, cpa_target),
        roas_target        = COALESCE($2, roas_target),
        whatsapp           = COALESCE($3, whatsapp),
        whatsapp_key       = COALESCE($4, whatsapp_key),
        timezone           = COALESCE($5, timezone),
        meta_pixel_id      = COALESCE($6, meta_pixel_id),
        meta_access_token  = COALESCE($7, meta_access_token),
        updated_at         = NOW()
       WHERE id = $8`,
      [cpa_target, roas_target, whatsapp, whatsapp_key, timezone,
       meta_pixel_id, encryptedToken, req.user.id]
    );
    res.json({ message: 'Configuracoes atualizadas com sucesso' });
  } catch (error) {
    console.error('[Auth] Erro ao atualizar configuracoes:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar configuracoes' });
  }
});

// --- GERAR CHAVE CAPI PROXY ---
router.post('/generate-capi-key', requireAuth, async (req, res) => {
  try {
    const newKey = crypto.randomBytes(32).toString('hex');
    await query(`UPDATE users SET capi_api_key = $1, updated_at = NOW() WHERE id = $2`, [newKey, req.user.id]);
    res.json({ capi_api_key: newKey });
  } catch (error) {
    console.error('[Auth] Erro ao gerar chave CAPI:', error.message);
    res.status(500).json({ error: 'Erro ao gerar chave de API' });
  }
});

// --- ESQUECI MINHA SENHA ---
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail obrigatorio' });

    const result = await query('SELECT id FROM users WHERE email = $1 AND is_active = true', [email.toLowerCase().trim()]);
    if (result.rows.length > 0) {
      const userId = result.rows[0].id;
      const token  = crypto.randomBytes(48).toString('hex');
      await query(
        `INSERT INTO password_resets (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [userId, token]
      );
      // TODO: enviar email com link: https://SEU_DOMINIO/?reset_token=TOKEN
      console.log('[Auth] Reset token para ' + email + ': ' + token);
    }
    res.json({ message: 'Se esse email estiver cadastrado, voce recebera as instrucoes em breve.' });
  } catch (error) {
    console.error('[Auth] Erro forgot-password:', error.message);
    res.json({ message: 'Se esse email estiver cadastrado, voce recebera as instrucoes em breve.' });
  }
});

// --- REDEFINIR SENHA ---
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token e nova senha sao obrigatorios' });
    if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });

    const result = await query(
      `SELECT pr.user_id FROM password_resets pr
       WHERE pr.token = $1 AND pr.expires_at > NOW() AND pr.used = false`,
      [token]
    );
    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Token invalido ou expirado.' });

    const userId = result.rows[0].user_id;
    const hashedPassword = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hashedPassword, userId]);
    await query('UPDATE password_resets SET used = true WHERE token = $1', [token]);

    res.json({ message: 'Senha redefinida com sucesso! Faca login com sua nova senha.' });
  } catch (error) {
    console.error('[Auth] Erro reset-password:', error.message);
    res.status(500).json({ error: 'Erro ao redefinir senha' });
  }
});

module.exports = router;
