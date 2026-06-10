const Anthropic  = require('@anthropic-ai/sdk');
const { query }  = require('../config/database');
const { calculateOverview, calculateByCampaign, calculateDailyHistory } = require('./metricsEngine');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — IPPMIFY AI
// Operador de performance. Foco único: LUCRO.
// ═══════════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Você é a IPPMIFY AI — o sistema de inteligência de performance e lucro.
Sua função NÃO é apenas analisar dados. Sua função é AUMENTAR O LUCRO do usuário tomando decisões estratégicas e operacionais.

Você age como:
- Gestor de Tráfego Sênior (Meta Ads especialista)
- Copywriter de alta conversão (direct response)
- Analista de dados orientado a ROI
- Consultor de crescimento agressivo

Seu objetivo é maximizar: LUCRO = RECEITA - CUSTO

Você otimiza: ROI, ROAS, CPA, LTV, Taxa de conversão.
Você ignora métricas de vaidade se não impactarem lucro diretamente.

REGRAS CRÍTICAS:
- NUNCA dê respostas genéricas
- NUNCA fale como professor — fale como operador
- Dê ORDENS claras: pause isso, escale isso, teste isso
- Priorize ações que impactam caixa RÁPIDO
- Se algo está dando prejuízo → MANDE CORTAR
- Se algo está dando lucro → MANDE ESCALAR
- Quando identificar prejuízo claro: seja direto e incisivo — o usuário está perdendo dinheiro AGORA
- Quando identificar oportunidade: mostre o potencial e dê instrução de crescimento
- Se houver problema de conversão: gere copies novas e sugira ângulos (dor, desejo, prova, urgência)

SCORE DE PERFORMANCE (0-100):
- 0-30: Crítico (campanha queimando dinheiro)
- 31-50: Ruim (abaixo do break-even)
- 51-65: Moderado (lucrativo mas com gargalos sérios)
- 66-80: Bom (otimizações incrementais)
- 81-100: Excelente (escale com segurança)

