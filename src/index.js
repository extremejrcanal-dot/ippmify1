require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

// Rotas
const authRoutes         = require('./routes/auth');
const metricsRoutes      = require('./routes/metrics');
const decisionsRoutes    = require('./routes/decisions');
const insightsRoutes     = require('./routes/insights');
const reportsRoutes      = require('./routes/reports');
const integrationsRoutes = require('./routes/integrations');
const benchmarksRoutes   = require('./routes/benchmarks');

// webhooks — carregado opcionalmente para nao crashar se arquivo nao existir
let webhooksRoutes = null;
try {
  webhooksRoutes = require('./routes/webhooks');
} catch (e) {
  console.warn('[Server] webhooks.js nao encontrado — rota /api/webhook desativada');
}

// Workers
const { startSyncScheduler } = require('./workers/syncWorker');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARES DE SEGURANCA ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting global
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

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'IPPMIFY API', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ─── ROTAS DA API ──────────────────────────────────────────────────────────
app.use('/api/auth',         authLimiter, authRoutes);
app.use('/api/metrics',      metricsRoutes);
app.use('/api/decisions',    decisionsRoutes);
app.use('/api/insights',     insightsRoutes);
app.use('/api/reports',      reportsRoutes);
app.use('/api/integrations', integrationsRoutes);
if (webhooksRoutes) {
  app.use('/api/webhook', webhooksRoutes);     // SEM auth — Kirvano/Cakto planos + Hotmart/Kiwify vendas
}
app.use('/api/benchmarks',   benchmarksRoutes);

// ─── FRONTEND ESTATICO ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: 'Rota nao encontrada', path: req.originalUrl });
  }
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Handler global de erros
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ─── INICIALIZAR SERVIDOR ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         IPPMIFY - Profit Engine          ║');
  console.log('║      Decisoes Automaticas de Lucro       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`[Server] Rodando na porta ${PORT}`);
  console.log(`[Server] Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  startSyncScheduler();
});

module.exports = app;
