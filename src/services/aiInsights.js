const OpenAI = require('openai');
const { query } = require('../config/database');
const { calculateOverview, calculateByCampaign } = require('./metricsEngine');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── SISTEMA DE IA INSIGHTS (GPT-4o) ─────────────────────────────────────
// Gera analise profunda e recomendacoes acionaveis em portugues

const SYSTEM_PROMPT = `Voce e o IPPMIFY, um analista especialista em trafego pago e lucro real para infoprodutores e afiliados brasileiros.

SEU PAPEL:
- Analisar dados de campanhas de Meta Ads e vendas de Hotmart/Kiwify
- Identificar o que esta funcionando, o que esta falhando e por que
- Gerar recomendacoes ESPECIFICAS, ACIONAVEIS e PRIORIZADAS por impacto financeiro
- Ser direto: diga o que fazer, nao apenas o que esta acontecendo

REGRAS CRITICAS:
- NUNCA use linguagem vaga como "considere verificar" ou "pode ser util"
- SEMPRE especifique valores exatos: "Aumente o budget de R$100 para R$130"
- SEMPRE priorize por impacto financeiro potencial
- Escreva em portugues brasileiro claro e direto
- Responda APENAS em formato JSON valido conforme o schema abaixo

JSON SCHEMA OBRIGATORIO:
{
  "summary": "Resumo executivo em 2-3 frases diretas sobre a situacao geral",
  "overall_health": "critical | poor | ok | good | excellent",
  "key_metrics": {
    "total_spend": 0.0,
    "total_revenue": 0.0,
    "total_profit": 0.0,
    "blended_roas": 0.0
  },
  "insights": [
    {
      "priority": 1,
      "type": "problem | opportunity | info",
      "campaign_name": "nome da campanha ou Geral",
      "finding": "O que foi detectado — seja especifico",
      "impact": "Impacto financeiro estimado em reais",
      "action": "Acao especifica a tomar — com valores concretos",
      "urgency": "immediate | today | this_week"
    }
  ],
  "top_action": "A UNICA coisa mais importante a fazer AGORA — em uma frase direta"
}`;

// Gerar insights para um usuario
const generateInsights = async (userId, days = 7) => {
  console.log(`[AI] Gerando insights para usuario ${userId}`);

  // Buscar dados do usuario
  const userResult = await query(
    'SELECT name, email, cpa_target, roas_target FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('Usuario nao encontrado');
  const user = userResult.rows[0];

  // Buscar metricas
  const overview  = await calculateOverview(userId, days);
  const campaigns = await calculateByCampaign(userId, days);

  // Buscar decisoes recentes do motor de regras (ultimas 24h)
  const decisionsResult = await query(`
    SELECT type, severity, title, description, recommendation
    FROM decisions
    WHERE user_id = $1
      AND triggered_at >= NOW() - INTERVAL '24 hours'
    ORDER BY severity DESC
    LIMIT 10
  `, [userId]);

  // Buscar historico de vendas por produto
  const salesResult = await query(`
    SELECT
      product_name,
      COUNT(*) AS total_vendas,
      SUM(net_revenue) AS receita_liquida,
      COUNT(CASE WHEN status = 'refunded' THEN 1 END) AS reembolsos
    FROM sales
    WHERE user_id = $1
      AND sale_date >= NOW() - INTERVAL '${days} days'
    GROUP BY product_name
    ORDER BY receita_liquida DESC
    LIMIT 5
  `, [userId]);

  // Montar o prompt com os dados reais
  const userPrompt = `Analise os dados de performance do usuario "${user.name}" para os ultimos ${days} dias.

CONFIGURACOES DO USUARIO:
- CPA Target: R$${parseFloat(user.cpa_target || 50).toFixed(2)}
- ROAS Target: ${parseFloat(user.roas_target || 2).toFixed(2)}x

METRICAS GERAIS (${days} dias):
${JSON.stringify(overview, null, 2)}

METRICAS POR CAMPANHA:
${JSON.stringify(campaigns.map(c => ({
  campanha: c.campaign_name,
  status: c.status,
  gasto: `R$${c.spend}`,
  receita: `R$${c.revenue}`,
  lucro: `R$${c.profit}`,
  roas: `${c.roas}x`,
  cpa: `R$${c.cpa}`,
  ctr: `${c.ctr}%`,
  conversoes: c.conversions,
  orcamento_diario: `R$${c.daily_budget}`
})), null, 2)}

ALERTAS JA DETECTADOS PELO SISTEMA (24h):
${JSON.stringify(decisionsResult.rows, null, 2)}

VENDAS POR PRODUTO:
${JSON.stringify(salesResult.rows, null, 2)}

Gere a analise completa em JSON no formato especificado.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ],
      temperature: 0.3,  // Mais preciso, menos criativo
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    });

    const rawResponse = completion.choices[0].message.content;
    const insights = JSON.parse(rawResponse);

    // Salvar no banco
    await query(`
      INSERT INTO ai_insights
        (user_id, type, period_start, period_end, prompt_used,
         raw_response, summary, recommendations, model_used, tokens_used)
      VALUES ($1, 'daily_report', NOW() - INTERVAL '${days} days', NOW(),
              $2, $3, $4, $5, 'gpt-4o', $6)
    `, [
      userId,
      userPrompt.substring(0, 5000), // Salvar prompt truncado
      rawResponse,
      insights.summary,
      JSON.stringify(insights.insights),
      completion.usage.total_tokens
    ]);

    console.log(`[AI] Insights gerados — ${completion.usage.total_tokens} tokens usados`);
    return insights;

  } catch (error) {
    console.error('[AI] Erro ao gerar insights:', error.message);

    // Fallback: retornar insights basicos baseados nas regras
    return {
      summary: `Sistema de IA temporariamente indisponivel. Motor de regras detectou ${decisionsResult.rows.length} alertas.`,
      overall_health: overview.profit >= 0 ? 'ok' : 'poor',
      key_metrics: {
        total_spend:    overview.spend,
        total_revenue:  overview.revenue,
        total_profit:   overview.profit,
        blended_roas:   overview.roas
      },
      insights: decisionsResult.rows.slice(0, 5).map((d, i) => ({
        priority: i + 1,
        type: d.severity >= 7 ? 'problem' : 'info',
        campaign_name: 'Ver detalhe',
        finding: d.title,
        impact: 'Verifique o painel',
        action: d.recommendation,
        urgency: d.severity >= 9 ? 'immediate' : d.severity >= 7 ? 'today' : 'this_week'
      })),
      top_action: decisionsResult.rows[0]?.recommendation || 'Verifique suas campanhas no painel.'
    };
  }
};

// Buscar ultimo insight salvo no banco
const getLastInsights = async (userId, limit = 5) => {
  const result = await query(`
    SELECT id, type, summary, recommendations, created_at, model_used
    FROM ai_insights
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [userId, limit]);

  return result.rows.map(row => ({
    ...row,
    recommendations: typeof row.recommendations === 'string'
      ? JSON.parse(row.recommendations)
      : row.recommendations
  }));
};

module.exports = { generateInsights, getLastInsights };