RESPONDA APENAS EM JSON VÁLIDO com esta estrutura EXATA:
{
  "score": 0,
  "score_label": "string",
  "score_cor": "vermelho | laranja | amarelo | verde | azul",
  "resumo_executivo": "2-3 frases diretas sobre a situação. Sem eufemismos.",
  "alerts": [
    { "nivel": "critico | aviso | info", "mensagem": "string curta e direta" }
  ],
  "diagnostico": {
    "gargalo": "tráfego | criativo | oferta | funil | público | orçamento",
    "explicacao": "Por que esse é o gargalo principal? Seja específico com os números."
  },
  "impacto_lucro": {
    "nivel": "alto | medio | baixo",
    "valor_estimado": "ex: R$1.200/semana sendo perdido",
    "explicacao": "string"
  },
  "acao_imediata": {
    "urgencia": "agora | hoje | esta_semana",
    "ordem": "FRASE DE ORDEM DIRETA. Ex: Pause o conjunto X imediatamente.",
    "detalhes": "Como fazer exatamente, passo a passo"
  },
  "otimizacoes": [
    { "area": "string", "acao": "string específica com números", "impacto": "alto | medio | baixo" }
  ],
  "teste_sugerido": {
    "hipotese": "O que você acredita que vai melhorar e por quê",
    "execucao": "Como executar o teste exatamente"
  },
  "escala": {
    "condicao": "Quando escalar — ex: ROAS > 3x por 3 dias seguidos",
    "como": "Instrução de escala: ex: Aumente o budget 20% a cada 48h"
  },
  "copies_sugeridas": [
    { "tipo": "Hook | Headline | CTA | Depoimento | Quebra de crença", "texto": "texto completo pronto para usar" }
  ],
  "previsao": {
    "proximo_mes": "R$ estimado de lucro ou prejuízo se mantiver curso atual",
    "cenario_escala": "R$ estimado se aplicar as recomendações"
  },
  "campanhas_pausar": ["nomes das campanhas/conjuntos para pausar agora"],
  "campanhas_escalar": ["nomes das campanhas/conjuntos para escalar"]
}`;

// ═══════════════════════════════════════════════════════════════════════════
// GERAR ANÁLISE — IPPMIFY AI
// ═══════════════════════════════════════════════════════════════════════════
const generateInsights = async (userId, days = 7) => {
  console.log(`[IPPMIFY AI] Gerando análise para usuário ${userId} (${days} dias)`);

  // ── Verificar cache (se análise foi gerada há menos de 2h, retornar a do banco) ──
  const cached = await query(`
    SELECT raw_response, created_at FROM ai_insights
    WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC LIMIT 1
  `, [userId]);

  if (cached.rows.length > 0) {
    console.log('[IPPMIFY AI] Retornando análise em cache (< 2h)');
    try {
      const parsed = JSON.parse(cached.rows[0].raw_response);
      parsed._cached  = true;
      parsed._cached_at = cached.rows[0].created_at;
      return parsed;
    } catch (_) { /* cache corrompido, gera nova */ }
  }

  // ── Buscar dados do usuário ───────────────────────────────────────────────
  const userResult = await query(
    'SELECT name, email, cpa_target, roas_target FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('Usuário não encontrado');
  const user = userResult.rows[0];

  // ── Métricas agregadas ────────────────────────────────────────────────────
  const overview   = await calculateOverview(userId, days);
  const campaigns  = await calculateByCampaign(userId, days);
  const history7d  = await calculateDailyHistory(userId, null, 7).catch(() => []);

  // ── Decisões recentes do motor de regras (últimas 48h) ────────────────────
  const decisionsResult = await query(`
    SELECT type, severity, title, description, recommendation
    FROM decisions
    WHERE user_id = $1 AND triggered_at >= NOW() - INTERVAL '48 hours'
    ORDER BY severity DESC LIMIT 15
  `, [userId]);

  // ── Vendas por produto ────────────────────────────────────────────────────
  const salesResult = await query(`
    SELECT product_name,
           COUNT(*)                                              AS total_vendas,
           SUM(net_revenue)                                     AS receita_liquida,
           COUNT(CASE WHEN status = 'refunded' THEN 1 END)      AS reembolsos,
           ROUND(AVG(net_revenue)::numeric, 2)                  AS ticket_medio
    FROM sales
    WHERE user_id = $1 AND sale_date >= NOW() - INTERVAL '${days} days'
    GROUP BY product_name ORDER BY receita_liquida DESC LIMIT 5
  `, [userId]);

  // ── Histórico anterior para comparação de tendência ──────────────────────
  const prevOverview = await calculateOverview(userId, days * 2)
    .then(full => ({
      spend:   (full.spend   || 0) - (overview.spend   || 0),
      revenue: (full.revenue || 0) - (overview.revenue || 0),
      profit:  (full.profit  || 0) - (overview.profit  || 0),
    })).catch(() => null);

  // ── Montar prompt ─────────────────────────────────────────────────────────
  const tendencia = prevOverview ? (
    overview.profit > prevOverview.profit ? 'em ALTA' :
    overview.profit < prevOverview.profit ? 'em QUEDA' : 'estável'
  ) : 'sem dados anteriores';

  const userPrompt = `Analise a conta de tráfego pago do usuário "${user.name}" para os últimos ${days} dias.

METAS DO USUÁRIO:
- CPA Target: R$${parseFloat(user.cpa_target || 50).toFixed(2)}
- ROAS Target: ${parseFloat(user.roas_target || 2).toFixed(2)}x

RESUMO GERAL (${days} dias):
- Investimento total: R$${(overview.spend || 0).toFixed(2)}
- Receita total: R$${(overview.revenue || 0).toFixed(2)}
- Lucro bruto: R$${(overview.profit || 0).toFixed(2)}
- ROAS geral: ${(overview.roas || 0).toFixed(2)}x
- CPA médio: R$${(overview.cpa || 0).toFixed(2)}
- Conversões: ${overview.conversions || 0}
- CTR médio: ${(overview.ctr || 0).toFixed(2)}%
- CPM médio: R$${(overview.cpm || 0).toFixed(2)}
- Tendência vs período anterior: ${tendencia}

CAMPANHAS ATIVAS:
${JSON.stringify(campaigns.map(c => ({
  campanha: c.campaign_name,
  status: c.status,
  gasto: parseFloat(c.spend || 0).toFixed(2),
  receita: parseFloat(c.revenue || 0).toFixed(2),
  lucro: parseFloat(c.profit || 0).toFixed(2),
  roas: parseFloat(c.roas || 0).toFixed(2) + 'x',
  cpa: 'R$' + parseFloat(c.cpa || 0).toFixed(2),
  ctr: parseFloat(c.ctr || 0).toFixed(2) + '%',
  conversoes: c.conversions || 0,
  orcamento_diario: 'R$' + parseFloat(c.daily_budget || 0).toFixed(2),
})), null, 2)}

ALERTAS DO SISTEMA (48h):
${decisionsResult.rows.length > 0
  ? JSON.stringify(decisionsResult.rows, null, 2)
  : 'Nenhum alerta recente'}

