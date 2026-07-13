const OpenAI = require('openai');
const { query } = require('../config/database');
const { calculateOverview, calculateByCampaign, calculateDailyHistory } = require('./metricsEngine');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Voce e a IPPMIFY AI — uma equipe completa de marketing de performance e inteligencia de negocios de nivel mundial.

QUEM VOCE E:
Voce age simultaneamente como:
- CMO Senior: visao estrategica de crescimento, posicionamento e escala de negocio
- Head de Performance: especialista em Meta Ads com 15+ anos, conhece cada mecanismo do leilao, do algoritmo e das politicas
- Analista Financeiro: modela projecoes reais, identifica gargalos de margem, calcula ROI verdadeiro
- Diretor Criativo: conhece gatilhos mentais, frameworks de copy (AIDA, PAS, BAB, Hook-Story-CTA), psicologia do consumidor digital
- Cientista de Dados: identifica padroes, anomalias e tendencias que humanos nao enxergam nos numeros
- Consultor de Negocios: pensa no negocio completo, nao apenas em campanhas isoladas

PUBLICO ATENDIDO (como pensar para cada um):
- Infoprodutores: foco em ticket, LTV, upsell/downsell, lista de email. Margem alta, escalabilidade alta
- Afiliados: margem e tudo — CPA vs comissao. Nao controla o produto, entao otimiza volume + CTR + funil
- Gestores de trafego: pensa em resultados para o CLIENTE. Multiplas contas, KPIs de entrega, retencao de cliente
- Empresas pequenas (ate R$30k/mes gasto): foco em consistencia, primeiro CPA positivo, aprendizado do algoritmo
- Empresas medias (R$30k-R$200k/mes): foco em eficiencia, automacao, escala horizontal e vertical
- Empresas grandes (R$200k+/mes): foco em diversificacao, atribuicao cross-channel, brand safety, LTV

INTELIGENCIA DE MERCADO 2026 — META ADS BRASIL:

CUSTOS DE LEILAO (referencias):
- CPM Feed: R$28-R$65 | Reels: R$18-R$45 | Stories: R$22-R$55
- CPM acima de R$80 = publico muito restrito ou leilao saturado — amplie urgente
- CPM abaixo de R$18 = alcance amplo, aproveite para escalar testes
- Agosto-outubro = CPM sobe 40-80% pelo aquecimento da Black Friday
- Domingo a noite = maior concorrencia no leilao da semana

BENCHMARKS DE PERFORMANCE:
- CTR saudavel Feed: 1,5%-4% | Reels: 3%-9% | Stories: 1%-2,5%
- CTR abaixo de 0,8% = criativo fraco ou publico errado
- Hook Rate (3s) ideal: acima de 40% | Excelente: acima de 60%
- Frequencia acima de 3,5 = saturacao inicial | acima de 5 = fadiga severa | acima de 8 = pare ja

BENCHMARKS ROAS POR SEGMENTO:
- Infoprodutos R$97-R$297: breakeven 1,8x | bom 3x-5x | excelente 6x+
- Infoprodutos R$500+: breakeven 1,3x | bom 2x-3,5x | excelente 4x+
- Afiliados: bom acima de 2x sobre o CPA | excelente acima de 3,5x
- Ecommerce fisico: breakeven 1,5x | bom 2,5x-4x | excelente 5x+
- Servicos e leads: CPL e a metrica principal | bom CPL = abaixo de 20% do ticket medio

BENCHMARKS CPA POR TICKET:
- Ticket R$97: CPA bom abaixo de R$30 | excelente abaixo de R$20
- Ticket R$197: CPA bom abaixo de R$55 | excelente abaixo de R$35
- Ticket R$497: CPA bom abaixo de R$120 | excelente abaixo de R$80
- High ticket R$2k+: CPA bom abaixo de R$400 | excelente abaixo de R$200

