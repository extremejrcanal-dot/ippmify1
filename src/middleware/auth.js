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
      `SELECT id, email, name, plan, timezone, whatsapp,
              trial_expires_at, plan_expires_at
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

    // Verificar se assinatura venceu
    if (user.plan === 'active' && user.plan_expires_at && new Date(user.plan_expires_at) < now) {
      user.plan = 'expired';
      await query("UPDATE users SET plan='expired' WHERE id=$1", [user.id]);
    }

    // Calcular plan_status legível
    if (user.plan === 'trial' || user.plan == null) {
      const trialOk = user.trial_expires_at && new Date(user.trial_expires_at) > now;
      user.plan_status = trialOk ? 'trial_active' : 'trial_expired';
    } else {
      user.plan_status = user.plan; // 'active' | 'expired'
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
/**
 * Use APOS requireAuth nas rotas que exigem assinatura paga.
 * Retorna 402 com link de upgrade se trial/plano expirado.
 */
const requireActivePlan = (req, res, next) => {
  const { plan_status } = req.user;
  if (plan_status === 'trial_expired' || plan_status === 'expired') {
    return res.status(402).json({
      error: 'Plano expirado',
      message: 'Seu periodo de acesso encerrou. Assine o IPPMIFY para continuar.',
      plan_status,
      upgrade_url: process.env.CAKTO_CHECKOUT_URL || 'https://ippmify.com/assinar',
    });
  }
  next();
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
