const OpenAI = require('openai');
const { query } = require('../config/database');
const { calculateOverview, calculateByCampaign } = require('./metricsEngine');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── IPPMIFY AI — GESTOR DE TRÁFEGO ESPECIALISTA 2026 ─────────────────────
// Sistema de análise profunda com inteligência de mercado atualizada

const SYSTEM_PROMPT = `Você é o IPPMIFY AI — o melhor gestor de tráfego pago do Brasil em 2026.

IDENTIDADE E POSTURA:
- Você pensa e age como um gestor de tráfego com 10+ anos de experiência no mercado digital brasileiro
- Você conhece profundamente Meta Ads (Facebook/Instagram), funis de venda, copy, CRO e finanças de campanha
- Você é DIRETO, ACIONÁVEL e ESPECÍFICO — nunca vago ou genérico
- Você prioriza LUCRO REAL, não vaidade de métricas
- Escreva em português brasileiro natural, como um profissional falando com um cliente

INTELIGÊNCIA DE MERCADO 2026 (Meta Ads Brasil):
- CPM médio Feed: R$28–R$65 (subiu ~30% vs 2024 por maior concorrência no leilão)
- CPM médio Reels: R$18–R$45 (formato premium, mais barato por engajamento)
- CPM médio Stories: R$22–R$55
- CTR saudável Feed: 1,5%–4% | Reels: 3%–9% | Stories: 1%–2,5%
- Fadiga criativa acontece em 10–21 dias (mais rápido que antes)
- Advantage+ Audience e Advantage+ Shopping dominam 2026 — targeting manual perdeu eficiência
- iOS 17/18 ATT: ~35–45% das conversões perdidas na atribuição do Pixel (use CAPI para recuperar)
- Janela de atribuição padrão: 7-day click, 1-day view
- ROAS de equilíbrio típico infoprodutos: 1,5x–2,5x dependendo das margens
- Benchmark ROAS saudável infoprodutos: 3x–6x | Top performers: 7x+
- CPA benchmark infoprodutos (ticket R$97–R$297): R$25–R$75 | Excelente: abaixo de R$30
- CPA benchmark ecommerce: R$50–R$120 | Excelente: abaixo de R$45
- Frequência: acima de 3,5 começa a saturar | acima de 5 é fadiga severa
- Hook Rate (3s) saudável: acima de 40% | Excelente: acima de 60%
- Broad + Advantage+ funciona melhor que interesses manuais em 2026
- Campanhas ASC (Advantage+ Shopping) tendem a ter CPA 20–35% menor
- Campanhas de retargeting independentes perderam eficiência — prefira segmentações dentro de ASC
- Regra dos 3x: gaste pelo menos 3x o CPA alvo antes de julgar uma campanha
- Regra das 50 conversões: campanha precisa de 50 conversões no período de aprendizado para sair do Learning Phase
- Nunca edite campanhas em Learning Phase — reinicia o aprendizado
- Budget: altere no máximo 20% por vez, aguarde 48–72h antes de novo ajuste
- Testes A/B: mínimo 7 dias, mesmo volume nos dois grupos, uma variável por vez

QUANDO IDENTIFICAR PROBLEMAS, PENSE ASSIM:
1. É problema de CRIATIVO? (CTR baixo, CPM alto, frequência alta)
2. É problema de PÚBLICO? (CPM explodiu, alcance caindo, ROAS caindo sem criativo mudar)
3. É problema de OFERTA/PÁGINA? (CTR bom, cliques chegando, zero conversão)
4. É problema de BUDGET? (suborçado = não aprende; superorçado sem ROAS = sangramento)
5. É problema de ATRIBUIÇÃO? (CAPI não configurado, compras reais mas pixel não registra)

FORMATO DE SAÍDA OBRIGATÓRIO — JSON puro, sem markdown, sem texto fora do JSON:
{
  "score": <número 0-100 representando saúde geral das campanhas>,
  "score_label": "<Crítico | Atenção | Regular | Bom | Excelente>",
  "resumo_executivo": "<3–4 frases diretas: o que está acontecendo, o principal problema e a principal oportunidade>",
  "alerts": [
    { "nivel": "<critico|alerta|info>", "mensagem": "<alerta específico e acionável>" }
  ],
  "acao_imediata": {
    "urgencia": "<critica|alta|media>",
    "ordem": "<O QUE FAZER AGORA — título curto>",
    "detalhes": "<explicação detalhada com valores específicos e passos concretos>"
  },
  "diagnostico": {
    "gargalo": "<onde está o problema principal: CRIATIVO | PÚBLICO | OFERTA | BUDGET | ATRIBUIÇÃO | ESCALANDO BEM>",
    "explicacao": "<por que você identificou esse gargalo, com dados específicos>"
  },
  "impacto_lucro": {
    "nivel": "<alto|medio|baixo>",
    "valor_estimado": "<ex: R$2.400/mês de lucro perdido ou R$3.000/mês de ganho potencial>",
    "explicacao": "<como você chegou nesse número>"
  },
  "teste_sugerido": {
    "hipotese": "<o que você acredita que vai melhorar e por quê>",
    "execucao": "<passo a passo de como executar o teste: budget, duração, variáveis>"
  },
  "otimizacoes": [
    { "area": "<ex: Criativos | Budget | Público | Landing Page | Horário>", "impacto": "<ex: +30% ROAS>", "acao": "<ação específica e concreta>" }
  ],
  "escala": {
    "condicao": "<o que precisa acontecer primeiro para escalar com segurança>",
    "como": "<estratégia específica de escala: horizontal (novos públicos/criativos) ou vertical (budget)>"
  },
  "copies_sugeridas": [
    { "tipo": "<Hook | CTA | Headline | Prova Social>", "texto": "<copy pronta para usar>" }
  ],
  "campanhas_pausar": ["<nome da campanha>" ],
  "campanhas_escalar": ["<nome da campanha>"],
  "previsao": {
    "proximo_mes": "<o que esperar no próximo mês se mantiver o caminho atual>",
    "cenario_escala": "<o que acontece se implementar as otimizações sugeridas — com valores>"
  }
}

REGRAS CRÍTICAS:
- score 0–39: Crítico (campanhas com prejuízo ou CPA > 2x target)
- score 40–59: Atenção (no limite, precisa de ajustes urgentes)
- score 60–74: Regular (funciona mas tem oportunidades claras)
- score 75–89: Bom (acima da média, com espaço para crescer)
- score 90–100: Excelente (top 10% do mercado)
- Se não há dados de campanhas, score = 0 e seja honesto que faltam dados
- NUNCA invente métricas — use apenas os dados fornecidos
- Se uma campanha tem ROAS < 1x, ela PRECISA estar em campanhas_pausar
- Se uma campanha tem ROAS > target * 1.3 e CTR crescente, coloque em campanhas_escalar
- copies_sugeridas devem ser baseadas no nicho/produto identificado nos dados
- Responda APENAS o JSON — nenhum texto antes ou depois
`;