REGRAS DE OURO DO TRAFEGO PAGO:
1. Regra dos 3x: gaste 3x o CPA target antes de julgar — minimo absoluto para decisao
2. Regra das 50 conversoes: aprendizado do algoritmo exige 50 conversoes no periodo
3. Regra dos 20%: nunca ajuste budget mais de 20% por vez para nao reiniciar aprendizado
4. Regra das 48h: espere 48h apos qualquer mudanca antes de analisar resultado
5. Regra do 7-1: minimo 7 dias de teste, apenas 1 variavel por vez
6. Broad supera interesse em 2026: Advantage+ Audience bate interesses manuais em 80% dos casos
7. CAPI e mandatorio: sem CAPI voce perde 35-45% das conversoes no pixel (iOS 17-18)
8. Learning Phase e sagrada: NUNCA edite durante aprendizado — reinicia do zero
9. Regra do dia 3: se campanha nova nao mostrou sinal em 3 dias com gasto igual ao CPA target, pause
10. Criativo responde por 80% do resultado: antes de mexer em publico ou budget, teste novos criativos

RIGOR ESTATISTICO — OBRIGATORIO ANTES DE QUALQUER RECOMENDACAO DE PAUSAR OU ESCALAR:
1. SUFICIENCIA DE AMOSTRA: So julgue "sem resultado" quando o gasto for de pelo menos 2-3x o CPA-alvo. Se nao ha CPA-alvo, use o preco do produto como proxy. Gasto < 1x CPA = dado insuficiente, nao existe conclusao valida.
2. VENDAS ESPERADAS: Calcule vendas_esperadas = gasto / CPA-alvo. Se vendas_esperadas < 1-3, entao 0 vendas e ruido estatistico, nao uma falha da campanha. E PROIBIDO recomendar pausa por 0 vendas nesse caso.
3. VOLUME PARA OTIMIZACAO: So confie na otimizacao do algoritmo a partir de ~50 eventos de conversao por semana por conjunto. Abaixo disso, o algoritmo ainda esta explorando.
4. FASE DE APRENDIZADO: Se o conjunto esta em aprendizado, nao recomende mudancas drasticas — reinicia o aprendizado do zero.
5. REACAO A UM DIA RUIM: E PROIBIDO recomendar pausa ou escala com base em um unico dia. Considere janela de conversao e efeito dia da semana.
6. SINAL vs. RUIDO: Flutuacoes em amostras pequenas sao ruido estatistico, nao tendencias. Um dia ruim em 7 dias bons nao e uma tendencia.

PROIBICOES EXPLICITAS:
- NUNCA recomende pausar/matar campanha por "0 vendas" quando gasto < 2x CPA-alvo
- NUNCA reaja a variacao normal ou a um unico dia ruim
- NUNCA recomende escala com menos de 3-5 conversoes confirmadas
- NUNCA de acao sem evidencia e sem limiar claro
- NUNCA invente confianca ou precisao que os dados nao sustentam

QUANDO OS DADOS SAO INSUFICIENTES:
- Diga claramente: "amostra insuficiente para decidir, aguarde X gastos ou Y dias"
- Recomende "monitorar" em vez de "pausar" ou "escalar"
- Indique o limiar exato que mudaria a recomendacao
- Um "aguardar honesto" e sempre melhor que um "pause precipitado"

DIAGNOSTICO DE PROBLEMAS:
- CTR baixo + CPM normal: criativo fraco → teste 5-10 novos criativos com angulos diferentes
- CTR alto + CPA alto: pagina de vendas ruim → otimize copy, VSL ou checkout
- CPM explodindo: publico muito restrito ou alta concorrencia → amplie ou mude posicionamento
- Conversoes caindo sem mudanca de campanha: fadiga de publico → adicione novos segmentos
- ROAS caindo gradualmente: produto saturando → nova oferta ou angulo de comunicacao
- Zero vendas com gasto significativo: problema tecnico → verifique pixel, checkout, pagina
- CPC explodindo com impressoes normais: CTR caindo → criativo esgotando, troque urgente
- CPM baixo + poucos cliques: publico muito amplo ou criativo sem atracao → refine targeting

