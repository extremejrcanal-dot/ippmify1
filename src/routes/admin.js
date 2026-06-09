const express = require('express');
const { query } = require('../config/database');

const router = express.Router();

// ─── MIDDLEWARE: somente admins ──────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
};

// ─── GERAR TOKEN DEMO (por lead) ─────────────────────────────────────────────
// POST /api/admin/demo-token
// Body: { label: "Lead João Silva" }
// Gera um UUID único, de uso único, válido por 48h
router.post('/demo-token', requireAdmin, async (req, res) => {
  try {
    const { label } = req.body;

    const result = await query(
      `INSERT INTO demo_tokens (created_by, label, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '48 hours')
       RETURNING id, label, expires_at, created_at`,
      [req.user.id, label || null]
    );

    const token = result.rows[0];
    const appUrl = process.env.APP_URL || `https://${req.get('host')}`;
    const link = `${appUrl}/?demo=${token.id}`;

    console.log(`[Admin] Token demo criado: ${token.id} | label: ${label || '(sem label)'} | por: ${req.user.email}`);

    res.status(201).json({
      token_id:   token.id,
      label:      token.label,
      link,
      expires_at: token.expires_at,
      created_at: token.created_at,
    });
  } catch (error) {
    console.error('[Admin] Erro ao criar token demo:', error.message);
    res.status(500).json({ error: 'Erro ao gerar token' });
  }
});

// ─── LISTAR TOKENS DEMO ───────────────────────────────────────────────────────
// GET /api/admin/demo-tokens
// Retorna histórico com status: active / used / expired
router.get('/demo-tokens', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         id,
         label,
         used_at,
         used_by_email,
         expires_at,
         created_at,
         CASE
           WHEN used_at IS NOT NULL          THEN 'used'
           WHEN expires_at < NOW()           THEN 'expired'
           ELSE                                   'active'
         END AS status
       FROM demo_tokens
       WHERE created_by = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    const appUrl = process.env.APP_URL || `https://${req.get('host')}`;

    const tokens = result.rows.map(t => ({
      ...t,
      link: t.status === 'active' ? `${appUrl}/?demo=${t.id}` : null,
    }));

    res.json({ data: tokens });
  } catch (error) {
    console.error('[Admin] Erro ao listar tokens demo:', error.message);
    res.status(500).json({ error: 'Erro ao listar tokens' });
  }
});

// ─── REVOGAR TOKEN DEMO ───────────────────────────────────────────────────────
// DELETE /api/admin/demo-token/:id
router.delete('/demo-token/:id', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `UPDATE demo_tokens
       SET expires_at = NOW()
       WHERE id = $1 AND created_by = $2 AND used_at IS NULL
       RETURNING id`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Token nao encontrado ou ja utilizado' });
    }

    console.log(`[Admin] Token demo revogado: ${req.params.id} | por: ${req.user.email}`);
    res.json({ message: 'Token revogado com sucesso' });
  } catch (error) {
    console.error('[Admin] Erro ao revogar token demo:', error.message);
    res.status(500).json({ error: 'Erro ao revogar token' });
  }
});

// ─── CONCEDER TRIAL A CONTA JÁ CADASTRADA ────────────────────────────────────
// POST /api/admin/grant-trial
// Body: { email: "lead@exemplo.com", days: 7 }
// Funciona em qualquer plan (starter, expired, pending) — não sobrescreve 'active'
router.post('/grant-trial', requireAdmin, async (req, res) => {
  try {
    const { email, days } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email obrigatorio' });
    }

    const trialDays = Math.min(Math.max(parseInt(days) || 7, 1), 30); // entre 1 e 30 dias

    // Buscar usuário
    const userResult = await query(
      `SELECT id, email, name, plan FROM users WHERE email = $1 AND is_active = true`,
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conta nao encontrada com este email' });
    }

    const user = userResult.rows[0];

    // Não rebaixar quem já tem plano ativo pago
    if (user.plan === 'active') {
      return res.status(409).json({
        error: 'Esta conta ja tem uma assinatura ativa — trial nao aplicado',
        plan: 'active'
      });
    }

    const trialExpiry = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

    await query(
      `UPDATE users SET plan = 'trial', trial_expires_at = $1 WHERE id = $2`,
      [trialExpiry, user.id]
    );

    console.log(`[Admin] Trial concedido: ${user.email} | ${trialDays} dias | expira: ${trialExpiry.toISOString()} | por: ${req.user.email}`);

    res.json({
      message: `Trial de ${trialDays} dias ativado para ${user.email}`,
      user: { id: user.id, email: user.email, name: user.name },
      trial_expires_at: trialExpiry,
      days: trialDays
    });

  } catch (error) {
    console.error('[Admin] Erro ao conceder trial:', error.message);
    res.status(500).json({ error: 'Erro ao conceder trial' });
  }
});

module.exports = router;
