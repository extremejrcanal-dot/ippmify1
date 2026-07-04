const cron = require('node-cron');
const { query } = require('../config/database');
const { setEx, exists } = require('../config/redis');
const { runDecisionEngine } = require('../services/decisionEngine');
const { generateInsights } = require('../services/aiInsights');
const { sendAlert, sendDailyReport, sendWhatsAppDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');

// Google Ads service — carregado opcionalmente
let syncGoogleAds = null;
try {
  syncGoogleAds = require('../services/googleAdsService').syncGoogleAds;
} catch (e) {
  console.warn('[Worker] googleAdsService nao encontrado — sync Google Ads desativado');
}

// ─── WORKER DE SINCRONIZACAO E AUTOMACAO ──────────────────────────────────

// Buscar todos os usuarios ativos com campos de agendamento
const getActiveUsers = async () => {
  const result = await query(
    `SELECT id, email, timezone, whatsapp, whatsapp_key,
            report_freq, report_times, report_days
     FROM users WHERE is_active = true`,
    []
  );
  return result.rows;
};

// Sincronizar Google Ads para um usuario (se tiver integracao ativa)
const syncGoogleAdsForUser = async (userId) => {
  if (!syncGoogleAds) return;
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

// Executar ciclo completo para um usuario (decisoes + alertas)
const runFullCycleForUser = async (userId) => {
  try {
    console.log(`[Worker] Iniciando ciclo para usuario ${userId}`);
    await syncGoogleAdsForUser(userId);
    const result = await runDecisionEngine(userId);
    for (const decision of result.critical) {
      await sendAlert(userId, decision);
    }
    console.log(`[Worker] Ciclo concluido para ${userId}: ${result.all.length} decisoes, ${result.critical.length} alertas`);
  } catch (error) {
    console.error(`[Worker] Erro no ciclo do usuario ${userId}:`, error.message);
  }
};

// ─── RELATORIO WHATSAPP AGENDADO POR USUARIO ──────────────────────────────
// Verifica a cada 5min se algum usuario deve receber o relatorio agora.
// Compara hora atual (no timezone do usuario) com os horarios configurados.
// Usa Redis para evitar envio duplicado dentro da mesma janela.
const checkAndSendWhatsAppReports = async (users) => {
  const now = new Date();

  for (const user of users) {
    try {
      // Pular usuarios sem configuracao de WhatsApp ou agendamento desativado
      if (!user.whatsapp || !user.whatsapp_key) continue;
      const freq = parseInt(user.report_freq || 0);
      if (freq === 0) continue;
      if (!user.report_times || user.report_times.trim() === '') continue;

      // Hora atual no timezone do usuario
      const tz      = user.timezone || 'America/Sao_Paulo';
      const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const hh      = String(nowInTz.getHours()).padStart(2, '0');
      const slot5   = String(Math.floor(nowInTz.getMinutes() / 5) * 5).padStart(2, '0');

      // Verificar se horario atual bate com algum horario configurado
      // Tolerancia: janela de 5 minutos (ex: "08:00" dispara de 08:00 a 08:04)
      const configuredTimes = user.report_times.split(',').map(t => t.trim()).filter(Boolean);
      const shouldSend = configuredTimes.some(configTime => {
        if (!configTime.match(/^\d{2}:\d{2}$/)) return false;
        const [ch, cm] = configTime.split(':').map(Number);
        const nowMin   = nowInTz.getHours() * 60 + nowInTz.getMinutes();
        const cfgMin   = ch * 60 + cm;
        return nowMin >= cfgMin && nowMin < cfgMin + 5;
      });
      if (!shouldSend) continue;

      // Chave de dedup no Redis — evita re-envio dentro da mesma janela
      const dateStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth()+1).padStart(2,'0')}-${String(nowInTz.getDate()).padStart(2,'0')}`;
      const slotKey = `report:wpp:${user.id}:${dateStr}:${hh}:${slot5}`;
      if (await exists(slotKey)) continue;

      // Marcar como enviando antes de gerar (TTL 10 minutos — maior que a janela)
      await setEx(slotKey, '1', 10 * 60);

      // Gerar metricas e insights, depois enviar
      const days = parseInt(user.report_days || 7);
      console.log(`[Worker] Enviando relatorio WhatsApp para ${user.email} (${hh}:${slot5} ${tz})`);

      const [metrics, insights] = await Promise.all([
        calculateOverview(user.id, days),
        generateInsights(user.id, days).catch(() => ({ top_action: 'Monitore suas campanhas', insights: [] })),
      ]);

      await sendWhatsAppDailyReport(user.id, metrics, insights);
      console.log(`[Worker] Relatorio WhatsApp enviado com sucesso para ${user.email}`);

    } catch (err) {
      console.error(`[Worker] Erro relatorio WhatsApp ${user.email}:`, err.message);
    }
  }
};

// ─── INICIAR SCHEDULERS ────────────────────────────────────────────────────
const startSyncScheduler = () => {

  // A cada 15 minutos: motor de decisao + alertas criticos
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Worker] Iniciando ciclo de analise automatica (15min)');
    try {
      const users = await getActiveUsers();
      for (const user of users) {
        await runFullCycleForUser(user.id);
      }
      console.log(`[Worker] Ciclo concluido para ${users.length} usuarios`);
    } catch (err) {
      console.error('[Worker] Erro no ciclo de analise:', err.message);
    }
  });

  // A cada 5 minutos: checar relatorios WhatsApp agendados
  cron.schedule('*/5 * * * *', async () => {
    try {
      const users = await getActiveUsers();
      await checkAndSendWhatsAppReports(users);
    } catch (err) {
      console.error('[Worker] Erro no scheduler WhatsApp:', err.message);
    }
  });

  // 06:00 BRT (09:00 UTC): relatorio diario por email (SendGrid)
  cron.schedule('0 9 * * *', async () => {
    console.log('[Worker] Gerando relatorios diarios por email (06:00 BRT)');
    try {
      const users = await getActiveUsers();
      for (const user of users) {
        try {
          const insights = await generateInsights(user.id, 7);
          const metrics  = await calculateOverview(user.id, 7);
          await sendDailyReport(user.id, metrics, insights);
          console.log(`[Worker] Relatorio email enviado para ${user.email}`);
        } catch (err) {
          console.error(`[Worker] Erro relatorio email ${user.email}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[Worker] Erro no cron de email:', err.message);
    }
  });

  console.log('[Worker] Schedulers iniciados:');
  console.log('  - Motor de decisao:            a cada 15 minutos');
  console.log('  - Relatorio WhatsApp agendado: a cada 5 minutos (por horario do usuario)');
  console.log('  - Relatorio diario por email:  06:00 BRT (09:00 UTC)');
};

module.exports = { startSyncScheduler, runFullCycleForUser };
