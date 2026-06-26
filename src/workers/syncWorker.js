const cron = require('node-cron');
const { query } = require('../config/database');
const { runDecisionEngine } = require('../services/decisionEngine');
const { generateInsights } = require('../services/aiInsights');
const { sendAlert, sendDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');
// Google Ads service — carregado opcionalmente
let syncGoogleAds = null;
try {
  syncGoogleAds = require('../services/googleAdsService').syncGoogleAds;
} catch (e) {
  console.warn('[Worker] googleAdsService nao encontrado — sync Google Ads desativado');
}

// ─── WORKER DE SINCRONIZACAO E AUTOMACAO ──────────────────────────────────
// Roda em background automaticamente

// Buscar todos os usuarios ativos
const getActiveUsers = async () => {
  const result = await query(
    "SELECT id, email, timezone FROM users WHERE is_active = true",
    []
  );
  return result.rows;
};

// Sincronizar Google Ads para um usuario (se tiver integracao ativa)
const syncGoogleAdsForUser = async (userId) => {
  if (!syncGoogleAds) return; // servico nao disponivel
  try {
    const result = await query(
      `SELECT * FROM integrations
       WHERE user_id = $1 AND platform = 'google_ads' AND is_active = true
       LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) return;

    const { campaigns, metrics } = await syncGoogleAds(userId, result.rows[0]);
    console.log(`[Worker] Google Ads sincronizado para ${userId}: ${campaigns} campanhas, ${metrics} metricas`);
  } catch (err) {
    console.error(`[Worker] Erro sync Google Ads ${userId}:`, err.message);
  }
};

// Executar ciclo completo para um usuario
const runFullCycleForUser = async (userId) => {
  try {
    console.log(`[Worker] Iniciando ciclo para usuario ${userId}`);

    // 1. Sincronizar Google Ads (se conectado)
    await syncGoogleAdsForUser(userId);

    // 2. Rodar motor de decisao
    const result = await runDecisionEngine(userId);

    // 3. Enviar alertas para decisoes criticas
    for (const decision of result.critical) {
      await sendAlert(userId, decision);
    }

    console.log(`[Worker] Ciclo concluido para ${userId}: ${result.all.length} decisoes, ${result.critical.length} alertas`);
  } catch (error) {
    console.error(`[Worker] Erro no ciclo do usuario ${userId}:`, error.message);
  }
};

// Ciclo de analise automatica (a cada 15 minutos)
const startSyncScheduler = () => {
  // A cada 15 minutos: rodar motor de decisao para todos os usuarios
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Worker] Iniciando ciclo de analise automatica (15min)');
    const users = await getActiveUsers();
    for (const user of users) {
      await runFullCycleForUser(user.id);
    }
    console.log(`[Worker] Ciclo concluido para ${users.length} usuarios`);
  });

  // Todos os dias as 06:00 BRT (09:00 UTC): relatorio diario com IA
  cron.schedule('0 9 * * *', async () => {
    console.log('[Worker] Gerando relatorios diarios com IA (06:00 BRT)');
    const users = await getActiveUsers();

    for (const user of users) {
      try {
        const insights = await generateInsights(user.id, 7);
        const metrics  = await calculateOverview(user.id, 7);
        await sendDailyReport(user.id, metrics, insights);
        console.log(`[Worker] Relatorio diario enviado para ${user.email}`);
      } catch (err) {
        console.error(`[Worker] Erro relatorio diario ${user.email}:`, err.message);
      }
    }
  });

  console.log('[Worker] Schedulers iniciados:');
  console.log('  - Motor de decisao: a cada 15 minutos');
  console.log('  - Relatorio diario com IA: 06:00 BRT');
};

module.exports = { startSyncScheduler, runFullCycleForUser };
