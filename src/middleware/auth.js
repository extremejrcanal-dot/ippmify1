const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// ─── AUTENTICACAO JWT ────────────────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Acesso negado',
        message: 'Voce precisa estar logado para acessar este recurso'
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      `SELECT id, email, name, plan, timezone, whatsapp, whatsapp_key,
              cpa_target, roas_target, report_freq, report_times, report_days,
              trial_expires_at, plan_expires_at, is_admin,
              meta_pixel_id, meta_access_token, capi_api_key
       FROM users WHERE id = $1 AND is_active = true`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Usuario nao encontrado',
        message: 'Sua sessao expirou. Faca login novamente.'
      });
    }

    const user = result.rows[0];
    const now = new Date();

    // Admin tem acesso total sem verificacao de plano
    if (user.is_admin) {
      user.plan_status = 'active';
      req.user = user;
      return next();
    }

    // ── Verificar expiracao do plano pago ──────────────────────────────────
    if (user.plan === 'active' && user.plan_expires_at && new Date(user.plan_expires_at) < now) {
      user.plan = 'expired';
      await query("UPDATE users SET plan='expired' WHERE id=$1", [user.id]);
    }

    // ── Verificar expiracao do trial ───────────────────────────────────────
    if (user.plan === 'trial' && user.trial_expires_at && new Date(user.trial_expires_at) < now) {
      user.plan = 'expired';
      await query("UPDATE users SET plan='expired' WHERE id=$1", [user.id]);
    }

    // ── Calcular plan_status ───────────────────────────────────────────────
    // active  → assinatura paga ativa
    // trial   → trial gratuito ainda vigente
    // pending → sem assinatura nem trial (recém cadastrado)
    // expired → assinatura ou trial vencido
    if (user.plan === 'active') {
      user.plan_status = 'active';
    } else if (user.plan === 'trial') {
      user.plan_status = 'trial';
    } else if (user.plan === 'expired') {
      user.plan_status = 'expired';
    } else {
      user.plan_status = 'pending';
    }

    req.user = user;
    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expirado',
        message: 'Sua sessao expirou. Faca login novamente.'
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token invalido',
        message: 'Acesso nao autorizado.'
      });
    }
    console.error('[Auth] Erro ao verificar token:', error.message);
    return res.status(500).json({ error: 'Erro interno de autenticacao' });
  }
};

// ─── VERIFICACAO DE PLANO ATIVO ──────────────────────────────────────────────
// Permite: assinatura paga (active) OU trial ainda vigente (trial)
// Bloqueia: sem assinatura (pending), expirado (expired)
const requireActivePlan = (req, res, next) => {
  // Admin sempre passa
  if (req.user?.is_admin) return next();

  const { plan_status } = req.user;

  if (plan_status === 'active' || plan_status === 'trial') {
    return next();
  }

  return res.status(402).json({
    error: 'Assinatura necessaria',
    message: plan_status === 'expired'
      ? 'Seu trial ou assinatura expirou. Assine o IPPMIFY para continuar.'
      : 'Assine o IPPMIFY para acessar este recurso.',
    plan_status,
    upgrade_url: process.env.KIRVANO_CHECKOUT_URL || 'https://pay.kirvano.com/38e05652-22f6-494e-a97f-bd2e3f0aa034',
  });
};

// ─── GERAR TOKENS JWT ────────────────────────────────────────────────────────
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  return { accessToken, refreshToken };
};

module.exports = { requireAuth, generateTokens, requireActivePlan };
