const express = require('express');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ─── LISTAR OFERTAS COM MÉTRICAS ──────────────────────────────────────────────
// GET /api/offers?days=30
router.get('/', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    // Buscar ofertas + métricas agregadas das campanhas vinculadas
    const result = await query(`
      SELECT
        o.id,
        o.name,
        o.description,
        o.price,
        o.cost,
        o.status,
        o.created_at,
        COALESCE(spend_data.spend, 0)::float           AS spend,
        COALESCE(rev_data.revenue_total, 0)::float     AS revenue,
        COALESCE(rev_data.conversions_total, 0)::float AS conversions,
        COALESCE(camp_data.cnt, 0)::int                AS linked_campaigns
      FROM offers o
      LEFT JOIN LATERAL (
        SELECT SUM(am.spend)::float AS spend
        FROM offer_campaigns oc
        JOIN ad_metrics am ON am.campaign_id = oc.campaign_id
        WHERE oc.offer_id = o.id
          AND oc.user_id = $1
          AND am.date >= NOW() - ($2::text || ' days')::INTERVAL
      ) spend_data ON true
      LEFT JOIN LATERAL (
        SELECT
          SUM(s2.net_revenue)::float AS revenue_total,
          COUNT(*)::float            AS conversions_total
        FROM offer_campaigns oc
        JOIN campaigns c  ON c.id = oc.campaign_id
        JOIN sales s2     ON s2.utm_campaign = c.external_id
        WHERE oc.offer_id = o.id
          AND oc.user_id  = $1
          AND s2.user_id  = $1
          AND s2.status   = 'approved'
          AND s2.sale_date >= NOW() - ($2::text || ' days')::INTERVAL
      ) rev_data ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt
        FROM offer_campaigns oc
        WHERE oc.offer_id = o.id AND oc.user_id = $1
      ) camp_data ON true
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id, days]);

    // Calcular ROAS, CPA e lucro
    const offers = result.rows.map(o => {
      const spend       = parseFloat(o.spend)       || 0;
      const revenue     = parseFloat(o.revenue)     || 0;
      const conversions = parseFloat(o.conversions) || 0;
      const cost        = parseFloat(o.cost)        || 0;
      const cogs        = conversions * cost;
      const profit      = revenue - spend - cogs;
      const roas        = spend > 0 ? revenue / spend : null;
      const cpa         = conversions > 0 ? spend / conversions : null;

      return {
        ...o,
        spend, revenue, conversions,
        cogs: parseFloat(cogs.toFixed(2)),
        profit: parseFloat(profit.toFixed(2)),
        roas:   roas  !== null ? parseFloat(roas.toFixed(2))  : null,
        cpa:    cpa   !== null ? parseFloat(cpa.toFixed(2))   : null,
      };
    });

    res.json({ offers, days });

  } catch (error) {
    console.error('[Offers] Erro ao listar:', error.message);
    res.status(500).json({ error: 'Erro ao carregar ofertas' });
  }
});

// ─── CRIAR OFERTA ─────────────────────────────────────────────────────────────
// POST /api/offers
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, price, cost } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome da oferta é obrigatório' });
    }

    const result = await query(`
      INSERT INTO offers (user_id, name, description, price, cost)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [req.user.id, name.trim(), description || null, price || 0, cost || 0]);

    console.log(`[Offers] Nova oferta criada: ${name} (user: ${req.user.id})`);
    res.status(201).json({ offer: result.rows[0], message: 'Oferta criada com sucesso!' });

  } catch (error) {
    console.error('[Offers] Erro ao criar:', error.message);
    res.status(500).json({ error: 'Erro ao criar oferta' });
  }
});

// ─── ATUALIZAR OFERTA ─────────────────────────────────────────────────────────
// PUT /api/offers/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, price, cost, status } = req.body;
    const { id } = req.params;

    await query(`
      UPDATE offers SET
        name        = COALESCE($1, name),
        description = COALESCE($2, description),
        price       = COALESCE($3, price),
        cost        = COALESCE($4, cost),
        status      = COALESCE($5, status),
        updated_at  = NOW()
      WHERE id = $6 AND user_id = $7
    `, [name, description, price, cost, status, id, req.user.id]);

    res.json({ message: 'Oferta atualizada com sucesso!' });

  } catch (error) {
    console.error('[Offers] Erro ao atualizar:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar oferta' });
  }
});

// ─── DELETAR OFERTA ───────────────────────────────────────────────────────────
// DELETE /api/offers/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query(
      'DELETE FROM offers WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Oferta removida' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover oferta' });
  }
});

// ─── LISTAR CAMPANHAS DA OFERTA ───────────────────────────────────────────────
// GET /api/offers/:id/campaigns
router.get('/:id/campaigns', requireAuth, async (req, res) => {
  try {
    const linked = await query(`
      SELECT c.id, c.name, c.status, c.external_id
      FROM offer_campaigns oc
      JOIN campaigns c ON c.id = oc.campaign_id
      WHERE oc.offer_id = $1 AND oc.user_id = $2
      ORDER BY c.name
    `, [req.params.id, req.user.id]);

    const all = await query(`
      SELECT id, name, status, external_id
      FROM campaigns
      WHERE user_id = $1
      ORDER BY name
    `, [req.user.id]);

    const linkedIds = new Set(linked.rows.map(r => r.id));

    res.json({
      linked:   linked.rows,
      available: all.rows.filter(c => !linkedIds.has(c.id)),
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar campanhas' });
  }
});

// ─── VINCULAR CAMPANHA À OFERTA ───────────────────────────────────────────────
// POST /api/offers/:id/campaigns
router.post('/:id/campaigns', requireAuth, async (req, res) => {
  try {
    const { campaign_id } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id obrigatório' });

    await query(`
      INSERT INTO offer_campaigns (offer_id, campaign_id, user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (offer_id, campaign_id) DO NOTHING
    `, [req.params.id, campaign_id, req.user.id]);

    res.json({ message: 'Campanha vinculada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao vincular campanha' });
  }
});

// ─── DESVINCULAR CAMPANHA DA OFERTA ──────────────────────────────────────────
// DELETE /api/offers/:id/campaigns/:campaignId
router.delete('/:id/campaigns/:campaignId', requireAuth, async (req, res) => {
  try {
    await query(
      'DELETE FROM offer_campaigns WHERE offer_id = $1 AND campaign_id = $2 AND user_id = $3',
      [req.params.id, req.params.campaignId, req.user.id]
    );
    res.json({ message: 'Campanha desvinculada' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desvincular campanha' });
  }
});

module.exports = router;
