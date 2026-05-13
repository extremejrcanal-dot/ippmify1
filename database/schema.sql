-- ============================================================
-- IPPMIFY - Schema do Banco de Dados
-- Execute este arquivo no SQL Editor do Supabase
-- Instrucao: Supabase > SQL Editor > New Query > Cole tudo > Run
-- ============================================================

-- Extensao para gerar UUIDs automaticamente
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── USUARIOS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  name          VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),
  plan          VARCHAR(50) DEFAULT 'starter',
  timezone      VARCHAR(50) DEFAULT 'America/Sao_Paulo',
  whatsapp      VARCHAR(20),
  -- Targets configurados pelo usuario
  cpa_target    NUMERIC(12, 2) DEFAULT 50.00,
  roas_target   NUMERIC(8, 4)  DEFAULT 2.0,
  roas_breakeven NUMERIC(8, 4) DEFAULT 1.0,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INTEGRACOES (Meta Ads, Hotmart, Kiwify) ────────────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  platform         VARCHAR(50) NOT NULL,   -- meta_ads | hotmart | kiwify
  access_token     TEXT,                   -- criptografado
  refresh_token    TEXT,                   -- criptografado
  token_expires_at TIMESTAMPTZ,
  account_id       VARCHAR(255),
  account_name     VARCHAR(255),
  meta             JSONB DEFAULT '{}',
  is_active        BOOLEAN DEFAULT TRUE,
  last_synced_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrations_user ON integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_platform ON integrations(user_id, platform);

-- ─── CAMPANHAS (Meta Ads) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  integration_id  UUID REFERENCES integrations(id),
  external_id     VARCHAR(255) NOT NULL,
  name            VARCHAR(500) NOT NULL,
  status          VARCHAR(50),             -- ACTIVE | PAUSED | DELETED
  objective       VARCHAR(100),
  daily_budget    NUMERIC(12, 2) DEFAULT 0,
  lifetime_budget NUMERIC(12, 2) DEFAULT 0,
  start_time      TIMESTAMPTZ,
  stop_time       TIMESTAMPTZ,
  meta            JSONB DEFAULT '{}',
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_external ON campaigns(user_id, external_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);

-- ─── METRICAS DE ANUNCIO (Serie Temporal) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_metrics (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  campaign_id  UUID REFERENCES campaigns(id),
  adset_id     VARCHAR(255),
  ad_id        VARCHAR(255),
  date         DATE NOT NULL,
  spend        NUMERIC(12, 4) DEFAULT 0,
  impressions  INTEGER DEFAULT 0,
  clicks       INTEGER DEFAULT 0,
  reach        INTEGER DEFAULT 0,
  cpm          NUMERIC(12, 4) DEFAULT 0,
  ctr          NUMERIC(8, 6) DEFAULT 0,
  cpc          NUMERIC(12, 4) DEFAULT 0,
  link_clicks  INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_metrics_user_date ON ad_metrics(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_ad_metrics_campaign ON ad_metrics(campaign_id, date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_metrics_unique ON ad_metrics(ad_id, date) WHERE ad_id IS NOT NULL;

-- ─── VENDAS (Hotmart / Kiwify) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  integration_id UUID REFERENCES integrations(id),
  external_id    VARCHAR(255) NOT NULL,
  platform       VARCHAR(50) NOT NULL,    -- hotmart | kiwify
  product_id     VARCHAR(255),
  product_name   VARCHAR(500),
  status         VARCHAR(50) NOT NULL,    -- approved | refunded | chargeback | pending
  gross_revenue  NUMERIC(12, 4) NOT NULL,
  platform_fee   NUMERIC(12, 4) DEFAULT 0,
  net_revenue    NUMERIC(12, 4) NOT NULL,
  currency       VARCHAR(10) DEFAULT 'BRL',
  buyer_email    VARCHAR(255),
  utm_source     VARCHAR(255),
  utm_campaign   VARCHAR(255),
  utm_medium     VARCHAR(255),
  utm_content    VARCHAR(255),
  sale_date      TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_user_date ON sales(user_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_utm_campaign ON sales(utm_campaign, sale_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_external ON sales(user_id, platform, external_id);

-- ─── SNAPSHOTS DE LUCRO (Cache Persistente) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS profit_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  campaign_id  UUID REFERENCES campaigns(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  total_spend  NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_revenue NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_profit NUMERIC(12, 4) NOT NULL DEFAULT 0,
  roas         NUMERIC(8, 4) DEFAULT 0,
  cpa          NUMERIC(12, 4) DEFAULT 0,
  ctr          NUMERIC(8, 6) DEFAULT 0,
  cpm          NUMERIC(12, 4) DEFAULT 0,
  conversions  INTEGER DEFAULT 0,
  impressions  INTEGER DEFAULT 0,
  clicks       INTEGER DEFAULT 0,
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profit_user_period ON profit_snapshots(user_id, period_start DESC);

-- ─── DECISOES DO MOTOR DE IA ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  campaign_id    UUID REFERENCES campaigns(id),
  type           VARCHAR(100) NOT NULL,
  severity       SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 10),
  title          VARCHAR(500) NOT NULL,
  description    TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  action_type    VARCHAR(100),
  data_snapshot  JSONB DEFAULT '{}',
  is_read        BOOLEAN DEFAULT FALSE,
  is_acted       BOOLEAN DEFAULT FALSE,
  triggered_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_severity ON decisions(user_id, severity DESC, triggered_at DESC);

-- ─── INSIGHTS DA IA (GPT-4o) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_insights (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(100) DEFAULT 'daily_report',
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  prompt_used     TEXT,
  raw_response    TEXT,
  summary         TEXT,
  recommendations JSONB DEFAULT '[]',
  model_used      VARCHAR(100) DEFAULT 'gpt-4o',
  tokens_used     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_user ON ai_insights(user_id, created_at DESC);

-- ─── LOG DE ALERTAS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES decisions(id),
  channel     VARCHAR(50) NOT NULL,
  recipient   VARCHAR(255),
  status      VARCHAR(50),
  error_message TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_logs_user ON alert_logs(user_id, sent_at DESC);

-- ============================================================
-- PRONTO! Todas as tabelas foram criadas com sucesso.
-- Volte ao guia para o proximo passo.
-- ============================================================
