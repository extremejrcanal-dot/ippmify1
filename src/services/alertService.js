const { query } = require('../config/database');
const { exists, setEx } = require('../config/redis');

// ─── INICIALIZACAO LAZY DOS CLIENTES EXTERNOS ─────────────────────────────
// SendGrid é inicializado APENAS quando usado, nao no startup.
// Isso evita crash se as env vars nao estiverem configuradas no Railway.
// CallMeBot NAO requer SDK — usa uma simples requisicao HTTP GET.

let _sgMail = null;

const getSendGrid = () => {
  if (!process.env.SENDGRID_API_KEY) return null;
  if (!_sgMail) {
    _sgMail = require('@sendgrid/mail');
    _sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }
  return _sgMail;
};

// ─── CALLMEBOT (WHATSAPP GRATUITO) ───────────────────────────────────────
// Cada usuario tem sua propria chave CallMeBot (campo whatsapp_key na tabela users).
// Guia para obter a chave: salvar +34 644 65 44 78 nos contatos e enviar "I allow callmebot to send me messages"
// API: GET https://api.callmebot.com/whatsapp.php?phone=PHONE&apikey=KEY&text=MESSAGE

const sendCallMeBot = async (phone, apiKey, message) => {
  const https = require('https');
  const encodedText = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&apikey=${apiKey}&text=${encodedText}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          resolve({ success: true, status, body: data });
        } else {
          reject(new Error(`CallMeBot retornou status ${status}: ${data}`));
        }
      });
    }).on('error', reject);
  });
};

// ─── CONTROLE DE THROTTLE ─────────────────────────────────────────────────
const COOLDOWN_SECONDS = {
  CRITICAL: 2 * 60 * 60,
  HIGH:     4 * 60 * 60,
  MODERATE: 24 * 60 * 60,
};

const getThrottleKey = (userId, ruleId) => `alert:throttle:${userId}:${ruleId}`;
const isThrottled    = async (userId, ruleId) => exists(getThrottleKey(userId, ruleId));
const setThrottle    = async (userId, ruleId, severity) => {
  let ttl = COOLDOWN_SECONDS.MODERATE;
  if (severity >= 9) ttl = COOLDOWN_SECONDS.CRITICAL;
  else if (severity >= 7) ttl = COOLDOWN_SECONDS.HIGH;
  await setEx(getThrottleKey(userId, ruleId), '1', ttl);
};

// ─── FORMATAR MENSAGEM WHATSAPP ───────────────────────────────────────────
const formatWhatsAppMessage = (decision, userName) => {
  const emoji = decision.severity >= 9 ? '🚨' : decision.severity >= 7 ? '⚠️' : '📊';
  return `${emoji} IPPMIFY ALERTA

Ola, ${userName}!

Campanha: ${decision.campaign_name || 'Geral'}
Problema: ${decision.title}

${decision.description}

✅ O que fazer:
${decision.recommendation}

⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
— IPPMIFY Profit Intelligence`;
};

