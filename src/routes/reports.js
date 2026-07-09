const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/database');
const { generateInsights } = require('../services/aiInsights');
const { calculateOverview, calculateByCampaign } = require('../services/metricsEngine');
const { sendWhatsAppDailyReport } = require('../services/alertService');

const router = express.Router();
router.use(requireAuth);

// ─── GET /api/reports/schedule ─────────────────────────────────────────────
router.get('/schedule', async (req, res) => {
  try {
    const result = await query(
      'SELECT report_freq, report_times, report_days FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0] || {};
    res.json({
      report_freq:  row.report_freq  ?? 0,
      report_times: row.report_times ?? '',
      report_days:  row.report_days  ?? 7,
    });
  } catch (err) {
    console.error('[Reports] Erro ao buscar schedule:', err.message);
    res.status(500).json({ error: 'Erro ao buscar agendamento' });
  }
});

// ─── POST /api/reports/schedule ────────────────────────────────────────────
router.post('/schedule', async (req, res) => {
  try {
    const { report_freq, report_times, report_days } = req.body;

    const freq  = parseInt(report_freq ?? 0);
    const days  = parseInt(report_days ?? 7);
    const times = typeof report_times === 'string' ? report_times.trim() : '';

    if (![0, 1, 2, 3].includes(freq)) {
      return res.status(400).json({ error: 'report_freq deve ser 0, 1, 2 ou 3' });
    }
    if (![1, 7, 30].includes(days)) {
      return res.status(400).json({ error: 'report_days deve ser 1, 7 ou 30' });
    }

    await query(
      `UPDATE users SET
         report_freq  = $1,
         report_times = $2,
         report_days  = $3,
         updated_at   = NOW()
       WHERE id = $4`,
      [freq, times, days, req.user.id]
    );

    res.json({
      message: 'Agendamento salvo com sucesso',
      report_freq: freq,
      report_times: times,
      report_days: days,
    });
  } catch (err) {
    console.error('[Reports] Erro ao salvar schedule:', err.message);
    res.status(500).json({ error: 'Erro ao salvar agendamento' });
  }
});

// ─── POST /api/reports/send-whatsapp ──────────────────────────────────────
router.post('/send-whatsapp', async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 7;

    const userResult = await query(
      'SELECT whatsapp, whatsapp_key FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0] || {};

    if (!user.whatsapp) {
      return res.status(400).json({ error: 'Numero de WhatsApp nao configurado. Va em Configuracoes e adicione seu numero.' });
    }
    if (!user.whatsapp_key) {
      return res.status(400).json({ error: 'Chave CallMeBot nao configurada. Va em Configuracoes e adicione sua API Key.' });
    }

    const [metrics, insights] = await Promise.all([
      calculateOverview(req.user.id, days),
      generateInsights(req.user.id, days).catch(() => ({ top_action: 'Monitore suas campanhas', insights: [] })),
    ]);

    await sendWhatsAppDailyReport(req.user.id, metrics, insights);

    res.json({ message: `Relatorio dos ultimos ${days} dias enviado para o seu WhatsApp!` });
  } catch (err) {
    console.error('[Reports] Erro ao enviar WhatsApp:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao enviar relatorio' });
  }
});

