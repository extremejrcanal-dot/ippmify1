const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// Middleware de autenticacao JWT
// Verifica se o usuario esta logado em cada requisicao protegida
const requireAuth = async (req, res, next) => {
  try {
    // Pegar o token do cabecalho da requisicao
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Acesso negado',
        message: 'Voce precisa estar logado para acessar este recurso'
      });
    }

    // Extrair o token (remove "Bearer " do inicio)
    const token = authHeader.substring(7);

    // Verificar e decodificar o token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Buscar o usuario no banco para garantir que ainda existe
    const result = await query(
      'SELECT id, email, name, plan, timezone, whatsapp FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Usuario nao encontrado',
        message: 'Sua sessao expirou. Faca login novamente.'
      });
    }

    // Adicionar dados do usuario na requisicao
    req.user = result.rows[0];
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

// Gerar tokens JWT
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }   // Token de acesso expira em 15 minutos
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }   // Token de renovacao expira em 30 dias
  );

  return { accessToken, refreshToken };
};

module.exports = { requireAuth, generateTokens };