VENDAS POR PRODUTO:
${salesResult.rows.length > 0
  ? JSON.stringify(salesResult.rows, null, 2)
  : 'Sem dados de venda registrados'}

${history7d.length > 0 ? `HISTÓRICO DIÁRIO (7 dias):
${JSON.stringify(history7d.slice(-7).map(d => ({
  data: d.date,
  gasto: parseFloat(d.spend || 0).toFixed(2),
  receita: parseFloat(d.revenue || 0).toFixed(2),
  lucro: parseFloat(d.profit || 0).toFixed(2),
})), null, 2)}` : ''}

Faça a análise completa como IPPMIFY AI. Responda APENAS com o JSON válido especificado no system prompt. Sem texto fora do JSON.`;

  // ── Chamar Claude ─────────────────────────────────────────────────────────
  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const rawText = response.content[0].text.trim();

    // Extrair JSON mesmo se vier com markdown ```json ... ```
    let jsonStr = rawText;
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const insights = JSON.parse(jsonStr);

    // ── Salvar no banco ───────────────────────────────────────────────────
    await query(`
      INSERT INTO ai_insights
        (user_id, type, period_start, period_end, prompt_used,
         raw_response, summary, recommendations, model_used, tokens_used)
      VALUES ($1, 'ippmify_ai', NOW() - INTERVAL '${days} days', NOW(),
              $2, $3, $4, $5, 'claude-sonnet-4-6', $6)
    `, [
      userId,
      userPrompt.substring(0, 5000),
      JSON.stringify(insights),
      insights.resumo_executivo || insights.summary || '',
      JSON.stringify(insights.otimizacoes || insights.insights || []),
      (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    ]);

    console.log(`[IPPMIFY AI] Análise gerada — score: ${insights.score}, tokens: ${response.usage?.input_tokens + response.usage?.output_tokens}`);
    return insights;

  } catch (error) {
    console.error('[IPPMIFY AI] Erro ao gerar análise:', error.message);

    // ── Fallback baseado nos dados sem IA ────────────────────────────────
    const roas  = overview.roas  || 0;
    const profit = overview.profit || 0;
    const score = roas >= 3 ? 75 : roas >= 2 ? 55 : roas >= 1 ? 35 : 15;

    return {
      score,
      score_label: score >= 66 ? 'Performance Boa' : score >= 51 ? 'Performance Moderada' : score >= 31 ? 'Performance Ruim' : 'CRÍTICO',
      score_cor:   score >= 66 ? 'verde' : score >= 51 ? 'amarelo' : score >= 31 ? 'laranja' : 'vermelho',
      resumo_executivo: `Sistema de IA indisponível (verifique ANTHROPIC_API_KEY). ROAS atual: ${roas.toFixed(2)}x | Lucro: R$${profit.toFixed(2)}.`,
      alerts: decisionsResult.rows.slice(0, 5).map(d => ({
        nivel: d.severity >= 8 ? 'critico' : d.severity >= 5 ? 'aviso' : 'info',
        mensagem: d.title,
      })),
      diagnostico: { gargalo: 'dados insuficientes', explicacao: 'Conecte sua conta Meta Ads e registre vendas para análise completa.' },
      impacto_lucro: { nivel: profit < 0 ? 'alto' : 'medio', valor_estimado: `R$${Math.abs(profit).toFixed(2)}`, explicacao: profit < 0 ? 'Operação no prejuízo.' : 'Operação lucrativa.' },
      acao_imediata: { urgencia: 'hoje', ordem: decisionsResult.rows[0]?.recommendation || 'Verifique suas campanhas.', detalhes: 'Acesse o Meta Ads Manager e revise os conjuntos ativos.' },
      otimizacoes: [],
      teste_sugerido: { hipotese: '', execucao: '' },
      escala: { condicao: '', como: '' },
      copies_sugeridas: [],
      previsao: { proximo_mes: '', cenario_escala: '' },
      campanhas_pausar: [],
      campanhas_escalar: [],
      _erro: error.message,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// BUSCAR ÚLTIMAS ANÁLISES
// ═══════════════════════════════════════════════════════════════════════════
const getLastInsights = async (userId, limit = 5) => {
  const result = await query(`
    SELECT id, type, summary, recommendations, raw_response, model_used, tokens_used, created_at
    FROM ai_insights
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [userId, limit]);

  return result.rows.map(row => {
    let parsed = null;
    try { parsed = JSON.parse(row.raw_response); } catch (_) {}
    return {
      ...row,
      parsed,
      recommendations: typeof row.recommendations === 'string'
        ? JSON.parse(row.recommendations)
        : row.recommendations,
    };
  });
};

module.exports = { generateInsights, getLastInsights };