// ─── GET /api/reports/pdf ──────────────────────────────────────────────────
// Gera e retorna um PDF profissional com metricas, campanhas e insights
router.get('/pdf', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const PDFDocument = require('pdfkit');

    // Buscar dados em paralelo
    const [overview, campaigns, decisionsResult, userResult, lastInsight] = await Promise.all([
      calculateOverview(req.user.id, days),
      calculateByCampaign(req.user.id, days),
      query(
        `SELECT title, severity, recommendation
         FROM decisions
         WHERE user_id = $1 AND triggered_at >= NOW() - INTERVAL '48 hours'
         ORDER BY severity DESC LIMIT 8`,
        [req.user.id]
      ),
      query('SELECT name, email, cpa_target, roas_target FROM users WHERE id = $1', [req.user.id]),
      query(
        `SELECT summary, score, raw_response, created_at
         FROM ai_insights WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const user      = userResult.rows[0] || {};
    const decisions = decisionsResult.rows;
    const insight   = lastInsight.rows[0] || null;

    // Cores e constantes
    const PURPLE    = '#7C3AED';
    const DARK      = '#0F0F1A';
    const GRAY      = '#6B7280';
    const GREEN     = '#10B981';
    const RED       = '#EF4444';
    const YELLOW    = '#F59E0B';
    const WHITE     = '#FFFFFF';
    const LIGHT_BG  = '#F3F4F6';
    const PAGE_W    = 595.28;
    const MARGIN    = 40;
    const COL_W     = PAGE_W - MARGIN * 2;

    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: {
      Title:   'Relatorio IPPMIFY',
      Author:  'IPPMIFY',
      Subject: `Performance dos ultimos ${days} dias`,
    }});

    // Cabecalho da resposta HTTP
    const dateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-ippmify-${dateStr}.pdf"`);
    doc.pipe(res);

    // ── HELPERS ──────────────────────────────────────────────────────────
    const fmt  = (n) => 'R$ ' + parseFloat(n || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const fmtN = (n, dec = 2) => parseFloat(n || 0).toFixed(dec);
    const fmtK = (n) => {
      const v = parseInt(n || 0);
      return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
    };

    let y = MARGIN;

    // ── CABECALHO ─────────────────────────────────────────────────────────
    // Fundo roxo
    doc.rect(0, 0, PAGE_W, 90).fill(PURPLE);

    doc.font('Helvetica-Bold').fontSize(22).fillColor(WHITE)
       .text('IPPMIFY', MARGIN, 22);
    doc.font('Helvetica').fontSize(10).fillColor('#D8B4FE')
       .text('Profit Intelligence System', MARGIN, 48);

    // Info periodo (direita)
    const periodLabel = days === 1 ? 'Hoje' : `Ultimos ${days} dias`;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(WHITE)
       .text(periodLabel, PAGE_W - MARGIN - 130, 22, { width: 130, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#D8B4FE')
       .text('Gerado em ' + new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }),
             PAGE_W - MARGIN - 160, 42, { width: 160, align: 'right' });

    // Nome do usuario
    doc.font('Helvetica').fontSize(9).fillColor('#C4B5FD')
       .text(user.name || user.email || '', MARGIN, 65);

    y = 110;

    // ── TITULO DA SECAO ───────────────────────────────────────────────────
    const sectionTitle = (title, yPos) => {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(PURPLE)
         .text(title, MARGIN, yPos);
      doc.moveTo(MARGIN, yPos + 16).lineTo(PAGE_W - MARGIN, yPos + 16)
         .strokeColor('#E5E7EB').lineWidth(1).stroke();
      return yPos + 26;
    };

    // ── BLOCO DE METRICA ──────────────────────────────────────────────────
    const metricBox = (label, value, x, yPos, w, color = DARK, bgColor = LIGHT_BG) => {
      doc.rect(x, yPos, w, 52).fill(bgColor).stroke('#E5E7EB');
      doc.font('Helvetica').fontSize(8).fillColor(GRAY)
         .text(label, x + 8, yPos + 8, { width: w - 16 });
      doc.font('Helvetica-Bold').fontSize(14).fillColor(color)
         .text(value, x + 8, yPos + 22, { width: w - 16 });
    };

    // ── OVERVIEW — METRICAS PRINCIPAIS ────────────────────────────────────
    y = sectionTitle('Visao Geral', y);

    const bw = (COL_W - 10) / 3;
    const profitColor = overview.profit >= 0 ? GREEN : RED;
    const roasColor   = overview.roas >= parseFloat(user.roas_target || 2) ? GREEN : RED;
    const cpaColor    = overview.cpa  <= parseFloat(user.cpa_target  || 50) ? GREEN : RED;

    metricBox('INVESTIMENTO',    fmt(overview.spend),       MARGIN,          y, bw);
    metricBox('RECEITA',         fmt(overview.revenue),     MARGIN + bw + 5, y, bw);
    metricBox('LUCRO',           fmt(overview.profit),      MARGIN + (bw+5)*2, y, bw, profitColor);
    y += 62;
    metricBox('ROAS',            fmtN(overview.roas, 2) + 'x', MARGIN,          y, bw, roasColor);
    metricBox('CPA MEDIO',       fmt(overview.cpa),         MARGIN + bw + 5, y, bw, cpaColor);
    metricBox('CONVERSOES',      fmtK(overview.conversions), MARGIN + (bw+5)*2, y, bw);
    y += 62;

    const bw2 = (COL_W - 15) / 4;
    metricBox('IMPRESSOES',  fmtK(overview.impressions), MARGIN,              y, bw2);
    metricBox('CLIQUES',     fmtK(overview.clicks),      MARGIN + (bw2+5),    y, bw2);
    metricBox('CTR',         fmtN(overview.ctr, 2) + '%', MARGIN + (bw2+5)*2, y, bw2);
    metricBox('CPM',         fmt(overview.cpm),           MARGIN + (bw2+5)*3, y, bw2);
    y += 68;

    // ── TOP CAMPANHAS ─────────────────────────────────────────────────────
    if (campaigns.length > 0) {
      y = sectionTitle('Top Campanhas', y);

      // Cabecalho da tabela
      const cols = [
        { label: 'Campanha',     w: 160, x: MARGIN },
        { label: 'Gasto',        w: 70,  x: MARGIN + 160 },
        { label: 'Receita',      w: 70,  x: MARGIN + 230 },
        { label: 'ROAS',         w: 50,  x: MARGIN + 300 },
        { label: 'CPA',          w: 60,  x: MARGIN + 350 },
        { label: 'Conversoes',   w: 55,  x: MARGIN + 410 },
      ];

      // Header row
      doc.rect(MARGIN, y, COL_W, 18).fill('#7C3AED20');
      cols.forEach(c => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(PURPLE)
           .text(c.label, c.x + 4, y + 5, { width: c.w - 4 });
      });
      y += 18;

      // Linhas de campanha (top 8)
      const topCamp = campaigns.slice(0, 8);
      topCamp.forEach((c, i) => {
        const bg = i % 2 === 0 ? WHITE : '#F9FAFB';
        doc.rect(MARGIN, y, COL_W, 16).fill(bg);

        const campRoasColor = c.roas >= parseFloat(user.roas_target || 2) ? GREEN : RED;
        const campCpaColor  = c.cpa  <= parseFloat(user.cpa_target  || 50) ? GREEN : RED;

        // Nome da campanha (truncado)
        const campName = (c.campaign_name || '').substring(0, 28);
        doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
           .text(campName, MARGIN + 4, y + 4, { width: 152, ellipsis: true });

        doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
           .text(fmt(c.spend), MARGIN + 164, y + 4, { width: 66 });

        doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
           .text(fmt(c.revenue), MARGIN + 234, y + 4, { width: 66 });

        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(campRoasColor)
           .text(fmtN(c.roas, 2) + 'x', MARGIN + 304, y + 4, { width: 46 });

        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(campCpaColor)
           .text(fmt(c.cpa), MARGIN + 354, y + 4, { width: 56 });

        doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
           .text(String(c.conversions || 0), MARGIN + 414, y + 4, { width: 51 });

        y += 16;
      });

      // Borda da tabela
      doc.rect(MARGIN, y - 16 * topCamp.length - 18, COL_W, 18 + 16 * topCamp.length)
         .strokeColor('#E5E7EB').lineWidth(0.5).stroke();
      y += 12;
    }

    // ── ALERTAS AUTOMATICOS ───────────────────────────────────────────────
    if (decisions.length > 0) {
      // Verificar se cabe na pagina, senao adicionar nova
      if (y > 680) { doc.addPage(); y = MARGIN; }

      y = sectionTitle('Alertas Automaticos (48h)', y);

      decisions.forEach(d => {
        if (y > 730) { doc.addPage(); y = MARGIN + 20; }
        const sev = parseInt(d.severity || 5);
        const dotColor = sev >= 9 ? RED : sev >= 7 ? YELLOW : GREEN;
        const label    = sev >= 9 ? 'CRITICO' : sev >= 7 ? 'ALERTA' : 'INFO';

        doc.circle(MARGIN + 6, y + 6, 4).fill(dotColor);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(dotColor)
           .text('[' + label + ']', MARGIN + 14, y + 2);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK)
           .text(d.title || '', MARGIN + 60, y + 2, { width: COL_W - 60 });

        if (d.recommendation) {
          y += 14;
          doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
             .text(d.recommendation.substring(0, 120), MARGIN + 14, y, { width: COL_W - 14 });
        }
        y += 18;
      });
      y += 4;
    }

    // ── RESUMO IA ─────────────────────────────────────────────────────────
    if (insight) {
      if (y > 650) { doc.addPage(); y = MARGIN; }
      y = sectionTitle('Analise de Inteligencia Artificial', y);

      // Score
      let parsedInsight = null;
      if (insight.raw_response) {
        try {
          const raw = typeof insight.raw_response === 'string'
            ? insight.raw_response : JSON.stringify(insight.raw_response);
          parsedInsight = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
        } catch (_) {}
      }

      const score      = parsedInsight?.score ?? null;
      const scoreLabel = parsedInsight?.score_label ?? '';
      const scoreColor = score === null ? GRAY : score >= 75 ? GREEN : score >= 50 ? YELLOW : RED;

      if (score !== null) {
        doc.rect(MARGIN, y, 90, 42).fill(scoreColor + '20');
        doc.font('Helvetica-Bold').fontSize(24).fillColor(scoreColor)
           .text(String(score), MARGIN + 8, y + 4, { width: 74, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(scoreColor)
           .text(scoreLabel, MARGIN + 8, y + 28, { width: 74, align: 'center' });
      }

      // Resumo executivo
      const resumo = parsedInsight?.resumo_executivo || insight.summary || '';
      if (resumo) {
        doc.font('Helvetica').fontSize(9).fillColor(DARK)
           .text(resumo.substring(0, 500), MARGIN + (score !== null ? 100 : 0), y + 4,
                 { width: COL_W - (score !== null ? 100 : 0), align: 'justify' });
        y += Math.max(50, Math.ceil(resumo.length / 90) * 12 + 10);
      } else {
        y += 50;
      }

      // Acao imediata
      if (parsedInsight?.acao_imediata) {
        if (y > 720) { doc.addPage(); y = MARGIN + 10; }
        const urgColor = parsedInsight.acao_imediata.urgencia === 'critica' ? RED : YELLOW;
        doc.rect(MARGIN, y, COL_W, 38).fill(urgColor + '15');
        doc.font('Helvetica-Bold').fontSize(9).fillColor(urgColor)
           .text('ACAO IMEDIATA: ' + (parsedInsight.acao_imediata.ordem || ''), MARGIN + 8, y + 6, { width: COL_W - 16 });
        doc.font('Helvetica').fontSize(8).fillColor(DARK)
           .text((parsedInsight.acao_imediata.detalhes || '').substring(0, 200), MARGIN + 8, y + 20, { width: COL_W - 16 });
        y += 46;
      }

      // Otimizacoes (top 3)
      if (parsedInsight?.otimizacoes?.length > 0) {
        if (y > 700) { doc.addPage(); y = MARGIN + 10; }
        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text('Otimizacoes Recomendadas:', MARGIN, y);
        y += 14;
        parsedInsight.otimizacoes.slice(0, 3).forEach((o, i) => {
          if (y > 730) { doc.addPage(); y = MARGIN + 10; }
          doc.circle(MARGIN + 5, y + 5, 3).fill(PURPLE);
          doc.font('Helvetica-Bold').fontSize(8).fillColor(PURPLE)
             .text(o.area + ' — ' + o.impacto, MARGIN + 12, y, { width: COL_W - 12 });
          y += 12;
          doc.font('Helvetica').fontSize(8).fillColor(DARK)
             .text(o.acao.substring(0, 150), MARGIN + 12, y, { width: COL_W - 12 });
          y += 16;
        });
      }

      // Data da analise
      const insightDate = new Date(insight.created_at).toLocaleDateString('pt-BR', {
        day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
      });
      doc.font('Helvetica').fontSize(7).fillColor(GRAY)
         .text('Analise gerada em ' + insightDate, MARGIN, y + 6);
    }

    // ── RODAPE ────────────────────────────────────────────────────────────
    const totalPages = doc.bufferedPageRange ? doc.bufferedPageRange().count : 1;
    doc.font('Helvetica').fontSize(7).fillColor(GRAY);
    const footerY = doc.page.height - 30;
    doc.text('IPPMIFY — Profit Intelligence System', MARGIN, footerY, { align: 'left', width: COL_W / 2 });
    doc.text('Relatorio confidencial — ' + new Date().toLocaleDateString('pt-BR'), MARGIN + COL_W / 2, footerY, { align: 'right', width: COL_W / 2 });
    doc.moveTo(MARGIN, footerY - 6).lineTo(PAGE_W - MARGIN, footerY - 6)
       .strokeColor('#E5E7EB').lineWidth(0.5).stroke();

    doc.end();
    console.log('[Reports] PDF gerado para ' + req.user.email + ' — periodo ' + days + ' dias');

  } catch (err) {
    console.error('[Reports] Erro ao gerar PDF:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao gerar PDF: ' + err.message });
    }
  }
});

module.exports = router;
