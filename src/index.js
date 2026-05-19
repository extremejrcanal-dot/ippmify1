require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');

// Rotas
const authRoutes         = require('./routes/auth');
const metricsRoutes      = require('./routes/metrics');
const decisionsRoutes    = require('./routes/decisions');
const insightsRoutes     = require('./routes/insights');
const integrationsRoutes = require('./routes/integrations');
const reportsRoutes      = require('./routes/reports');
const benchmarksRoutes   = require('./routes/benchmarks');

// Workers
const { startSyncScheduler } = require('./workers/syncWorker');

const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARES DE SEGURANCA ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Permite o frontend carregar recursos externos
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300,                  // 300 requests por IP a cada 15 min
  message: { error: 'Muitas requisicoes. Aguarde alguns minutos.' }
});
app.use(globalLimiter);

// Rate limiting mais restrito para autenticacao
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'IPPMIFY API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ─── FRONTEND ESTATICO ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── ROTAS DA API ──────────────────────────────────────────────────────────
app.use('/api/auth',         authLimiter, authRoutes);
app.use('/api/metrics',      metricsRoutes);
app.use('/api/decisions',    decisionsRoutes);
app.use('/api/insights',     insightsRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/reports',      reportsRoutes);
app.use('/api/benchmarks',   benchmarksRoutes);

// Rota raiz → retorna o app frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Rota nao encontrada (apenas para rotas /api/*)
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Rota nao encontrada',
    path: req.originalUrl
  });
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

  // Iniciar schedulers automaticos
  startSyncScheduler();
});

module.exports = app;
