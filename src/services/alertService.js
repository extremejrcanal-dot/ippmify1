const sgMail = require('@sendgrid/mail');
const https  = require('https');
const { query } = require('../config/database');
const { exists, setEx } = require('../config/redis');

// Inicializa SendGrid apenas se a chave estiver configurada
if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY.startsWith('SG.')) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// ─── CALLMEBOT — ENVIAR WHATSAPP ─────────────────────────────────────────────
// CallMeBot e gratuito e so envia mensagens (nao recebe)
// Configuracao: adicione o numero +34 644 59 89 33 no WhatsApp e envie
// "I allow callmebot to send me messages" — voce recebe sua APIKEY
// Variaveis de ambiente necessarias:
//   CALLMEBOT_APIKEY = sua chave (ex: 1234567)
//   users.whatsapp   = numero do usuario com DDI (ex: 5511999999999)
const sendCallMeBot = async (phone, message) => {
  const apiKey = process.env.CALLMEBOT_APIKEY;
  if (!apiKey) {
    console.log('[CallMeBot] CALLMEBOT_APIKEY nao configurado');
    return false;
  }
  if (!phone) {
    console.log('[CallMeBot] Numero de telefone nao informado');
    return false;
  }

  // Remove qualquer caractere que nao seja digito (ex: +55 11 9xxxx → 55119xxxx)
  const phoneClean = String(phone).replace(/\D/g, '');
  const encodedMsg = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phoneClean}&text=${encodedMsg}&apikey=${apiKey}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      console.log(`[CallMeBot] Enviado para ${phoneClean} — HTTP ${res.statusCode}`);
      resolve(res.statusCode < 400);
    }).on('error', (err) => {
      console.error('[CallMeBot] Erro de conexao:', err.message);
      resolve(false);
    });
  });
};

// ─── CONTROLE DE THROTTLE ─────────────────────────────────────────────────────
const COOLDOWN_SECONDS = {
  CRITICAL: 2 * 60 * 60,   // 2 horas para alertas criticos (score 9-10)
  HIGH:     4 * 60 * 60,   // 4 horas para alertas altos (score 7-8)
  MODERATE: 24 * 60 * 60,  // 24 horas para alertas moderados
};

const getThrottleKey = (userId, ruleId) => `alert:throttle:${userId}:${ruleId}`;

const isThrottled = async (userId, ruleId) => exists(getThrottleKey(userId, ruleId));

const setThrottle = async (userId, ruleId, severity) => {
  let ttl = COOLDOWN_SECONDS.MODERATE;
  if (severity >= 9) ttl = COOLDOWN_SECONDS.CRITICAL;
  else if (severity >= 7) ttl = COOLDOWN_SECONDS.HIGH;
  await setEx(getThrottleKey(userId, ruleId), '1', ttl);
};

// ─── ALERTA INFORMATIVO (sem pedido de acao) ──────────────────────────────────
const formatWhatsAppAlert = (decision, userName) => {
  const emoji = decision.severity >= 9 ? '🚨' : decision.severity >= 7 ? '⚠️' : '📊';
  return `${emoji} IPPMIFY ALERTA

Ola, ${userName}!

Campanha: ${decision.campaign_name || decision.entity_name || 'Geral'}
Problema: ${decision.title}

${decision.description}

O que fazer: ${decision.recommendation}

${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
— IPPMIFY`;
};

// ─── PEDIDO DE CONFIRMACAO DE PAUSA ──────────────────────────────────────────
// Enviado quando o motor detecta anomalia grave — usuario clica no link para pausar
const sendPauseRequest = async (userId, decision, confirmUrl) => {
  const userResult = await query(
    'SELECT name, whatsapp FROM users WHERE id = $1',
    [userId]
  );
  if (!userResult.rows.length) return false;
  const user = userResult.rows[0];

  if (!user.whatsapp) {
    console.log('[Alert] Usuario sem WhatsApp — alerta de pausa nao enviado');
    return false;
  }

  const emoji = decision.severity >= 9 ? '🚨' : '⚠️';
  const tipoEntidade = decision.entity_type === 'campaign'
    ? 'Campanha'
    : decision.entity_type === 'ad_set'
      ? 'Conjunto'
      : 'Anuncio';

  const msg = `${emoji} IPPMIFY - Acao necessaria!

Ola, ${user.name}!

${tipoEntidade}: ${decision.entity_name}
Problema: ${decision.title}

${decision.description}

Clique abaixo para PAUSAR agora:
${confirmUrl}

(Expira em 4 horas — se nao clicar, nada sera pausado)
— IPPMIFY`;

  return sendCallMeBot(user.whatsapp, msg);
};