// ─── FORMATAR EMAIL ────────────────────────────────────────────────────────
const formatEmailHtml = (decision, userName) => {
  const color = decision.severity >= 9 ? '#C62828' : decision.severity >= 7 ? '#F57F17' : '#1A237E';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">IPPMIFY Alerta</h1>
        <p style="margin: 5px 0 0;">Ola, ${userName}</p>
      </div>
      <div style="padding: 20px; border: 1px solid #eee; border-radius: 0 0 8px 8px;">
        <h2 style="color: ${color};">${decision.title}</h2>
        <p><strong>Campanha:</strong> ${decision.campaign_name || 'Geral'}</p>
        <p>${decision.description}</p>
        <div style="background: #E8F5E9; padding: 15px; border-radius: 6px; margin: 15px 0;">
          <strong>✅ O que fazer:</strong><br>
          ${decision.recommendation}
        </div>
        <hr style="border: 1px solid #eee;">
        <p style="color: #9E9E9E; font-size: 12px;">
          IPPMIFY Profit Intelligence | ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
        </p>
      </div>
    </div>
  `;
};

// ─── ENVIAR ALERTA ─────────────────────────────────────────────────────────
const sendAlert = async (userId, decision) => {
  try {
    const userResult = await query(
      'SELECT name, email, whatsapp, whatsapp_key FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) return;
    const user   = userResult.rows[0];
    const ruleId = decision.rule_id || decision.type;

    // Verificar throttle
    if (await isThrottled(userId, ruleId)) {
      console.log(`[Alert] Throttled: ${ruleId} para usuario ${userId}`);
      return { throttled: true };
    }

    const results = { whatsapp: null, email: null };

    // ── Enviar WhatsApp via CallMeBot (severity >= 7) ─────────────────────
    if (decision.severity >= 7 && user.whatsapp && user.whatsapp_key) {
      try {
        await sendCallMeBot(
          user.whatsapp,
          user.whatsapp_key,
          formatWhatsAppMessage(decision, user.name)
        );
        results.whatsapp = 'sent';
        console.log(`[Alert] WhatsApp CallMeBot enviado para ${user.whatsapp}`);
      } catch (err) {
        results.whatsapp = 'failed';
        console.error('[Alert] Erro WhatsApp CallMeBot:', err.message);
      }
    } else if (decision.severity >= 7 && user.whatsapp && !user.whatsapp_key) {
      console.warn('[Alert] whatsapp_key nao configurada — WhatsApp ignorado');
      results.whatsapp = 'no_key';
    }

    // ── Enviar Email ─────────────────────────────────────────────────────
    const sgMail = getSendGrid();
    if (user.email && sgMail) {
      try {
        const subject = decision.severity >= 9
          ? `🚨 CRITICO: ${decision.title}`
          : `⚠️ ALERTA: ${decision.title}`;

        await sgMail.send({
          to:      user.email,
          from:    process.env.EMAIL_FROM || 'noreply@ippmify.com',
          subject,
          html:    formatEmailHtml(decision, user.name),
        });
        results.email = 'sent';
        console.log(`[Alert] Email enviado para ${user.email}`);
      } catch (err) {
        results.email = 'failed';
        console.error('[Alert] Erro Email:', err.message);
      }
    } else if (user.email && !sgMail) {
      console.warn('[Alert] SendGrid nao configurado — email ignorado (configure SENDGRID_API_KEY)');
    }

    // Registrar log (falha nao derruba o fluxo)
    try {
      const channel = [
        results.whatsapp === 'sent' ? 'whatsapp' : null,
        results.email    === 'sent' ? 'email'    : null,
      ].filter(Boolean).join('+') || 'none';

      await query(`
        INSERT INTO alert_logs (user_id, decision_id, channel, recipient, status)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        userId,
        decision.db_id || null,
        channel,
        user.email,
        results.email === 'sent' || results.whatsapp === 'sent' ? 'sent' : 'failed',
      ]);
    } catch (logErr) {
      console.warn('[Alert] Falha ao salvar log:', logErr.message);
    }

    await setThrottle(userId, ruleId, decision.severity);
    return results;

  } catch (err) {
    console.error('[Alert] Erro inesperado em sendAlert:', err.message);
    return { error: err.message };
  }
};