// ─── GERAR INSIGHTS ────────────────────────────────────────────────────────
const generateInsights = async (userId, days = 7) => {
  console.log(`[AI] Gerando insights para usuario ${userId}, periodo ${days} dias`);

  // Dados do usuario
  const userResult = await query(
    'SELECT name, email, cpa_target, roas_target FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('Usuario nao encontrado');
  const user = userResult.rows[0];

  // Metricas gerais e por campanha
  const overview  = await calculateOverview(userId, days);
  const campaigns = await calculateByCampaign(userId, days);

  // Decisoes recentes do motor de regras (24h)
  const decisionsResult = await query(`
    SELECT type, severity, title, description, recommendation
    FROM decisions
    WHERE user_id = $1
      AND triggered_at >= NOW() - INTERVAL '24 hours'
    ORDER BY severity DESC
    LIMIT 10
  `, [userId]);

  // Historico de vendas — tabela pode nao existir
  let salesRows = [];
  try {
    const salesResult = await query(`
      SELECT
        product_name,
        COUNT(*) AS total_vendas,
        SUM(net_revenue) AS receita_liquida,
        COUNT(CASE WHEN status = 'refunded' THEN 1 END) AS reembolsos
      FROM sales
      WHERE user_id = $1
        AND sale_date >= NOW() - INTERVAL '1 day' * $2
      GROUP BY product_name
      ORDER BY receita_liquida DESC
      LIMIT 5
    `, [userId, days]);
    salesRows = salesResult.rows;
  } catch (_) {
    // tabela sales nao existe ainda
    salesRows = [];
  }

  // Montar prompt com dados reais
  const userPrompt = `Analise os dados de performance do usuário "${user.name}" — últimos ${days} dias.

CONFIGURAÇÕES DO USUÁRIO:
- CPA Target: R$${parseFloat(user.cpa_target || 50).toFixed(2)}
- ROAS Target: ${parseFloat(user.roas_target || 2).toFixed(2)}x

OVERVIEW GERAL (${days} dias):
- Gasto total: R$${parseFloat(overview.spend || 0).toFixed(2)}
- Receita total: R$${parseFloat(overview.revenue || 0).toFixed(2)}
- Lucro total: R$${parseFloat(overview.profit || 0).toFixed(2)}
- ROAS geral: ${parseFloat(overview.roas || 0).toFixed(2)}x
- CPA médio: R$${parseFloat(overview.cpa || 0).toFixed(2)}
- Conversões: ${overview.conversions || 0}
- Impressões: ${overview.impressions || 0}
- Cliques: ${overview.clicks || 0}
- CTR médio: ${parseFloat(overview.ctr || 0).toFixed(2)}%
- CPM médio: R$${parseFloat(overview.cpm || 0).toFixed(2)}
- Campanhas ativas: ${campaigns.filter(c => c.status === 'ACTIVE').length}

DETALHAMENTO POR CAMPANHA:
${campaigns.map(c => `- Campanha: "${c.campaign_name}" | Status: ${c.status} | Gasto: R$${c.spend} | Receita: R$${c.revenue} | Lucro: R$${c.profit} | ROAS: ${c.roas}x | CPA: R$${c.cpa} | CTR: ${c.ctr}% | CPM: R$${c.cpm} | Conversões: ${c.conversions} | Budget diário: R$${c.daily_budget}`).join('\n')}

ALERTAS AUTOMÁTICOS DO SISTEMA (últimas 24h):
${decisionsResult.rows.length > 0
  ? decisionsResult.rows.map(d => `- [Severidade ${d.severity}] ${d.title}: ${d.recommendation}`).join('\n')
  : '- Nenhum alerta crítico nas últimas 24h'}

VENDAS POR PRODUTO:
${salesRows.length > 0
  ? salesRows.map(s => `- ${s.product_name}: ${s.total_vendas} vendas | R$${parseFloat(s.receita_liquida||0).toFixed(2)} receita líquida | ${s.reembolsos} reembolsos`).join('\n')
  : '- Dados de vendas por produto não disponíveis'}

Gere a análise completa em JSON conforme o schema especificado.`;

  try {
    const completion = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ],
      temperature:     0.25,
      response_format: { type: 'json_object' },
      max_tokens:      3000,
    });

    const rawResponse = completion.choices[0].message.content;
    const insights    = JSON.parse(rawResponse);

    // Salvar no banco (usa parametrizado — sem template literal em INTERVAL)
    try {
      await query(`
        INSERT INTO ai_insights
          (user_id, type, period_start, period_end, prompt_used,
           raw_response, summary, recommendations, model_used, tokens_used)
        VALUES ($1, 'daily_report', NOW() - INTERVAL '1 day' * $2, NOW(),
                $3, $4, $5, $6, 'gpt-4o', $7)
      `, [
        userId,
        days,
        userPrompt.substring(0, 5000),
        rawResponse,
        insights.resumo_executivo || insights.summary || '',
        JSON.stringify(insights.otimizacoes || insights.insights || []),
        completion.usage.total_tokens,
      ]);
    } catch (dbErr) {
      // Nao deixa erro de banco matar a resposta
      console.warn('[AI] Nao foi possivel salvar no banco:', dbErr.message);
    }

    console.log(`[AI] Insights gerados — score ${insights.score} — ${completion.usage.total_tokens} tokens`);
    return insights;

  } catch (error) {
    console.error('[AI] Erro ao chamar OpenAI:', error.message);

    // Fallback: gera resposta estruturada no formato correto baseada em dados reais
    const hasData     = parseFloat(overview.spend || 0) > 0;
    const roas        = parseFloat(overview.roas || 0);
    const cpa         = parseFloat(overview.cpa || 0);
    const cpaTarget   = parseFloat(user.cpa_target || 50);
    const roasTarget  = parseFloat(user.roas_target || 2);
    const profit      = parseFloat(overview.profit || 0);

    let score = 50;
    if (!hasData) score = 0;
    else if (roas < 1) score = 15;
    else if (roas < roasTarget) score = 40;
    else if (roas >= roasTarget * 1.3) score = 80;

    const scoreLabel = score >= 90 ? 'Excelente' : score >= 75 ? 'Bom' : score >= 60 ? 'Regular' : score >= 40 ? 'Atenção' : 'Crítico';

    return {
      score,
      score_label:      scoreLabel,
      resumo_executivo: hasData
        ? `ROAS geral de ${roas.toFixed(2)}x com gasto de R$${parseFloat(overview.spend).toFixed(2)}. Lucro: R$${profit.toFixed(2)}. IA temporariamente indisponível — ${decisionsResult.rows.length} alertas detectados pelo motor de regras.`
        : 'Nenhuma campanha com dados encontrada. Conecte sua conta de anúncios para receber análises.',
      alerts: decisionsResult.rows.map(d => ({
        nivel:    d.severity >= 9 ? 'critico' : d.severity >= 7 ? 'alerta' : 'info',
        mensagem: d.title,
      })),
      acao_imediata: {
        urgencia: decisionsResult.rows[0]?.severity >= 9 ? 'critica' : 'alta',
        ordem:    decisionsResult.rows[0]?.title || 'Verifique suas campanhas',
        detalhes: decisionsResult.rows[0]?.recommendation || 'Acesse o painel de Decisões para ver os alertas detalhados.',
      },
      diagnostico: {
        gargalo:    roas < 1 ? 'OFERTA' : cpa > cpaTarget * 1.5 ? 'PÚBLICO' : 'ESCALANDO',
        explicacao: hasData ? `ROAS ${roas.toFixed(2)}x vs target ${roasTarget}x. CPA R$${cpa.toFixed(2)} vs target R$${cpaTarget.toFixed(2)}.` : 'Dados insuficientes.',
      },
      impacto_lucro: {
        nivel:           profit < 0 ? 'alto' : 'medio',
        valor_estimado:  `R$${Math.abs(profit).toFixed(2)} no período`,
        explicacao:      profit < 0 ? 'Campanhas operando no prejuízo.' : 'Lucro positivo no período.',
      },
      teste_sugerido: {
        hipotese: 'Testar novos criativos com hooks diferentes nos primeiros 3 segundos.',
        execucao: 'Crie 3–5 vídeos com ângulos distintos. Teste por 7 dias com o mesmo budget. Compare CTR e CPA.',
      },
      otimizacoes: campaigns.filter(c => c.cpa > cpaTarget).map(c => ({
        area:    'CPA',
        impacto: `Reduzir CPA de R$${c.cpa} para R$${cpaTarget}`,
        acao:    `Revise criativos e público da campanha "${c.campaign_name}". Pause se CPA > 2x target.`,
      })).slice(0, 3),
      escala: {
        condicao: `ROAS acima de ${roasTarget}x por pelo menos 7 dias consecutivos.`,
        como:     'Aumente budget em 20% a cada 48h. Não edite outros parâmetros durante a escala.',
      },
      copies_sugeridas: [
        { tipo: 'Hook', texto: 'Você ainda paga caro por lead? Veja como reduzir seu CPA em 40% sem aumentar o budget.' },
        { tipo: 'CTA', texto: 'Clique e descubra o método → resultado em 7 dias ou seu dinheiro de volta.' },
      ],
      campanhas_pausar:  campaigns.filter(c => c.roas < 1 || c.cpa > cpaTarget * 2).map(c => c.campaign_name),
      campanhas_escalar: campaigns.filter(c => c.roas > roasTarget * 1.3).map(c => c.campaign_name),
      previsao: {
        proximo_mes:    hasData ? `Se mantiver o ROAS de ${roas.toFixed(2)}x, lucro estimado de R$${(profit * 4).toFixed(2)} no próximo mês.` : 'Conecte campanhas para projeções.',
        cenario_escala: 'Com as otimizações aplicadas e ROAS acima do target, potencial de escalar 2–3x o budget em 60 dias.',
      },
    };
  }
};

// ─── BUSCAR ULTIMO INSIGHT SALVO ───────────────────────────────────────────
const getLastInsights = async (userId, limit = 5) => {
  try {
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
        : row.recommendations,
    }));
  } catch (_) {
    return [];
  }
};

module.exports = { generateInsights, getLastInsights };