// ─── ENVIAR ALERTA GERAL ──────────────────────────────────────────────────────
const sendAlert = async (userId, decision) => {
  const userResult = await query(
    'SELECT name, email, whatsapp FROM users WHERE id = $1',
    [userId]
  );
  if (!userResult.rows.length) return;
  const user = userResult.rows[0];

  const ruleId = decision.rule_id || decision.type;

  if (await isThrottled(userId, ruleId)) {
    console.log(`[Alert] Throttled: ${ruleId} para usuario ${userId}`);
    return { throttled: true };
  }

  const results = { whatsapp: null, email: null };

  // ── WhatsApp via CallMeBot (apenas alertas severity >= 7) ────────────────
  if (decision.severity >= 7 && user.whatsapp) {
    const msg = formatWhatsAppAlert(decision, user.name);
    const ok = await sendCallMeBot(user.whatsapp, msg);
    results.whatsapp = ok ? 'sent' : 'failed';
  }

  // ── Email via SendGrid ────────────────────────────────────────────────────
  if (user.email && process.env.SENDGRID_API_KEY) {
    try {
      const color   = decision.severity >= 9 ? '#C62828' : decision.severity >= 7 ? '#F57F17' : '#1A237E';
      const subject = decision.severity >= 9
        ? `🚨 CRITICO: ${decision.title}`
        : `⚠️ ALERTA: ${decision.title}`;

      await sgMail.send({
        to:      user.email,
        from:    process.env.EMAIL_FROM || 'noreply@ippmify.com',
        subject,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:${color};color:white;padding:20px;border-radius:8px 8px 0 0;">
              <h1 style="margin:0;font-size:24px;">IPPMIFY Alerta</h1>
              <p style="margin:5px 0 0;">Ola, ${user.name}</p>
            </div>
            <div style="padding:20px;border:1px solid #eee;border-radius:0 0 8px 8px;">
              <h2 style="color:${color};">${decision.title}</h2>
              <p><strong>Campanha:</strong> ${decision.campaign_name || decision.entity_name || 'Geral'}</p>
              <p>${decision.description}</p>
              <div style="background:#E8F5E9;padding:15px;border-radius:6px;margin:15px 0;">
                <strong>✅ O que fazer:</strong><br>${decision.recommendation}
              </div>
              <hr style="border:1px solid #eee;">
              <p style="color:#9E9E9E;font-size:12px;">
                IPPMIFY | ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
              </p>
            </div>
          </div>
        `,
      });
      results.email = 'sent';
      console.log(`[Alert] Email enviado para ${user.email}`);
    } catch (err) {
      results.email = 'failed';
      console.error('[Alert] Erro Email:', err.message);
    }
  }

  // Registrar no banco
  await query(`
    INSERT INTO alert_logs (user_id, channel, recipient, status)
    VALUES ($1, 'whatsapp_email', $2, $3)
  `, [userId, user.email, results.email === 'sent' ? 'sent' : 'failed']);

  await setThrottle(userId, ruleId, decision.severity);
  return results;
};

// ─── RELATORIO DIARIO ─────────────────────────────────────────────────────────
const sendDailyReport = async (userId, metrics, insights) => {
  const userResult = await query(
    'SELECT name, email, whatsapp FROM users WHERE id = $1',
    [userId]
  );
  if (!userResult.rows.length) return;
  const user = userResult.rows[0];

  const healthEmoji = {
    excellent: '🟢', good: '🟢', ok: '🟡', poor: '🔴', critical: '🔴'
  }[insights.overall_health] || '⚪';

  const subject = `[IPPMIFY] Relatorio de Lucro — ${new Date().toLocaleDateString('pt-BR')} ${healthEmoji}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1A237E;color:white;padding:20px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:22px;">IPPMIFY — Relatorio Diario</h1>
        <p style="margin:5px 0 0;">Ola, ${user.name} | ${new Date().toLocaleDateString('pt-BR')}</p>
      </div>
      <div style="padding:20px;border:1px solid #eee;border-radius:0 0 8px 8px;">
        <div style="background:#E8EAF6;padding:15px;border-radius:6px;margin-bottom:20px;">
          <p style="margin:0;font-style:italic;">${insights.summary}</p>
        </div>
        <h2 style="color:#1A237E;">💰 Metricas (7 dias)</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr style="background:#f5f5f5;">
            <td style="padding:8px;border:1px solid #ddd;"><strong>Gasto</strong></td>
            <td style="padding:8px;border:1px solid #ddd;">R$ ${metrics.spend?.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding:8px;border:1px solid #ddd;"><strong>Receita</strong></td>
            <td style="padding:8px;border:1px solid #ddd;">R$ ${metrics.revenue?.toFixed(2)}</td>
          </tr>
          <tr style="background:${metrics.profit >= 0 ? '#E8F5E9' : '#FFEBEE'};">
            <td style="padding:8px;border:1px solid #ddd;"><strong>Lucro Real</strong></td>
            <td style="padding:8px;border:1px solid #ddd;font-weight:bold;color:${metrics.profit >= 0 ? '#2E7D32' : '#C62828'};">
              R$ ${metrics.profit?.toFixed(2)}
            </td>
          </tr>
          <tr style="background:#f5f5f5;">
            <td style="padding:8px;border:1px solid #ddd;"><strong>ROAS</strong></td>
            <td style="padding:8px;border:1px solid #ddd;">${metrics.roas?.toFixed(2)}x</td>
          </tr>
        </table>
        <h2 style="color:#1A237E;">🎯 Acao Principal</h2>
        <div style="background:#E8F5E9;padding:15px;border-radius:6px;border-left:4px solid #2E7D32;">
          <strong>${insights.top_action}</strong>
        </div>
        ${(insights.insights || []).slice(0, 3).map(i => `
          <div style="margin-top:15px;padding:15px;border:1px solid #eee;border-radius:6px;">
            <div style="color:${i.type === 'problem' ? '#C62828' : i.type === 'opportunity' ? '#2E7D32' : '#1A237E'};">
              <strong>${i.type === 'problem' ? '🔴' : i.type === 'opportunity' ? '🟢' : '🔵'} ${i.finding}</strong>
            </div>
            <p style="margin:8px 0;color:#666;">${i.impact}</p>
            <p style="margin:0;font-weight:bold;">→ ${i.action}</p>
          </div>
        `).join('')}
        <hr style="border:1px solid #eee;margin:20px 0;">
        <p style="color:#9E9E9E;font-size:12px;text-align:center;">
          IPPMIFY Profit Intelligence | Lucro real, nao o que o Meta reporta.
        </p>
      </div>
    </div>
  `;

  if (user.email && process.env.SENDGRID_API_KEY) {
    try {
      await sgMail.send({ to: user.email, from: process.env.EMAIL_FROM, subject, html });
      console.log(`[Alert] Relatorio diario enviado para ${user.email}`);
    } catch (err) {
      console.error('[Alert] Erro ao enviar relatorio:', err.message);
    }
  }

  // Resumo no WhatsApp (opcional)
  if (user.whatsapp) {
    const waMsg = `📊 IPPMIFY - Relatorio Diario ${healthEmoji}

Ola, ${user.name}!

Gasto: R$ ${metrics.spend?.toFixed(2)}
Receita: R$ ${metrics.revenue?.toFixed(2)}
Lucro: R$ ${metrics.profit?.toFixed(2)}
ROAS: ${metrics.roas?.toFixed(2)}x

${insights.top_action}

— IPPMIFY`;
    await sendCallMeBot(user.whatsapp, waMsg);
  }
};

module.exports = { sendAlert, sendDailyReport, sendPauseRequest, sendCallMeBot };