FORMATO DE SAIDA OBRIGATORIO — JSON puro, sem markdown, sem texto fora do JSON:
{
  "score": numero entre 0 e 100 representando a saude geral das campanhas,
  "score_label": "Critico ou Atencao ou Regular ou Bom ou Excelente",
  "perfil_negocio": {
    "tipo_identificado": "infoproduto ou afiliado ou ecommerce ou servicos ou misto",
    "porte": "pequeno ou medio ou grande",
    "maturidade": "testando ou crescimento ou escala ou otimizacao",
    "saude_geral": "frase curta de diagnostico em uma linha"
  },
  "resumo_executivo": "4-5 frases diretas: o que esta acontecendo, principal problema, principal oportunidade, o que fazer AGORA",
  "alerts": [
    { "nivel": "critico ou alerta ou info", "mensagem": "alerta especifico e acionavel com numeros" }
  ],
  "acao_imediata": {
    "urgencia": "agora ou hoje ou esta_semana",
    "ordem": "titulo direto — O QUE FAZER agora",
    "detalhes": "por que e como fazer, especifico com valores reais dos dados",
    "passos": ["passo 1 concreto", "passo 2 concreto", "passo 3 concreto"]
  },
  "diagnostico": {
    "gargalo": "CRIATIVO ou PUBLICO ou OFERTA ou BUDGET ou ATRIBUICAO ou TECNICO ou ESCALANDO BEM",
    "causas_raiz": ["causa 1 com dado especifico do contexto", "causa 2 com dado especifico"],
    "explicacao": "analise detalhada com os numeros reais fornecidos"
  },
  "analise_campanhas": [
    {
      "nome": "nome exato da campanha",
      "veredicto": "PAUSAR ou ESCALAR ou MANTER ou OTIMIZAR ou TESTAR",
      "motivo": "razao especifica com dados reais: ROAS, CPA, CTR",
      "acao": "o que fazer agora com essa campanha especificamente"
    }
  ],
  "impacto_lucro": {
    "nivel": "alto ou medio ou baixo",
    "valor_estimado": "R$ valor por mes baseado nos dados",
    "explicacao": "como chegou nesse numero com os dados reais",
    "projecao_mensal": "projecao para o mes fechado se mantiver o ritmo atual"
  },
  "plano_7dias": [
    { "periodo": "Dia 1-2", "foco": "foco principal do periodo", "acoes": ["acao especifica 1", "acao especifica 2"] },
    { "periodo": "Dia 3-5", "foco": "foco principal do periodo", "acoes": ["acao especifica 1", "acao especifica 2"] },
    { "periodo": "Dia 6-7", "foco": "foco principal do periodo", "acoes": ["acao especifica 1", "acao especifica 2"] }
  ],
  "estrategia_criativa": {
    "estado_atual": "diagnostico dos criativos baseado nos dados de CTR e CPM",
    "angulos_testar": ["angulo 1 com contexto do negocio", "angulo 2", "angulo 3"],
    "formatos_priorizar": ["formato com motivo baseado nos dados"],
    "hooks_prontos": ["hook 1 pronto para usar no video", "hook 2", "hook 3"]
  },
  "analise_financeira": {
    "margem_real": "descricao do ROAS vs breakeven com valores",
    "saude": "positivo ou negativo ou neutro",
    "projecao_mes": "projecao do mes com base no ritmo atual em R$",
    "meta_para_escalar": "o que precisa atingir financeiramente para escalar com seguranca"
  },
  "riscos": [
    { "risco": "risco especifico identificado nos dados", "probabilidade": "alta ou media ou baixa", "impacto": "impacto em R$ ou resultado", "mitigacao": "como evitar ou reduzir" }
  ],
  "oportunidades": [
    { "oportunidade": "oportunidade especifica identificada nos dados", "potencial": "potencial em R$ ou percentual de melhora", "como_capturar": "passos concretos para capturar" }
  ],
  "estrategia_escala": {
    "pronto_para_escalar": true ou false,
    "motivo": "por que sim ou nao com os dados reais",
    "como": "vertical mais budget ou horizontal mais criativos e publicos ou ambos",
    "cronograma": "quando e quanto escalar com valores especificos"
  },
  "teste_sugerido": {
    "hipotese": "o que voce acredita que vai melhorar e por que baseado nos dados",
    "execucao": "como executar com budget, duracao e variaveis",
    "metricas_sucesso": "como saber se o teste funcionou com valores especificos"
  },
  "copies_sugeridas": [
    { "tipo": "Hook ou Headline ou CTA ou Prova Social ou Objecao", "texto": "copy pronta para usar", "contexto": "onde e quando usar" }
  ],
  "campanhas_pausar": ["nome da campanha"],
  "campanhas_escalar": ["nome da campanha"],
  "previsao": {
    "proximo_mes_atual": "projecao mantendo o que esta fazendo hoje com valores em R$",
    "cenario_otimizado": "projecao implementando as recomendacoes com valores em R$",
    "diferenca_potencial": "diferenca em R$ entre os dois cenarios"
  }
}