// ─── ENVIAR ALERTA DE TESTE (sem throttle, sem log obrigatorio) ────────────
// Usado pelo endpoint POST /api/decisions/test-alert
const sendTestAlert = async (userId, channel) => {
  const userResult = await query(
    'SELECT name, email, whatsapp, whatsapp_key FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('Usuario nao encontrado');
  const user = userResult.rows[0];

  const testDecision = {
    title:          'Teste de Alerta IPPMIFY',
    campaign_name:  'Campanha de Teste',
    description:    'Esta e uma mensagem de teste para verificar que seus alertas estao funcionando corretamente.',
    recommendation: 'Nenhuma acao necessaria. Se recebeu esta mensagem, seus alertas estao configurados com sucesso!',
    severity:       9, // critico para garantir que passa pelo filtro de severity >= 7
    rule_id:        'test_alert',
  };

  if (channel === 'whatsapp' || channel === 'all') {
    if (!user.whatsapp) throw new Error('Numero de WhatsApp nao configurado nas configuracoes');
    if (!user.whatsapp_key) throw new Error('Chave CallMeBot nao configurada. Siga o guia para obter sua chave gratuita.');
    await sendCallMeBot(user.whatsapp, user.whatsapp_key, formatWhatsAppMessage(testDecision, user.name));
  }

  if (channel === 'email' || channel === 'all') {
    const sgMail = getSendGrid();
    if (!user.email) throw new Error('Email nao configurado');
    if (!sgMail) throw new Error('SendGrid nao configurado no servidor (SENDGRID_API_KEY ausente)');
    await sgMail.send({
      to:      user.email,
      from:    process.env.EMAIL_FROM || 'noreply@ippmify.com',
      subject: '✅ Teste de Alerta IPPMIFY',
      html:    formatEmailHtml(testDecision, user.name),
    });
  }

  return { success: true, channel };
};

// ─── ENVIAR RELATORIO DIARIO ───────────────────────────────────────────────
const sendDailyReport = async (userId, metrics, insights) => {
  const sgMail = getSendGrid();
  if (!sgMail) {
    console.warn('[Alert] SendGrid nao configurado — relatorio diario ignorado');
    return;
  }
  try {
    const userResult = await query(
      'SELECT name, email FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) return;
    const user = userResult.rows[0];
    if (!user.email) return;

    const healthEmoji = { excellent:'🟢', good:'🟢', ok:'🟡', poor:'🔴', critical:'🔴' }[insights.overall_health] || '⚪';
    const subject = `[IPPMIFY] Relatorio de Lucro — ${new Date().toLocaleDateString('pt-BR')} ${healthEmoji}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1A237E; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 22px;">IPPMIFY — Relatorio Diario</h1>
          <p style="margin: 5px 0 0;">Ola, ${user.name} | ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div style="padding: 20px; border: 1px solid #eee; border-radius: 0 0 8px 8px;">
          <div style="background: #E8EAF6; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
            <p style="margin: 0; font-style: italic;">${insights.summary}</p>
          </div>
          <h2 style="color: #1A237E;">💰 Metricas do Periodo (7 dias)</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr style="background: #f5f5f5;">
              <td style="padding: 8px; border: 1px solid #ddd;"><strong>Gasto Total</strong></td>
              <td style="padding: 8px; border: 1px solid #ddd;">R$ ${(metrics.spend||0).toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd;"><strong>Receita Total</strong></td>
              <td style="padding: 8px; border: 1px solid #ddd;">R$ ${(metrics.revenue||0).toFixed(2)}</td>
            </tr>
            <tr style="background: ${(metrics.profit||0) >= 0 ? '#E8F5E9' : '#FFEBEE'};">
              <td style="padding: 8px; border: 1px solid #ddd;"><strong>Lucro Real</strong></td>
              <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; color: ${(metrics.profit||0) >= 0 ? '#2E7D32' : '#C62828'};">
                R$ ${(metrics.profit||0).toFixed(2)}
              </td>
            </tr>
            <tr style="background: #f5f5f5;">
              <td style="padding: 8px; border: 1px solid #ddd;"><strong>ROAS</strong></td>
              <td style="padding: 8px; border: 1px solid #ddd;">${(metrics.roas||0).toFixed(2)}x</td>
            </tr>
          </table>
          <h2 style="color: #1A237E;">🎯 Acao Principal para Hoje</h2>
          <div style="background: #E8F5E9; padding: 15px; border-radius: 6px; border-left: 4px solid #2E7D32;">
            <strong>${insights.top_action}</strong>
          </div>
          ${(insights.insights||[]).slice(0, 3).map(i => `
            <div style="margin-top: 15px; padding: 15px; border: 1px solid #eee; border-radius: 6px;">
              <div style="color: ${i.type === 'problem' ? '#C62828' : i.type === 'opportunity' ? '#2E7D32' : '#1A237E'};">
                <strong>${i.type === 'problem' ? '🔴' : i.type === 'opportunity' ? '🟢' : '🔵'} ${i.finding}</strong>
              </div>
              <p style="margin: 8px 0; color: #666;">${i.impact}</p>
              <p style="margin: 0; font-weight: bold;">→ ${i.action}</p>
            </div>
          `).join('')}
          <hr style="border: 1px solid #eee; margin: 20px 0;">
          <p style="color: #9E9E9E; font-size: 12px; text-align: center;">
            IPPMIFY Profit Intelligence | O que voce deve fazer AGORA para aumentar o lucro.
          </p>
        </div>
      </div>
    `;

    await sgMail.send({ to: user.email, from: process.env.EMAIL_FROM || 'noreply@ippmify.com', subject, html });
    console.log(`[Alert] Relatorio diario enviado para ${user.email}`);
  } catch (err) {
    console.error('[Alert] Erro ao enviar relatorio:', err.message);
  }
};

// ─── ENVIAR RELATORIO WHATSAPP (por usuario, via CallMeBot) ──────────────────
// Formato compacto — texto puro, sem HTML
const sendWhatsAppDailyReport = async (userId, metrics, insights) => {
  const userResult = await query(
    'SELECT name, whatsapp, whatsapp_key FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) return;
  const user = userResult.rows[0];

  if (!user.whatsapp || !user.whatsapp_key) {
    console.warn(`[Alert] WhatsApp nao configurado para usuario ${userId} — relatorio ignorado`);
    return;
  }

  const spend  = (metrics.spend    || 0).toFixed(2);
  const rev    = (metrics.revenue  || 0).toFixed(2);
  const profit = (metrics.profit   || 0).toFixed(2);
  const roas   = (metrics.roas     || 0).toFixed(2);
  const sales  = metrics.conversions || 0;
  const profitEmoji = (metrics.profit || 0) >= 0 ? '✅' : '❌';

  // Top campanha (pode vir de insights ou de metrics.top_campaigns)
  const topCamp = (insights.insights || []).find(i => i.type === 'opportunity') || null;
  const topLine = topCamp ? `\n🏆 Destaque: ${topCamp.finding}` : '';

  // Principal acao
  const action = insights.top_action || (insights.insights?.[0]?.action) || 'Monitore suas campanhas';

  const date = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const message =
`📊 IPPMIFY — Relatório
${date} | Olá, ${user.name}!

💸 Gasto: R$ ${spend}
💵 Receita: R$ ${rev}
${profitEmoji} Lucro: R$ ${profit}
📈 ROAS: ${roas}x
🛒 Vendas: ${sales}${topLine}

⚡ Ação agora: ${action}

— IPPMIFY Profit Intelligence`;

  await sendCallMeBot(user.whatsapp, user.whatsapp_key, message);
  console.log(`[Alert] Relatorio WhatsApp enviado para ${user.whatsapp}`);
};

module.exports = { sendAlert, sendTestAlert, sendDailyReport, sendWhatsAppDailyReport };
