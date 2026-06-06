const cron = require('node-cron');
const { query } = require('../config/database');
const { runDecisionEngine } = require('../services/decisionEngine');
const { generateInsights } = require('../services/aiInsights');
const { sendAlert, sendDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');
const { sendDailyWhatsAppReport } = require('../services/reportService');

// ─── WORKER DE SINCRONIZACAO E AUTOMACAO ─────────────────────────────────────

// Buscar todos os usuarios ativos com plano ativo
// Espelha a logica do middleware: plan='active' nao expirado, OU is_admin=true
const getActiveUsers = async () => {
  const result = await query(
    `SELECT id, email, timezone, report_freq, report_times, report_days FROM users
     WHERE is_active = true
       AND (
         is_admin = true
         OR (plan = 'active' AND (plan_expires_at IS NULL OR plan_expires_at > NOW()))
       )`,
    []
  );
  return result.rows;
};

// Executar ciclo completo para um usuario
const runFullCycleForUser = async (userId) => {
  try {
    console.log(`[Worker] Iniciando ciclo para usuario ${userId}`);
    const result = await runDecisionEngine(userId);
    for (const decision of result.critical) {
      await sendAlert(userId, decision);
    }
    console.log(`[Worker] Ciclo concluido para ${userId}: ${result.all.length} decisoes, ${result.critical.length} alertas`);
  } catch (error) {
    console.error(`[Worker] Erro no ciclo do usuario ${userId}:`, error.message);
  }
};

// Verificar se o horario atual bate com algum horario agendado do usuario
const shouldSendReportNow = (reportTimes, currentHour, currentMinute) => {
  if (!reportTimes) return false;
  const times = reportTimes.split(',').map(t => t.trim());
  return times.some(t => {
    const [h, m] = t.split(':').map(Number);
    return h === currentHour && (m === currentMinute || (!m && currentMinute === 0));
  });
};

const startSyncScheduler = () => {

  // ── A cada 15 minutos: motor de decisao ──────────────────────────────────
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Worker] Ciclo de analise automatica (15min)');
    const users = await getActiveUsers();
    for (const user of users) {
      await runFullCycleForUser(user.id);
    }
    console.log(`[Worker] Ciclo concluido para ${users.length} usuarios`);
  });

  // ── A cada hora exata: relatorio IA (06:00 BRT = 09:00 UTC) ─────────────
  cron.schedule('0 9 * * *', async () => {
    console.log('[Worker] Relatorio diario com IA (06:00 BRT)');
    const users = await getActiveUsers();
    for (const user of users) {
      try {
        const insights = await generateInsights(user.id, 7);
        const metrics  = await calculateOverview(user.id, 7);
        await sendDailyReport(user.id, metrics, insights);
        console.log(`[Worker] Relatorio IA enviado: ${user.email}`);
      } catch (err) {
        console.error(`[Worker] Erro relatorio IA ${user.email}:`, err.message);
      }
    }
  });

  // ── A cada minuto: checar agendamento personalizado de WhatsApp ──────────
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    // Usar horario de Brasilia (UTC-3)
    const brtHour   = (now.getUTCHours() - 3 + 24) % 24;
    const brtMinute = now.getUTCMinutes();

    // So processar no minuto 0 de cada hora (ex: 08:00, 14:00, 20:00)
    if (brtMinute !== 0) return;

    console.log(`[Worker] Verificando relatorios agendados para ${brtHour}:00 BRT`);

    const users = await getActiveUsers();
    for (const user of users) {
      if (!user.report_freq || user.report_freq === 0) continue;
      if (!shouldSendReportNow(user.report_times, brtHour, 0)) continue;

      try {
        const days = user.report_days || 7;
        const sent = await sendDailyWhatsAppReport(user.id, days);
        if (sent) {
          console.log(`[Worker] WhatsApp agendado enviado para ${user.email} as ${brtHour}:00 BRT (${days} dias)`);
        } else {
          console.log(`[Worker] WhatsApp nao configurado para ${user.email} — pulando`);
        }
      } catch (err) {
        console.error(`[Worker] Erro WhatsApp ${user.email}:`, err.message);
      }
    }
  });

  console.log('[Worker] Schedulers iniciados:');
  console.log('  - Motor de decisao: a cada 15 minutos');
  console.log('  - Relatorio IA: 06:00 BRT');
  console.log('  - Relatorio WhatsApp personalizado: verificacao a cada hora');
};

module.exports = { startSyncScheduler, runFullCycleForUser };