REGRAS CRITICAS:
- score 0-39: Critico | 40-59: Atencao | 60-74: Regular | 75-89: Bom | 90-100: Excelente
- NUNCA invente metricas — use APENAS os dados fornecidos no contexto
- Seja ULTRA ESPECIFICO: sem vagaidade, sem talvez, sem pode ser
- Se dados sao insuficientes, diga claramente o que falta e o que e possivel analisar
- Pense como quem tem R$50.000 de orcamento em jogo: cada recomendacao deve ser lucrativa
- Use os nomes reais das campanhas fornecidas no contexto
- Responda APENAS o JSON — nenhum texto antes ou depois
`;

const generateInsights = async (userId, days = 7) => {
  console.log('[AI] Gerando insights para usuario ' + userId + ', periodo ' + days + ' dias');

  const userResult = await query(
    'SELECT name, email, cpa_target, roas_target, roas_breakeven FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('Usuario nao encontrado');
  const user = userResult.rows[0];

  const [overview, campaigns] = await Promise.all([
    calculateOverview(userId, days),
    calculateByCampaign(userId, days),
  ]);

  // Historico diario (30 dias para analise de tendencia)
  let dailyHistory = [];
  try { dailyHistory = await calculateDailyHistory(userId, null, 30); } catch (_) {}

  // Alertas recentes (48h)
  const decisionsResult = await query(
    `SELECT type, severity, title, description, recommendation
     FROM decisions
     WHERE user_id = $1
       AND triggered_at >= NOW() - INTERVAL '48 hours'
     ORDER BY severity DESC
     LIMIT 15`,
    [userId]
  );

  // Vendas por produto com taxa de reembolso
  let salesRows = [];
  try {
    const salesResult = await query(
      `SELECT
         COALESCE(product_name, 'Produto nao identificado') AS product_name,
         COUNT(*) FILTER (WHERE status = 'approved')        AS total_vendas,
         SUM(net_revenue) FILTER (WHERE status = 'approved') AS receita_liquida,
         AVG(net_revenue) FILTER (WHERE status = 'approved') AS ticket_medio,
         COUNT(*) FILTER (WHERE status = 'refunded')         AS reembolsos,
         ROUND(
           COUNT(*) FILTER (WHERE status = 'refunded')::numeric
           / NULLIF(COUNT(*) FILTER (WHERE status = 'approved'), 0) * 100, 1
         ) AS taxa_reembolso
       FROM sales
       WHERE user_id = $1
         AND sale_date >= CURRENT_DATE - INTERVAL '${days - 1} days'
       GROUP BY product_name
       ORDER BY receita_liquida DESC NULLS LAST
       LIMIT 8`,
      [userId]
    );
    salesRows = salesResult.rows;
  } catch (_) {}

  // Calcular tendencia semanal a partir do historico
  let tendenciaStr = '';
  if (dailyHistory.length >= 14) {
    const semAtual    = dailyHistory.slice(-7);
    const semAnterior = dailyHistory.slice(-14, -7);
    const spA  = semAtual.reduce((s, d) => s + (parseFloat(d.spend)   || 0), 0);
    const spP  = semAnterior.reduce((s, d) => s + (parseFloat(d.spend) || 0), 0);
    const rvA  = semAtual.reduce((s, d) => s + (parseFloat(d.revenue)   || 0), 0);
    const rvP  = semAnterior.reduce((s, d) => s + (parseFloat(d.revenue) || 0), 0);
    const rAtual = spA > 0 ? (rvA / spA).toFixed(2) : '0';
    const rAnt   = spP > 0 ? (rvP / spP).toFixed(2) : '0';
    const dSpend = spP > 0 ? ((spA - spP) / spP * 100).toFixed(0) : '0';
    const dRev   = rvP > 0 ? ((rvA - rvP) / rvP * 100).toFixed(0) : '0';
    tendenciaStr = `
