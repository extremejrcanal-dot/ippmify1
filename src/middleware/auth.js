const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Acesso negado', message: 'Voce precisa estar logado para acessar este recurso' });
    }

    const token   = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      `SELECT id, email, name, plan, plan_expires_at, trial_expires_at,
              is_admin, timezone, whatsapp, whatsapp_key,
              report_freq, report_times, report_days,
              cpa_target, roas_target, roas_breakeven, capi_api_key,
              meta_pixel_id,
              (meta_access_token IS NOT NULL) AS meta_capi_configured
       FROM users WHERE id = $1 AND is_active = true`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario nao encontrado', message: 'Sua sessao expirou. Faca login novamente.' });
    }

    const u = result.rows[0];
    req.user = { ...u, plan_status: u.plan };
    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', message: 'Sua sessao expirou. Faca login novamente.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token invalido', message: 'Acesso nao autorizado.' });
    }
    console.error('[Auth] Erro ao verificar token:', error.message);
    return res.status(500).json({ error: 'Erro interno de autenticacao' });
  }
};

const generateTokens = (userId) => {
  const accessToken  = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ userId, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return { accessToken, refreshToken };
};

module.exports = { requireAuth, generateTokens };
