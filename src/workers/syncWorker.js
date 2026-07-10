const cron = require('node-cron');
const { query } = require('../config/database');
const { setEx, exists } = require('../config/redis');
const { runDecisionEngine } = require('../services/decisionEngine');
const { generateInsights } = require('../services/aiInsights');
const { sendAlert, sendDailyReport, sendWhatsAppDailyReport } = require('../services/alertService');
const { calculateOverview } = require('../services/metricsEngine');

// Google Ads service -- carregado opcionalmente
let syncGoogleAds = null;
try {
  syncGoogleAds = require('../services/googleAdsService').syncGoogleAds;
} catch (e) {
  console.warn('[Worker] googleAdsService nao encontrado -- sync Google Ads desativado');
}

// Meta Ads service -- carregado opcionalmente
let runMetaAdsSync = null;
try {
  runMetaAdsSync = require('../services/metaAds').runFullSync;
} catch (e) {
  console.warn('[Worker] metaAds nao encontrado -- sync automatico Meta Ads desativado');
}

// Buscar todos os usuarios ativos com campos de agendamento
const getActiveUsers = async () => {
  const result = await query(
    `SELECT id, email, timezone, whatsapp, whatsapp_key,
            report_freq, report_times, report_days
     FROM users
     WHERE is_active = true
       AND (plan IN ('active','trial'))
       AND (
         (plan = 'active' AND (plan_expires_at IS NULL OR plan_expires_at > NOW()))
         OR
         (plan = 'trial'  AND (trial_expires_at IS NULL OR trial_expires_at > NOW()))
       )`,
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
    console.log('[Worker] Google Ads sincronizado para ' + userId + ': ' + campaigns + ' campanhas, ' + metrics + ' metricas');
  } catch (err) {
    console.error('[Worker] Erro sync Google Ads ' + userId + ':', err.message);
  }
};

// Executar ciclo completo para um usuario (decisoes + alertas)
const runFullCycleForUser = async (userId) => {
  try {
    console.log('[Worker] Iniciando ciclo para usuario ' + userId);
    await syncGoogleAdsForUser(userId);
    const result = await runDecisionEngine(userId);
    for (const decision of result.critical) {
      await sendAlert(userId, decision);
    }
    console.log('[Worker] Ciclo concluido para ' + userId + ': ' + result.all.length + ' decisoes, ' + result.critical.length + ' alertas');
  } catch (error) {
    console.error('[Worker] Erro no ciclo do usuario ' + userId + ':', error.message);
  }
};

// --- RELATORIO WHATSAPP AGENDADO POR USUARIO ---
const checkAndSendWhatsAppReports = async (users) => {
  const now = new Date();

  for (const user of users) {
    try {
      if (!user.whatsapp || !user.whatsapp_key) continue;
      const freq = parseInt(user.report_freq || 0);
      if (freq === 0) continue;
      if (!user.report_times || user.report_times.trim() === '') continue;

      const tz      = user.timezone || 'America/Sao_Paulo';
      const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const hh      = String(nowInTz.getHours()).padStart(2, '0');
      const slot5   = String(Math.floor(nowInTz.getMinutes() / 5) * 5).padStart(2, '0');

      const configuredTimes = user.report_times.split(',').map(t => t.trim()).filter(Boolean);
      const shouldSend = configuredTimes.some(configTime => {
        if (!configTime.match(/^\d{2}:\d{2}$/)) return false;
        const [ch, cm] = configTime.split(':').map(Number);
        const nowMin   = nowInTz.getHours() * 60 + nowInTz.getMinutes();
        const cfgMin   = ch * 60 + cm;
        return nowMin >= cfgMin && nowMin < cfgMin + 5;
      });
      if (!shouldSend) continue;

      const dateStr = nowInTz.getFullYear() + '-' + String(nowInTz.getMonth()+1).padStart(2,'0') + '-' + String(nowInTz.getDate()).padStart(2,'0');
      const slotKey = 'report:wpp:' + user.id + ':' + dateStr + ':' + hh + ':' + slot5;
      if (await exists(slotKey)) continue;
      await setEx(slotKey, '1', 10 * 60);

      const days = parseInt(user.report_days || 7);
      console.log('[Worker] Enviando relatorio WhatsApp para ' + user.email + ' (' + hh + ':' + slot5 + ' ' + tz + ')');

      const [metrics, insights] = await Promise.all([
        calculateOverview(user.id, days),
        generateInsights(user.id, days).catch(() => ({ top_action: 'Monitore suas campanhas', insights: [] })),
      ]);

      await sendWhatsAppDailyReport(user.id, metrics, insights);
      console.log('[Worker] Relatorio WhatsApp enviado com sucesso para ' + user.email);

    } catch (err) {
      console.error('[Worker] Erro relatorio WhatsApp ' + user.email + ':', err.message);
    }
  }
};

