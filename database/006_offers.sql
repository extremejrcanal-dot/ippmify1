-- ─── MIGRATION 006: Tabela de Ofertas ────────────────────────────────────────

-- Ofertas / Produtos do usuário
CREATE TABLE IF NOT EXISTS offers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(500) NOT NULL,
  description TEXT,
  price       NUMERIC(12, 2) DEFAULT 0,   -- Preço de venda (ticket)
  cost        NUMERIC(12, 2) DEFAULT 0,   -- Custo do produto (COGS)
  status      VARCHAR(50) DEFAULT 'active', -- active | paused | archived
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offers_user ON offers(user_id);

-- Vínculo entre Oferta e Campanhas Meta Ads
CREATE TABLE IF NOT EXISTS offer_campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id    UUID REFERENCES offers(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(offer_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_offer_campaigns_offer ON offer_campaigns(offer_id);
CREATE INDEX IF NOT EXISTS idx_offer_campaigns_campaign ON offer_campaigns(campaign_id);