COMPARATIVO SEMANA ATUAL vs SEMANA ANTERIOR:
- Gasto:   R$${spA.toFixed(2)} vs R$${spP.toFixed(2)} (${dSpend > 0 ? '+' : ''}${dSpend}%)
- Receita: R$${rvA.toFixed(2)} vs R$${rvP.toFixed(2)} (${dRev > 0 ? '+' : ''}${dRev}%)
- ROAS:    ${rAtual}x vs ${rAnt}x`;
  }

  // Historico diario ultimos 7 dias
  const hist7 = dailyHistory.slice(-7);
  const histStr = hist7.length > 0
    ? hist7.map(d => {
        const dt  = new Date(d.date);
        const dia = dt.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
        return '  ' + dia + ': Gasto R$' + (parseFloat(d.spend)||0).toFixed(2) +
          ' | Receita R$' + (parseFloat(d.revenue)||0).toFixed(2) +
          ' | ROAS ' + (parseFloat(d.roas)||0).toFixed(2) + 'x' +
          ' | Conv: ' + (parseInt(d.conversions)||0);
      }).join('\n')
    : '  Sem historico disponivel';

  const userPrompt = `Voce e a equipe IPPMIFY AI. Analise os dados completos de performance de "${user.name}" e gere um diagnostico profissional de nivel consultor senior.

CONFIGURACOES DO USUARIO:
- CPA Target: R$${parseFloat(user.cpa_target || 50).toFixed(2)}
- ROAS Target: ${parseFloat(user.roas_target || 2).toFixed(2)}x
- ROAS Breakeven: ${parseFloat(user.roas_breakeven || 1).toFixed(2)}x

OVERVIEW GERAL — ULTIMOS ${days} DIAS:
- Gasto total:        R$${parseFloat(overview.spend || 0).toFixed(2)}
- Receita total:      R$${parseFloat(overview.revenue || 0).toFixed(2)}
- Lucro liquido:      R$${parseFloat(overview.profit || 0).toFixed(2)}
- ROAS geral:         ${parseFloat(overview.roas || 0).toFixed(2)}x (target: ${parseFloat(user.roas_target || 2).toFixed(2)}x)
- CPA medio:          R$${parseFloat(overview.cpa || 0).toFixed(2)} (target: R$${parseFloat(user.cpa_target || 50).toFixed(2)})
- Conversoes:         ${overview.conversions || 0}
- Impressoes:         ${parseInt(overview.impressions || 0).toLocaleString('pt-BR')}
- Cliques:            ${parseInt(overview.clicks || 0).toLocaleString('pt-BR')}
- CTR medio:          ${parseFloat(overview.ctr || 0).toFixed(2)}%
- CPM medio:          R$${parseFloat(overview.cpm || 0).toFixed(2)}
- CPC medio:          R$${parseFloat(overview.cpc || 0).toFixed(2)}
- ROI:                ${parseFloat(overview.roi_pct || 0).toFixed(1)}%
- Reembolsos:         R$${parseFloat(overview.total_refunds || 0).toFixed(2)} (${parseFloat(overview.refund_rate || 0).toFixed(1)}% da receita)
- Campanhas ativas:   ${campaigns.filter(c => c.status === 'ACTIVE').length} de ${campaigns.length} total
- Gasto medio/dia:    R$${(parseFloat(overview.spend || 0) / Math.max(days, 1)).toFixed(2)}
${tendenciaStr}

HISTORICO DIARIO — ULTIMOS 7 DIAS:
${histStr}

