const PDFDocument = require('pdfkit');
const axios       = require('axios');
const { calculateOverview, calculateByCampaign } = require('./metricsEngine');
const { query } = require('../config/database');

// Formatar BRL sem biblioteca
const brl = (v) => {
  const n = Number(v || 0);
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ─── GERAR PDF ─────────────────────────────────────────────────────────────
const generateReportPDF = async (userId, days = 7) => {
  const [overview, campaigns, userResult] = await Promise.all([
    calculateOverview(userId, days),
    calculateByCampaign(userId, days),
    query('SELECT name, email FROM users WHERE id=$1', [userId]),
  ]);
  const user     = userResult.rows[0] || {};
  const topCamps = campaigns.slice(0, 6);
  const dateStr  = new Date().toLocaleDateString('pt-BR');
  const profitPos = overview.profit >= 0;

  const doc    = new PDFDocument({ size: 'A4', margin: 45 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  // ── Cabeçalho azul ──────────────────────────────────────────────────────
  doc.rect(0, 0, 595, 78).fill('#1a237e');
  doc.fontSize(28).fillColor('#ffffff').font('Helvetica-Bold').text('IPPMIFY', 45, 16);
  doc.fontSize(10).fillColor('#90caf9').font('Helvetica').text('Profit Intelligence System', 45, 50);
  doc.fontSize(9).fillColor('#b3c5f7')
    .text(`Cliente: ${user.name || ''}`, 300, 22, { align: 'right', width: 250 })
    .text(`Período: últimos ${days} dias`, 300, 37, { align: 'right', width: 250 })
    .text(`Gerado em: ${dateStr}`, 300, 52, { align: 'right', width: 250 });
  doc.y = 98;

  // ── Seção: Visão Geral ──────────────────────────────────────────────────
  doc.fontSize(11).fillColor('#1a237e').font('Helvetica-Bold').text('VISÃO GERAL', 45);
  doc.moveTo(45, doc.y + 3).lineTo(550, doc.y + 3).lineWidth(0.5).strokeColor('#c5cae9').stroke();
  doc.y += 14;

  const metricBoxes = [
    { label: 'Gasto Total',    value: brl(overview.spend),     color: '#37474f' },
    { label: 'Receita Real',   value: brl(overview.revenue),   color: '#2e7d32' },
    { label: 'Lucro Real',     value: (profitPos?'+':'')+brl(overview.profit), color: profitPos?'#2e7d32':'#c62828' },
    { label: 'ROAS',           value: Number(overview.roas).toFixed(2)+'x',    color: '#1a237e' },
    { label: 'CPA',            value: brl(overview.cpa),       color: '#37474f' },
    { label: 'Conversões',     value: String(overview.conversions), color: '#37474f' },
    { label: 'CTR',            value: Number(overview.ctr).toFixed(2)+'%', color: '#37474f' },
    { label: 'ROI',            value: (profitPos?'+':'')+Number(overview.roi_pct).toFixed(1)+'%', color: profitPos?'#2e7d32':'#c62828' },
  ];

  const bW = 118, bH = 58, bG = 9;
  let bx = 45, by = doc.y;
  metricBoxes.forEach((m, i) => {
    doc.rect(bx, by, bW, bH).fillAndStroke('#f5f7ff', '#dce0f0');
    doc.fontSize(8).fillColor('#78909c').font('Helvetica').text(m.label, bx + 7, by + 8, { width: bW - 14 });
    doc.fontSize(14).fillColor(m.color).font('Helvetica-Bold').text(m.value, bx + 7, by + 26, { width: bW - 14 });
    bx += bW + bG;
    if ((i + 1) % 4 === 0) { bx = 45; by += bH + bG; }
  });
  doc.y = by + bH + 20;

  // ── Seção: Top Campanhas ────────────────────────────────────────────────
  if (topCamps.length > 0) {
    doc.fontSize(11).fillColor('#1a237e').font('Helvetica-Bold').text('TOP CAMPANHAS', 45);
    doc.moveTo(45, doc.y + 3).lineTo(550, doc.y + 3).lineWidth(0.5).strokeColor('#c5cae9').stroke();
    doc.y += 12;

    // Cabeçalho da tabela
    const colW = [195, 75, 75, 75, 55, 55];
    const headers = ['Campanha', 'Gasto', 'Receita', 'Lucro', 'ROAS', 'CPA'];
    let hx = 45;
    doc.rect(45, doc.y - 2, 505, 18).fill('#e8eaf6');
    doc.fontSize(8).fillColor('#37474f').font('Helvetica-Bold');
    headers.forEach((h, i) => {
      doc.text(h, hx, doc.y, { width: colW[i], align: i === 0 ? 'left' : 'right' });
      hx += colW[i];
    });
    doc.moveDown(0.8);

    topCamps.forEach((c, idx) => {
      const profit    = c.revenue - c.spend;
      const roasColor = c.roas >= 2 ? '#1a237e' : c.roas >= 1 ? '#e65100' : '#c62828';
      const profColor = profit >= 0 ? '#2e7d32' : '#c62828';
      const bg        = idx % 2 === 0 ? '#ffffff' : '#f5f7ff';
      const ry        = doc.y;
      doc.rect(45, ry - 2, 505, 17).fill(bg);
      let cx = 45;
      const cells = [
        { t: (c.campaign_name||'').substring(0,30), color:'#212121', align:'left',  font:'Helvetica-Bold' },
        { t: brl(c.spend),                          color:'#546e7a', align:'right', font:'Helvetica' },
        { t: brl(c.revenue),                        color:'#2e7d32', align:'right', font:'Helvetica' },
        { t: (profit>=0?'+':'')+brl(profit),        color:profColor, align:'right', font:'Helvetica-Bold' },
        { t: Number(c.roas).toFixed(2)+'x',         color:roasColor, align:'right', font:'Helvetica-Bold' },
        { t: c.cpa > 0 ? brl(c.cpa) : '—',         color:'#546e7a', align:'right', font:'Helvetica' },
      ];
      cells.forEach((d, i) => {
        doc.fontSize(8).fillColor(d.color).font(d.font)
           .text(d.t, cx, ry, { width: colW[i], align: d.align });
        cx += colW[i];
      });
      doc.moveDown(0.65);
    });
    doc.moveDown(0.5);
  }

  // ── Nota explicativa ────────────────────────────────────────────────────
  doc.rect(45, doc.y, 505, 36).fillAndStroke('#e8f5e9', '#a5d6a7');
  doc.fontSize(8).fillColor('#2e7d32').font('Helvetica-Bold')
     .text('💡 Sobre o Lucro Real', 55, doc.y + 5);
  doc.fontSize(8).fillColor('#33691e').font('Helvetica')
     .text('O lucro calculado pelo IPPMIFY usa os dados reais das vendas aprovadas na sua plataforma de checkout (Hotmart/Kirvano/Kiwify), '
          +'eliminando a distorção de atribuição do Meta Ads. Reembolsos são descontados automaticamente.', 55, doc.y + 5, { width: 485 });
  doc.moveDown(3);

  // ── Rodapé ──────────────────────────────────────────────────────────────
  const fy = 775;
  doc.moveTo(45, fy).lineTo(550, fy).lineWidth(0.5).strokeColor('#e0e0e0').stroke();
  doc.fontSize(7.5).fillColor('#90a4ae').font('Helvetica')
     .text('IPPMIFY — Profit Intelligence for Digital Marketers', 45, fy + 6, { align: 'center', width: 505 })
     .text('Relatório confidencial. Gerado automaticamente pelo sistema.', 45, fy + 17, { align: 'center', width: 505 });

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
};

// ─── GERAR MENSAGEM WHATSAPP ────────────────────────────────────────────────
const generateWhatsAppMessage = async (userId, days = 7) => {
  const [overview, campaigns] = await Promise.all([
    calculateOverview(userId, days),
    calculateByCampaign(userId, days),
  ]);
  const profitPos  = overview.profit >= 0;
  const profSign   = profitPos ? '+' : '';
  const topCamp    = campaigns[0];
  const dateStr    = new Date().toLocaleDateString('pt-BR');
  const roasEmoji  = overview.roas >= 2 ? '🟢' : overview.roas >= 1 ? '🟡' : '🔴';

  let msg = `📊 *IPPMIFY — Relatório Diário*\n`;
  msg    += `📅 ${dateStr} · Últimos ${days} dias\n`;
  msg    += `━━━━━━━━━━━━━━━━━\n`;
  msg    += `💸 *Gasto:*      ${brl(overview.spend)}\n`;
  msg    += `💰 *Receita:*    ${brl(overview.revenue)}\n`;
  msg    += `📈 *Lucro:*      ${profSign}${brl(overview.profit)}\n`;
  msg    += `${roasEmoji} *ROAS:*       ${Number(overview.roas).toFixed(2)}x\n`;
  msg    += `💡 *CPA:*        ${brl(overview.cpa)}\n`;
  msg    += `🛒 *Conversões:* ${overview.conversions}\n`;
  msg    += `📊 *ROI:*        ${profSign}${Number(overview.roi_pct).toFixed(1)}%\n`;
  if (topCamp) {
    const tp = topCamp.revenue - topCamp.spend;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `📢 *Top Campanha:*\n`;
    msg += `   ${(topCamp.campaign_name||'').substring(0,28)}\n`;
    msg += `   ROAS ${Number(topCamp.roas).toFixed(2)}x · Lucro ${brl(tp)}\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━\n`;
  msg += `_Gerado automaticamente pelo IPPMIFY_`;
  return msg;
};

// ─── ENVIAR VIA CALLMEBOT WHATSAPP ─────────────────────────────────────────
const sendWhatsApp = async (phone, apiKey, message) => {
  if (!phone || !apiKey) throw new Error('WhatsApp e API Key não configurados');
  const cleanPhone = phone.replace(/\D/g, '');
  const response = await axios.get('https://api.callmebot.com/whatsapp.php', {
    params: { phone: cleanPhone, text: message, apikey: apiKey },
    timeout: 12000,
  });
  console.log(`[Report] WhatsApp enviado para ${cleanPhone}`);
  return response.data;
};

// ─── ENVIAR RELATORIO DIARIO VIA WA (para ser chamado pelo worker) ──────────
const sendDailyWhatsAppReport = async (userId) => {
  const result = await query(
    'SELECT whatsapp, whatsapp_key FROM users WHERE id=$1',
    [userId]
  );
  const user = result.rows[0];
  if (!user?.whatsapp || !user?.whatsapp_key) return false;
  const message = await generateWhatsAppMessage(userId, 7);
  await sendWhatsApp(user.whatsapp, user.whatsapp_key, message);
  return true;
};

module.exports = {
  generateReportPDF,
  generateWhatsAppMessage,
  sendWhatsApp,
  sendDailyWhatsAppReport,
};