// --- INICIAR SCHEDULERS ---
const startSyncScheduler = () => {

  // A cada 15 minutos: motor de decisao + alertas criticos
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Worker] Iniciando ciclo de analise automatica (15min)');
    try {
      const users = await getActiveUsers();
      for (const user of users) {
        await runFullCycleForUser(user.id);
      }
      console.log('[Worker] Ciclo concluido para ' + users.length + ' usuarios');
    } catch (err) {
      console.error('[Worker] Erro no ciclo de analise:', err.message);
    }
  });

  // A cada 2 minutos: sincronizar Meta Ads para todos os usuarios ativos com integracao
  cron.schedule('*/2 * * * *', async () => {
    if (!runMetaAdsSync) return;
    console.log('[Worker] Iniciando sync automatico Meta Ads (2min)');
    try {
      const users = await getActiveUsers();
      for (const user of users) {
        try {
          const intResult = await query(
            `SELECT id FROM integrations WHERE user_id=$1 AND platform='meta_ads' AND is_active=true LIMIT 1`,
            [user.id]
          );
          if (intResult.rows.length === 0) continue;
          await runMetaAdsSync(user.id);
          console.log('[Worker] Meta Ads sincronizado para usuario ' + user.id);
        } catch (err) {
          console.error('[Worker] Erro sync Meta Ads usuario ' + user.id + ':', err.message);
        }
      }
    } catch (err) {
      console.error('[Worker] Erro no cron de sync Meta Ads:', err.message);
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

  // 03:00 UTC (00:00 BRT): expirar planos vencidos automaticamente
  cron.schedule('0 3 * * *', async () => {
    console.log('[Worker] Verificando planos expirados...');
    try {
      const expired = await query(
        `UPDATE users
         SET plan = 'expired', updated_at = NOW()
         WHERE plan = 'active'
           AND plan_expires_at IS NOT NULL
           AND plan_expires_at < NOW()
         RETURNING id, email`,
        []
      );
      if (expired.rows.length > 0) {
        console.log('[Worker] Planos expirados automaticamente:');
        expired.rows.forEach(u => console.log('  - ' + u.email));
      } else {
        console.log('[Worker] Nenhuma assinatura expirada hoje.');
      }
      const trials = await query(
        `UPDATE users
         SET plan = 'expired', updated_at = NOW()
         WHERE plan = 'trial'
           AND trial_expires_at IS NOT NULL
           AND trial_expires_at < NOW()
         RETURNING id, email`,
        []
      );
      if (trials.rows.length > 0) {
        console.log('[Worker] Trials expirados automaticamente:');
        trials.rows.forEach(u => console.log('  - ' + u.email));
      }
    } catch (err) {
      console.error('[Worker] Erro ao expirar planos:', err.message);
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
          console.log('[Worker] Relatorio email enviado para ' + user.email);
        } catch (err) {
          console.error('[Worker] Erro relatorio email ' + user.email + ':', err.message);
        }
      }
    } catch (err) {
      console.error('[Worker] Erro no cron de email:', err.message);
    }
  });

  console.log('[Worker] Schedulers iniciados:');
  console.log('  - Sync automatico Meta Ads:    a cada 2 minutos');
  console.log('  - Motor de decisao:            a cada 15 minutos');
  console.log('  - Relatorio WhatsApp agendado: a cada 5 minutos (por horario do usuario)');
  console.log('  - Expirar planos vencidos:     00:00 BRT (03:00 UTC) diariamente');
  console.log('  - Relatorio diario por email:  06:00 BRT (09:00 UTC)');
};

module.exports = { startSyncScheduler, runFullCycleForUser };