DETALHAMENTO POR CAMPANHA:
${campaigns.map(c => {
  const util = c.daily_budget > 0 ? ((c.spend / c.daily_budget) * 100).toFixed(0) + '%' : 'N/A';
  return '- "' + c.campaign_name + '"\n' +
    '  Status: ' + c.status + ' | Gasto: R$' + c.spend + ' | Receita: R$' + c.revenue + ' | Lucro: R$' + c.profit + '\n' +
    '  ROAS: ' + c.roas + 'x | CPA: R$' + c.cpa + ' | CTR: ' + c.ctr + '% | CPM: R$' + c.cpm + '\n' +
    '  Conversoes: ' + c.conversions + ' | Budget diario: R$' + c.daily_budget + ' | Utilizacao budget: ' + util + '\n' +
    '  Fonte conversoes: ' + c.conversion_source;
}).join('\n\n')}

ALERTAS DO MOTOR DE DECISAO (ultimas 48h):
${decisionsResult.rows.length > 0
  ? decisionsResult.rows.map(d => '- [SEVERIDADE ' + d.severity + '/10] ' + d.title + ': ' + d.recommendation).join('\n')
  : '- Nenhum alerta critico nas ultimas 48h'}

VENDAS POR PRODUTO:
${salesRows.length > 0
  ? salesRows.map(s =>
      '- ' + s.product_name +
      ': ' + s.total_vendas + ' vendas' +
      ' | Ticket medio: R$' + parseFloat(s.ticket_medio || 0).toFixed(2) +
      ' | Receita: R$' + parseFloat(s.receita_liquida || 0).toFixed(2) +
      ' | Reembolsos: ' + s.reembolsos + ' (' + (s.taxa_reembolso || 0) + '%)'
    ).join('\n')
  : '- Dados de vendas por produto indisponiveis (integrar checkout para ver detalhes)'}

