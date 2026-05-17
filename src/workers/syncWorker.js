const cron = require('node-cron');
const { query } = require('../config/database');
const { runDecisionEngine } = require('../services/decisionEngine');
const { generateInsights } = require('../services/aiInsights');
const { sendAlert, sendDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');
const { sendDailyWhatsAppReport } = require('../services/reportService');

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

// Executar ciclo completo para um usuario
const runFullCycleForUser = async (userId) => {
  try {
    console.log(`[Worker] Iniciando ciclo para usuario ${userId}`);

    // 1. Rodar motor de decisao
    const result = await runDecisionEngine(userId);

    // 2. Enviar alertas para decisoes criticas
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

  // Todos os dias as 07:00 BRT (10:00 UTC): relatorio WhatsApp
  cron.schedule('0 10 * * *', async () => {
    console.log('[Worker] Enviando relatorios diarios via WhatsApp (07:00 BRT)');
    const users = await getActiveUsers();

    for (const user of users) {
      try {
        const sent = await sendDailyWhatsAppReport(user.id);
        if (sent) console.log(`[Worker] WhatsApp report enviado: ${user.email}`);
      } catch (err) {
        console.error(`[Worker] Erro WhatsApp report ${user.email}:`, err.message);
      }
    }
  });

  console.log('[Worker] Schedulers iniciados:');
  console.log('  - Motor de decisao: a cada 15 minutos');
  console.log('  - Relatorio diario com IA: 06:00 BRT');
};

module.exports = { startSyncScheduler, runFullCycleForUser };
