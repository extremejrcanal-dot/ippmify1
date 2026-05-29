require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Rotas
const authRoutes         = require('./routes/auth');
const metricsRoutes      = require('./routes/metrics');
const decisionsRoutes    = require('./routes/decisions');
const insightsRoutes     = require('./routes/insights');
const integrationsRoutes = require('./routes/integrations');
const reportsRoutes      = require('./routes/reports');
const benchmarksRoutes   = require('./routes/benchmarks');
const offersRoutes       = require('./routes/offers');
const creativesRoutes    = require('./routes/creatives');
const webhookRoutes      = require('./routes/webhook');

// Middleware de autenticacao e plano
const { requireAuth, requireActivePlan } = require('./middleware/auth');

// Workers
const { startSyncScheduler } = require('./workers/syncWorker');

// Database
const { query } = require('./config/database');

// Migrations automaticas
const runMigrations = async () => {
  try {
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_key VARCHAR(50) DEFAULT NULL;");
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ
                 DEFAULT (NOW() + INTERVAL '2 days');`);
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ DEFAULT NULL;");
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS cakto_subscriber_id VARCHAR(120) DEFAULT NULL;");
    await query(`UPDATE users SET trial_expires_at = created_at + INTERVAL '2 days'
                 WHERE trial_expires_at IS NULL;`);
    await query("ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'trial';");

    await query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_integrations_user_platform') THEN
        DELETE FROM integrations WHERE id NOT IN (
          SELECT DISTINCT ON (user_id, platform) id FROM integrations ORDER BY user_id, platform, created_at DESC
        );
        ALTER TABLE integrations ADD CONSTRAINT uq_integrations_user_platform UNIQUE (user_id, platform);
      END IF;
    END $$;`);

    await query(`CREATE TABLE IF NOT EXISTS offers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      price NUMERIC(12,2) DEFAULT 0,
      cost NUMERIC(12,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await query("CREATE INDEX IF NOT EXISTS idx_offers_user ON offers(user_id);");

    await query(`CREATE TABLE IF NOT EXISTS offer_campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
      campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(offer_id, campaign_id)
    );`);

    await query("CREATE INDEX IF NOT EXISTS idx_offer_campaigns_offer ON offer_campaigns(offer_id);");
    await query("CREATE INDEX IF NOT EXISTS idx_offer_campaigns_campaign ON offer_campaigns(campaign_id);");

    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;");
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS report_freq INT DEFAULT 0;");
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS report_times VARCHAR(100) DEFAULT NULL;");

    console.log('[Migrations] OK');
  } catch (err) {
    console.error('[Migrations] Erro:', err.message);
  }
};

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Muitas requisicoes. Aguarde alguns minutos.' }
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'IPPMIFY API', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── ROTAS PUBLICAS (sem verificacao de plano) ────────────────────────────────
app.use('/api/auth',    authLimiter, authRoutes);   // login, registro, /me, /settings
app.use('/api/webhook', webhookRoutes);             // Kirvano / Cakto (billing IPPMIFY)
app.use('/api/hook',    integrationsRoutes);        // Webhooks publicos das plataformas (Stripe, MP, etc)

// ─── ROTAS PROTEGIDAS (exigem login + plano ativo) ───────────────────────────
// requireAuth seta req.user; requireActivePlan bloqueia se plan_status !== 'active'
app.use('/api/metrics',      requireAuth, requireActivePlan, metricsRoutes);
app.use('/api/decisions',    requireAuth, requireActivePlan, decisionsRoutes);
app.use('/api/insights',     requireAuth, requireActivePlan, insightsRoutes);
app.use('/api/integrations', requireAuth, requireActivePlan, integrationsRoutes);
app.use('/api/reports',      requireAuth, requireActivePlan, reportsRoutes);
app.use('/api/benchmarks',   requireAuth, requireActivePlan, benchmarksRoutes);
app.use('/api/offers',       requireAuth, requireActivePlan, offersRoutes);
app.use('/api/creatives',    requireAuth, requireActivePlan, creativesRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Rota nao encontrada', path: req.originalUrl });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         IPPMIFY - Profit Engine          ║');
  console.log('║      Decisoes Automaticas de Lucro       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('[Server] Porta: ' + PORT);
  console.log('[Server] Ambiente: ' + (process.env.NODE_ENV || 'development'));
  console.log('');

  await runMigrations();
  startSyncScheduler();
});

module.exports = app;