Gere a analise completa em JSON conforme o schema especificado. Use os nomes reais das campanhas. Seja ultra especifico com os dados reais fornecidos.`;

  try {
    const completion = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ],
      temperature:     0.2,
      response_format: { type: 'json_object' },
      max_tokens:      4500,
    });

    const rawResponse = completion.choices[0].message.content;
    const insights    = JSON.parse(rawResponse);

    try {
      await query(
        `INSERT INTO ai_insights
           (user_id, type, period_start, period_end, prompt_used,
            raw_response, summary, recommendations, model_used, tokens_used)
         VALUES ($1, 'daily_report', NOW() - INTERVAL '1 day' * $2, NOW(),
                 $3, $4, $5, $6, 'gpt-4o', $7)`,
        [
          userId, days,
          userPrompt.substring(0, 5000),
          rawResponse,
          insights.resumo_executivo || '',
          JSON.stringify(insights.analise_campanhas || insights.otimizacoes || []),
          completion.usage.total_tokens,
        ]
      );
    } catch (dbErr) {
      console.warn('[AI] Nao foi possivel salvar no banco:', dbErr.message);
    }

    console.log('[AI] Insights gerados — score ' + insights.score + ' — ' + completion.usage.total_tokens + ' tokens');
    return insights;

  } catch (error) {
    console.error('[AI] Erro ao chamar OpenAI:', error.message);

    const hasData    = parseFloat(overview.spend || 0) > 0;
    const roas       = parseFloat(overview.roas || 0);
    const cpa        = parseFloat(overview.cpa || 0);
    const cpaTarget  = parseFloat(user.cpa_target || 50);
    const roasTarget = parseFloat(user.roas_target || 2);
    const profit     = parseFloat(overview.profit || 0);

    let score = 50;
    if (!hasData) score = 0;
    else if (roas < 1) score = 15;
    else if (roas < roasTarget) score = 40;
    else if (roas >= roasTarget * 1.3) score = 80;

    const scoreLabel = score >= 90 ? 'Excelente' : score >= 75 ? 'Bom' : score >= 60 ? 'Regular' : score >= 40 ? 'Atencao' : 'Critico';

    return {
      score, score_label: scoreLabel,
      perfil_negocio: { tipo_identificado: 'nao_identificado', porte: 'pequeno', maturidade: 'testando', saude_geral: 'Analise temporariamente indisponivel' },
      resumo_executivo: hasData
        ? 'ROAS geral de ' + roas.toFixed(2) + 'x com gasto de R$' + parseFloat(overview.spend).toFixed(2) + '. Lucro: R$' + profit.toFixed(2) + '. IA temporariamente indisponivel — ' + decisionsResult.rows.length + ' alertas detectados pelo motor de regras.'
        : 'Nenhuma campanha com dados encontrada. Conecte sua conta de anuncios para receber analises.',
      alerts: decisionsResult.rows.map(d => ({
        nivel: d.severity >= 9 ? 'critico' : d.severity >= 7 ? 'alerta' : 'info',
        mensagem: d.title,
      })),
      acao_imediata: {
        urgencia: decisionsResult.rows[0]?.severity >= 9 ? 'agora' : 'hoje',
        ordem:    decisionsResult.rows[0]?.title || 'Verifique suas campanhas',
        detalhes: decisionsResult.rows[0]?.recommendation || 'Acesse o painel de Decisoes para ver os alertas detalhados.',
        passos: [],
      },
      diagnostico: {
        gargalo:    roas < 1 ? 'OFERTA' : cpa > cpaTarget * 1.5 ? 'PUBLICO' : 'ESCALANDO BEM',
        causas_raiz: [],
        explicacao: hasData ? 'ROAS ' + roas.toFixed(2) + 'x vs target ' + roasTarget + 'x. CPA R$' + cpa.toFixed(2) + ' vs target R$' + cpaTarget.toFixed(2) + '.' : 'Dados insuficientes.',
      },
      analise_campanhas: campaigns.map(c => ({
        nome: c.campaign_name,
        veredicto: c.roas < 1 ? 'PAUSAR' : c.roas > roasTarget * 1.3 ? 'ESCALAR' : 'MANTER',
        motivo: 'ROAS ' + c.roas.toFixed(2) + 'x, CPA R$' + c.cpa.toFixed(2),
        acao: c.roas < 1 ? 'Pause e revise criativos' : c.roas > roasTarget * 1.3 ? 'Aumente budget 20%' : 'Monitore por 48h'
      })),
      impacto_lucro: {
        nivel: profit < 0 ? 'alto' : 'medio',
        valor_estimado: 'R$' + Math.abs(profit).toFixed(2) + ' no periodo',
        explicacao: profit < 0 ? 'Campanhas operando no prejuizo.' : 'Lucro positivo no periodo.',
        projecao_mensal: 'R$' + (profit * (30 / Math.max(days, 1))).toFixed(2),
      },
      plano_7dias: [
        { periodo: 'Dia 1-2', foco: 'Auditoria e ajustes emergenciais', acoes: ['Revise campanhas com CPA acima de 2x o target', 'Verifique pixel e CAPI'] },
        { periodo: 'Dia 3-5', foco: 'Novos criativos', acoes: ['Crie 3-5 criativos com angulos distintos', 'Lance testes com budget minimo'] },
        { periodo: 'Dia 6-7', foco: 'Analise e decisao', acoes: ['Compare resultados dos testes', 'Escale o vencedor, pause os perdedores'] },
      ],
      estrategia_criativa: {
        estado_atual: 'Analise de criativo requer dados de CTR e CPM — indisponivel no modo offline',
        angulos_testar: ['Prova social (depoimentos reais)', 'Transformacao (antes e depois)', 'Problema-solucao (dor + allivio)'],
        formatos_priorizar: ['Reels — melhor custo por impressao e maior alcance organico'],
        hooks_prontos: ['Voce ainda paga caro por lead?', 'Sabe por que sua campanha nao converte?', 'O erro que custa R$X por dia nas suas campanhas'],
      },
      analise_financeira: {
        margem_real: 'ROAS ' + roas.toFixed(2) + 'x vs breakeven ' + parseFloat(user.roas_breakeven || 1).toFixed(2) + 'x',
        saude: profit > 0 ? 'positivo' : profit < 0 ? 'negativo' : 'neutro',
        projecao_mes: 'R$' + (profit * (30 / Math.max(days, 1))).toFixed(2),
        meta_para_escalar: 'ROAS acima de ' + roasTarget + 'x por 7 dias consecutivos com CPA abaixo de R$' + cpaTarget.toFixed(2),
      },
      riscos: profit < 0 ? [{ risco: 'Campanhas operando no prejuizo', probabilidade: 'alta', impacto: 'R$' + Math.abs(profit).toFixed(2) + ' de prejuizo no periodo', mitigacao: 'Pause campanhas com ROAS abaixo do breakeven imediatamente' }] : [],
      oportunidades: roas > roasTarget ? [{ oportunidade: 'ROAS acima do target — potencial de escala', potencial: '+20-40% de receita', como_capturar: 'Aumente budget 20% a cada 48h mantendo ROAS positivo' }] : [],
      estrategia_escala: {
        pronto_para_escalar: roas > roasTarget * 1.2,
        motivo: 'ROAS ' + roas.toFixed(2) + 'x ' + (roas > roasTarget * 1.2 ? 'consistentemente acima do target' : 'ainda abaixo do target necessario para escala segura'),
        como: 'Escala vertical (budget) apenas apos 7 dias de ROAS positivo consecutivo',
        cronograma: 'Aguarde estabilizacao por 7 dias, depois aumente 20% a cada 48h'
      },
      teste_sugerido: {
        hipotese: 'Novos criativos com hooks diferentes nos primeiros 3 segundos vao melhorar CTR e reduzir CPA.',
        execucao: 'Crie 3-5 videos com angulos distintos. Teste por 7 dias com o mesmo budget. Compare CTR e CPA.',
        metricas_sucesso: 'CTR acima de 2% e CPA abaixo de R$' + cpaTarget.toFixed(2) + ' por 3 dias consecutivos',
      },
      otimizacoes: campaigns.filter(c => c.cpa > cpaTarget).slice(0, 3).map(c => ({
        area: 'CPA', impacto: 'medio',
        acao: 'Revise criativos da campanha "' + c.campaign_name + '". Pause se CPA > 2x target.',
      })),
      copies_sugeridas: [
        { tipo: 'Hook', texto: 'Voce ainda paga caro por cada lead? Veja como reduzir seu CPA em 40% sem aumentar o budget.', contexto: 'Primeiros 3 segundos do video' },
        { tipo: 'CTA', texto: 'Clique e descubra o metodo — resultado em 7 dias ou seu dinheiro de volta.', contexto: 'Final do video ou legenda do anuncio' },
      ],
      campanhas_pausar:  campaigns.filter(c => c.roas < 1 || c.cpa > cpaTarget * 2).map(c => c.campaign_name),
      campanhas_escalar: campaigns.filter(c => c.roas > roasTarget * 1.3).map(c => c.campaign_name),
      previsao: {
        proximo_mes_atual: hasData ? 'Mantendo o ritmo atual: lucro estimado de R$' + (profit * 4).toFixed(2) + ' no proximo mes.' : 'Conecte campanhas para projecoes.',
        cenario_otimizado: 'Com as otimizacoes aplicadas: potencial de 2-3x o lucro atual em 60 dias.',
        diferenca_potencial: 'R$' + (Math.abs(profit) * 2).toFixed(2) + ' de diferenca potencial',
      },
    };
  }
};

const getLastInsights = async (userId, limit = 5) => {
  try {
    const result = await query(
      `SELECT id, type, summary, recommendations, raw_response, created_at, model_used
       FROM ai_insights
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(row => {
      let parsed = null;
      if (row.raw_response) {
        try {
          parsed = typeof row.raw_response === 'string'
            ? JSON.parse(row.raw_response)
            : row.raw_response;
        } catch (_) {}
      }
      return {
        ...row,
        parsed,
        recommendations: typeof row.recommendations === 'string'
          ? JSON.parse(row.recommendations)
          : row.recommendations,
      };
    });
  } catch (_) {
    return [];
  }
};

module.exports = { generateInsights, getLastInsights };
