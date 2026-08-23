const { query } = require('../config/database');
const { exists, setEx } = require('../config/redis');

let _sgMail = null;
const getSendGrid = () => {
  if (!process.env.SENDGRID_API_KEY) return null;
  if (!_sgMail) {
    _sgMail = require('@sendgrid/mail');
    _sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }
  return _sgMail;
};

// ─── CALLMEBOT COM RETRY (3 tentativas, backoff 2s/4s) ───────────────────
const sendCallMeBot = async (phone, apiKey, message, attempt = 1) => {
  const https       = require('https');
  const encodedText = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&apikey=${apiKey}&text=${encodedText}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const status = res.statusCode;
        // CallMeBot aceita 2xx e alguns redirecionamentos como resposta válida
        if (status < 400) {
          console.log(`[CallMeBot] ✓ Enviado para ${phone} (status ${status})`);
          resolve({ success: true, status, body: data });
        } else {
          const err = new Error(`CallMeBot status ${status}: ${data.slice(0, 200)}`);
          err.status = status;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CallMeBot timeout')); });
  }).catch(async (err) => {
    if (attempt < 3) {
      const delay = attempt * 2000;
      console.warn(`[CallMeBot] Tentativa ${attempt} falhou: ${err.message}. Retry em ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return sendCallMeBot(phone, apiKey, message, attempt + 1);
    }
    throw err;
  });
};

// ─── CONTROLE DE THROTTLE ─────────────────────────────────────────────────
const COOLDOWN_SECONDS = { CRITICAL: 2 * 3600, HIGH: 4 * 3600, MODERATE: 24 * 3600 };
const getThrottleKey = (userId, ruleId) => `alert:throttle:${userId}:${ruleId}`;
const isThrottled    = async (userId, ruleId) => exists(getThrottleKey(userId, ruleId));
const setThrottle    = async (userId, ruleId, severity) => {
  const ttl = severity >= 9 ? COOLDOWN_SECONDS.CRITICAL
            : severity >= 7 ? COOLDOWN_SECONDS.HIGH
            : COOLDOWN_SECONDS.MODERATE;
  await setEx(getThrottleKey(userId, ruleId), '1', ttl);
};

// ─── FORMATAR MENSAGEM WHATSAPP ───────────────────────────────────────────
const formatWhatsAppMessage = (decision, userName) => {
  const emoji = decision.severity >= 9 ? '🚨' : decision.severity >= 7 ? '⚠️' : '📊';
  const snap  = decision.data_snapshot || {};
  const confLine = snap.confianca ? `\nConfiança: ${snap.confianca.toUpperCase()}` : '';
  const dispLine = snap.display_text ? `\n${snap.display_text}` : `\n${decision.description}`;
  const revLine  = snap.quando_revisar ? `\n📅 Revisar: ${snap.quando_revisar}` : '';
  return `${emoji} IPPMIFY ALERTA

Olá, ${userName}!
Campanha: ${decision.campaign_name || 'Geral'}
Problema: ${decision.title}${confLine}${dispLine}

✅ O que fazer:
${decision.recommendation}${revLine}

⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
— IPPMIFY Profit Intelligence`;
};

// ─── FORMATAR EMAIL ────────────────────────────────────────────────────────
const formatEmailHtml = (decision, userName) => {
  const color = decision.severity >= 9 ? '#C62828' : decision.severity >= 7 ? '#F57F17' : '#1A237E';
  const snap = decision.data_snapshot || {};
  const confBadge = snap.confianca ? `<span style="background:${snap.confianca==='alta'?'#1a3a1a':snap.confianca==='media'?'#3a2a00':'#222'};color:${snap.confianca==='alta'?'#86efac':snap.confianca==='media'?'#fcd34d':'#9ca3af'};padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">${snap.confianca.toUpperCase()}</span>` : '';
  const mudaBlock = snap.o_que_muda ? `<div style="margin:10px 0;background:#e3f0ff;padding:12px;border-radius:6px;border-left:3px solid #3b82f6;font-size:12px;color:#1e3a5f"><strong>🔄 O que muda a recomendação:</strong><br>${snap.o_que_muda}</div>` : '';
  const impactoBlock = snap.impacto_financeiro ? `<div style="margin:10px 0;font-size:12px;color:#d97706"><strong>💰 Impacto:</strong> ${snap.impacto_financeiro}</div>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:${color};color:white;padding:20px;border-radius:8px 8px 0 0"><h1 style="margin:0;font-size:22px">IPPMIFY Alerta</h1><p style="margin:5px 0 0">Olá, ${userName}</p></div>
    <div style="padding:20px;border:1px solid #eee;border-radius:0 0 8px 8px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><h2 style="color:${color};margin:0">${decision.title}</h2>${confBadge}</div>
      <p><strong>Campanha:</strong> ${decision.campaign_name || 'Geral'}</p>
      <p>${snap.display_text || decision.description}</p>
      <div style="background:#E8F5E9;padding:15px;border-radius:6px;margin:15px 0"><strong>✅ O que fazer:</strong><br>${decision.recommendation}</div>
      ${mudaBlock}${impactoBlock}
      <hr style="border:1px solid #eee"><p style="color:#9E9E9E;font-size:12px">IPPMIFY | ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
    </div>
  </div>`;
};

// ─── ENVIAR ALERTA ─────────────────────────────────────────────────────────
const sendAlert = async (userId, decision) => {
  try {
    const userResult = await query('SELECT name, email, whatsapp, whatsapp_key FROM users WHERE id=$1', [userId]);
    if (userResult.rows.length === 0) return;
    const user   = userResult.rows[0];
    const ruleId = decision.rule_id || decision.type;

    if (await isThrottled(userId, ruleId)) {
      console.log(`[Alert] Throttled: ${ruleId} usuario ${userId}`);
      return { throttled: true };
    }

    const results = { whatsapp: null, email: null };

    if (decision.severity >= 7 && user.whatsapp && user.whatsapp_key) {
      try {
        await sendCallMeBot(user.whatsapp, user.whatsapp_key, formatWhatsAppMessage(decision, user.name));
        results.whatsapp = 'sent';
      } catch (err) {
        results.whatsapp = 'failed';
        console.error('[Alert] WhatsApp falhou após 3 tentativas:', err.message);
      }
    } else if (decision.severity >= 7 && user.whatsapp && !user.whatsapp_key) {
      results.whatsapp = 'no_key';
      console.warn('[Alert] whatsapp_key ausente — configure em Configurações > Alertas');
    }

    const sgMail = getSendGrid();
    if (user.email && sgMail) {
      try {
        const subject = decision.severity >= 9 ? `🚨 CRÍTICO: ${decision.title}` : `⚠️ ALERTA: ${decision.title}`;
        await sgMail.send({ to: user.email, from: process.env.EMAIL_FROM || 'noreply@ippmify.com', subject, html: formatEmailHtml(decision, user.name) });
        results.email = 'sent';
      } catch (err) {
        results.email = 'failed';
        console.error('[Alert] Erro email:', err.message);
      }
    }

    try {
      const channel = [results.whatsapp==='sent'?'whatsapp':null, results.email==='sent'?'email':null].filter(Boolean).join('+') || 'none';
      await query(`INSERT INTO alert_logs (user_id, decision_id, channel, recipient, status) VALUES ($1,$2,$3,$4,$5)`,
        [userId, decision.db_id||null, channel, user.email, results.email==='sent'||results.whatsapp==='sent'?'sent':'failed']);
    } catch (logErr) { console.warn('[Alert] Falha ao salvar log:', logErr.message); }

    await setThrottle(userId, ruleId, decision.severity);
    return results;
  } catch (err) {
    console.error('[Alert] Erro inesperado:', err.message);
    return { error: err.message };
  }
};

const sendTestAlert = async (userId, channel) => {
  const userResult = await query('SELECT name, email, whatsapp, whatsapp_key FROM users WHERE id=$1', [userId]);
  if (userResult.rows.length === 0) throw new Error('Usuário não encontrado');
  const user = userResult.rows[0];
  const testDecision = {
    title: 'Teste de Alerta IPPMIFY', campaign_name: 'Campanha de Teste',
    description: 'Esta é uma mensagem de teste para verificar que seus alertas estão funcionando corretamente.',
    recommendation: 'Nenhuma ação necessária. Se recebeu esta mensagem, seus alertas estão funcionando!',
    severity: 9, rule_id: 'test_alert', data_snapshot: {},
  };
  if (channel === 'whatsapp' || channel === 'all') {
    if (!user.whatsapp) throw new Error('Número de WhatsApp não configurado');
    if (!user.whatsapp_key) throw new Error('Chave CallMeBot não configurada. Envie "I allow callmebot to send me messages" para +34 644 65 44 78 no WhatsApp para obter a chave.');
    await sendCallMeBot(user.whatsapp, user.whatsapp_key, formatWhatsAppMessage(testDecision, user.name));
  }
  if (channel === 'email' || channel === 'all') {
    const sgMail = getSendGrid();
    if (!user.email) throw new Error('Email não configurado');
    if (!sgMail) throw new Error('SendGrid não configurado (SENDGRID_API_KEY ausente no Railway)');
    await sgMail.send({ to: user.email, from: process.env.EMAIL_FROM || 'noreply@ippmify.com', subject: '✅ Teste de Alerta IPPMIFY', html: formatEmailHtml(testDecision, user.name) });
  }
  return { success: true, channel };
};

// ─── RELATORIO DIARIO EMAIL ───────────────────────────────────────────────
const sendDailyReport = async (userId, metrics, insights) => {
  const sgMail = getSendGrid();
  if (!sgMail) { console.warn('[Alert] SendGrid não configurado — relatório ignorado'); return; }
  try {
    const userResult = await query('SELECT name, email FROM users WHERE id=$1', [userId]);
    if (!userResult.rows[0]?.email) return;
    const user = userResult.rows[0];
    const healthEmoji = { excellent:'🟢', good:'🟢', ok:'🟡', poor:'🔴', critical:'🔴' }[insights.overall_health] || '⚪';
    const subject = `[IPPMIFY] Relatório de Lucro — ${new Date().toLocaleDateString('pt-BR')} ${healthEmoji}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1A237E;color:white;padding:20px;border-radius:8px 8px 0 0"><h1 style="margin:0;font-size:22px">IPPMIFY — Relatório Diário</h1><p style="margin:5px 0 0">Olá, ${user.name} | ${new Date().toLocaleDateString('pt-BR')}</p></div>
      <div style="padding:20px;border:1px solid #eee;border-radius:0 0 8px 8px">
        <div style="background:#E8EAF6;padding:15px;border-radius:6px;margin-bottom:20px"><p style="margin:0;font-style:italic">${insights.summary || insights.resumo_executivo || 'Análise disponível no painel IPPMIFY.'}</p></div>
        <h2 style="color:#1A237E">💰 Métricas do Período</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr style="background:#f5f5f5"><td style="padding:8px;border:1px solid #ddd"><strong>Gasto</strong></td><td style="padding:8px;border:1px solid #ddd">R$ ${(metrics.spend||0).toFixed(2)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Receita</strong></td><td style="padding:8px;border:1px solid #ddd">R$ ${(metrics.revenue||0).toFixed(2)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vendas</strong></td><td style="padding:8px;border:1px solid #ddd">${metrics.conversions||0}</td></tr>
          <tr style="background:${(metrics.profit||0)>=0?'#E8F5E9':'#FFEBEE'}"><td style="padding:8px;border:1px solid #ddd"><strong>Lucro Real</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold;color:${(metrics.profit||0)>=0?'#2E7D32':'#C62828'}">R$ ${(metrics.profit||0).toFixed(2)}</td></tr>
          <tr style="background:#f5f5f5"><td style="padding:8px;border:1px solid #ddd"><strong>ROAS</strong></td><td style="padding:8px;border:1px solid #ddd">${(metrics.roas||0).toFixed(2)}x</td></tr>
        </table>
        <h2 style="color:#1A237E">🎯 Ação Principal</h2>
        <div style="background:#E8F5E9;padding:15px;border-radius:6px;border-left:4px solid #2E7D32"><strong>${insights.top_action || (insights.acao_imediata?.ordem) || 'Acesse o painel IPPMIFY para ver as recomendações.'}</strong></div>
        <hr style="border:1px solid #eee;margin:20px 0"><p style="color:#9E9E9E;font-size:12px;text-align:center">IPPMIFY Profit Intelligence</p>
      </div>
    </div>`;
    await sgMail.send({ to: user.email, from: process.env.EMAIL_FROM || 'noreply@ippmify.com', subject, html });
  } catch (err) { console.error('[Alert] Erro relatório diário:', err.message); }
};

// ─── RELATORIO WHATSAPP ────────────────────────────────────────────────────
const sendWhatsAppDailyReport = async (userId, metrics, insights) => {
  const userResult = await query('SELECT name, whatsapp, whatsapp_key FROM users WHERE id=$1', [userId]);
  if (!userResult.rows[0]) return;
  const user = userResult.rows[0];
  if (!user.whatsapp || !user.whatsapp_key) {
    console.warn(`[Alert] WhatsApp não configurado para ${userId}`);
    return;
  }

  const spend  = (metrics.spend    || 0).toFixed(2);
  const rev    = (metrics.revenue  || 0).toFixed(2);
  const profit = (metrics.profit   || 0).toFixed(2);
  const roas   = (metrics.roas     || 0).toFixed(2);
  const sales  = metrics.conversions || 0;
  const profitEmoji = (metrics.profit || 0) >= 0 ? '✅' : '❌';

  const action = insights.top_action || insights.acao_imediata?.ordem || (insights.insights?.[0]?.action) || 'Monitore suas campanhas no painel';
  const date = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const message =
`📊 IPPMIFY — Relatório
${date} | Olá, ${user.name}!

💸 Gasto: R$ ${spend}
💵 Receita: R$ ${rev}
🛒 Vendas: ${sales}
${profitEmoji} Lucro: R$ ${profit}
📈 ROAS: ${roas}x

⚡ Ação agora: ${action}

— IPPMIFY Profit Intelligence`;

  try {
    await sendCallMeBot(user.whatsapp, user.whatsapp_key, message);
    console.log(`[Alert] Relatório WhatsApp enviado para ${user.whatsapp}`);
  } catch (err) {
    console.error(`[Alert] Relatório WhatsApp falhou para ${user.whatsapp}:`, err.message);
  }
};

module.exports = { sendAlert, sendTestAlert, sendDailyReport, sendWhatsAppDailyReport };
