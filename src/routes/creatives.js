const express    = require('express');
const Anthropic   = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Cliente Anthropic compartilhado entre todas as rotas
const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ─── GERAR VARIAÇÕES DE CRIATIVO COM IA ───────────────────────────────────────
// POST /api/creatives/generate
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { text, image_base64, url, produto, nicho, publico, tom } = req.body;

    if (!text && !image_base64 && !url && !produto) {
      return res.status(400).json({ error: 'Forneça pelo menos um: produto, texto, imagem ou URL' });
    }

    if (!client) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor' });
    }

    // Contexto de precisão
    const nichoLabels = { infoproduto:'Infoproduto/Curso Online', ecommerce:'E-commerce/Produto Físico', saude_beleza:'Saúde e Beleza', servico:'Serviço/Consultoria', financas:'Finanças/Investimentos', educacao:'Educação', fitness:'Fitness/Esporte', outro:'Outro' };
    const tomLabels   = { urgente:'Urgente e Direto', inspirador:'Inspirador e Motivacional', descontraido:'Descontraído e Próximo', formal:'Profissional e Formal', empatico:'Empático e Acolhedor', agressivo:'Agressivo e Provocativo' };
    const contexto    = [
      produto ? `Produto/Serviço: ${produto}` : '',
      nicho   ? `Nicho: ${nichoLabels[nicho] || nicho}` : '',
      publico ? `Público-alvo: ${publico}` : '',
      tom     ? `Tom de voz: ${tomLabels[tom] || tom}` : '',
    ].filter(Boolean).join('\n');

    const systemPrompt = `Você é um especialista em copywriting de resposta direta e criativos de alta conversão para tráfego pago (Meta Ads, Google Ads, TikTok Ads).

${contexto ? `CONTEXTO DO CRIATIVO:\n${contexto}\n\nUse OBRIGATORIAMENTE essas informações para personalizar cada variação ao máximo. A copy deve ser extremamente específica para o produto, público e tom definidos acima.\n` : ''}
Sua missão: gerar 6 variações de criativo com máxima conversão, cada uma com um hook, ângulo e formato completamente diferentes.

Para cada variação, retorne um objeto JSON com exatamente estes campos:
{
  "hook_type": "curiosidade" | "dor" | "prova_social" | "urgencia" | "transformacao" | "identidade",
  "angle": "nome do ângulo psicológico (ex: Medo de perder, Desejo de pertencer, Autoridade, Escassez...)",
  "platform": "Meta Ads" | "TikTok Ads" | "Google Ads" | "Universal",
  "headline": "título chamativo com no máximo 45 caracteres",
  "primary_text": "texto principal do anúncio com emojis estratégicos, máx 400 caracteres, com quebras de linha",
  "cta": "texto do botão (ex: Quero Agora, Saiba Mais, Começar Grátis, Garantir Vaga, Ver Oferta)",
  "why_it_converts": "explicação de 1 linha sobre por que essa variação gera conversão"
}

Regras importantes:
- Cada variação DEVE ter um hook_type diferente (use os 6 tipos, um por variação)
- Use linguagem direta, persuasiva e focada no benefício e transformação
- Adapte o tom e formato para a plataforma indicada
- Inclua emojis estratégicos no primary_text
- O primary_text deve ter quebras de linha para facilitar a leitura
- Retorne SOMENTE um array JSON válido com 6 objetos. Sem markdown, sem texto adicional antes ou depois.`;

    // Montar conteúdo da mensagem
    const userContent = [];

    if (text) {
      userContent.push({
        type: 'text',
        text: `Copy/texto do criativo:\n\n${text}`
      });
    }

    if (url) {
      try {
        const ctrl    = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 8000);
        const pageRes = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IPPMIFY/1.0)' },
          signal: ctrl.signal
        });
        clearTimeout(timeout);
        const html     = await pageRes.text();
        const pageText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi,   '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 3000);
        userContent.push({
          type: 'text',
          text: `Conteúdo extraído da página (${url}):\n\n${pageText}`
        });
      } catch (urlErr) {
        console.log('[Creatives] Não foi possível acessar URL:', urlErr.message);
        userContent.push({ type: 'text', text: `URL do produto: ${url}` });
      }
    }

    if (image_base64) {
      // Extrair media_type e dados base64
      let mediaType = 'image/jpeg';
      let imageData = image_base64;

      if (image_base64.startsWith('data:')) {
        const match = image_base64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mediaType = match[1];
          imageData = match[2];
        }
      }

      userContent.push({
        type: 'image',
        source: {
          type:       'base64',
          media_type: mediaType,
          data:       imageData,
        }
      });
      userContent.push({
        type: 'text',
        text: 'Analise o criativo acima e gere variações de alta conversão baseadas nele.'
      });
    }

    if (userContent.length === 0) {
      return res.status(400).json({ error: 'Nenhum conteúdo fornecido' });
    }

    userContent.push({
      type: 'text',
      text: 'Gere as 6 variações agora. Retorne apenas o array JSON.'
    });

    const message = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 3000,
      system:     systemPrompt,
      messages: [
        { role: 'user', content: userContent }
      ]
    });

    const raw = message.content[0].text.trim();

    let variations;
    try {
      const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      variations = JSON.parse(jsonStr);
      if (!Array.isArray(variations)) throw new Error('Resposta não é array');
    } catch (parseErr) {
      console.error('[Creatives] Erro ao parsear:', raw.substring(0, 300));
      return res.status(500).json({ error: 'Erro ao processar resposta da IA. Tente novamente.' });
    }

    const tokensUsed = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);
    console.log(`[Creatives] ${variations.length} variações geradas (user: ${req.user.id}, tokens: ${tokensUsed})`);

    res.json({ variations, tokens_used: tokensUsed });

  } catch (error) {
    console.error('[Creatives] Erro:', error.message);
    res.status(500).json({ error: error.message || 'Erro ao gerar variações' });
  }
});

// ─── GERAR IMAGEM POR PROMPT (Pollinations.ai — gratuito, sem API key) ────────
// POST /api/creatives/generate-image
router.post('/generate-image', requireAuth, async (req, res) => {
  try {
    const { prompt, width = 1024, height = 1024 } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt é obrigatório' });
    }

    const seed      = Math.floor(Math.random() * 999999);
    const encoded   = encodeURIComponent(prompt.trim());
    const image_url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;

    console.log(`[Creatives] URL de imagem gerada (user: ${req.user.id})`);
    res.json({ image_url });

  } catch (error) {
    console.error('[Creatives] Erro gerar imagem:', error.message);
    res.status(500).json({ error: error.message || 'Erro ao gerar imagem' });
  }
});

// ─── VARIAÇÕES DE IMAGEM (Claude analisa + Pollinations gera) ─────────────────
// POST /api/creatives/generate-image-variations
router.post('/generate-image-variations', requireAuth, async (req, res) => {
  try {
    const { image_base64, context = '', style = 'photorealistic' } = req.body;

    if (!image_base64) {
      return res.status(400).json({ error: 'Imagem é obrigatória' });
    }
    if (!client) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
    }

    // Claude analisa o criativo e gera 3 prompts
    let mediaType = 'image/jpeg';
    let imageData = image_base64;
    if (image_base64.startsWith('data:')) {
      const match = image_base64.match(/^data:([^;]+);base64,(.+)$/);
      if (match) { mediaType = match[1]; imageData = match[2]; }
    }

    const analysisMsg = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1500,
      system: `Você é um especialista em criativos de tráfego pago de alta conversão.
Analise a imagem do criativo fornecida e gere 3 prompts em inglês para gerar variações com IA.
Cada prompt deve:
- Manter o conceito central do produto/serviço
- Ter um ângulo visual diferente (close-up, lifestyle, produto isolado, cena de uso, etc.)
- Ser no estilo: ${style}
${context ? `- Considerar o contexto: ${context}` : ''}
- Ser detalhado, descritivo e otimizado para geração de imagem de alta conversão
- Ter entre 50 e 150 palavras

Retorne APENAS um array JSON com 3 strings (os prompts em inglês). Sem texto adicional.`,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
          { type: 'text', text: 'Analise este criativo e gere 3 prompts para variações de alta conversão.' }
        ]
      }]
    });

    let prompts;
    try {
      const raw     = analysisMsg.content[0].text.trim();
      const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      prompts = JSON.parse(jsonStr);
      if (!Array.isArray(prompts)) throw new Error('Não é array');
    } catch (e) {
      return res.status(500).json({ error: 'Erro ao analisar criativo. Tente novamente.' });
    }

    // Gera URLs do Pollinations para cada prompt
    const images = prompts.slice(0, 3).map((p, i) => ({
      url:    `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1024&height=1024&seed=${i * 1000 + Math.floor(Math.random() * 999)}&model=flux&nologo=true`,
      prompt: p,
    }));

    console.log(`[Creatives] ${images.length} variações de imagem geradas (user: ${req.user.id})`);
    res.json({ images });

  } catch (error) {
    console.error('[Creatives] Erro variações imagem:', error.message);
    res.status(500).json({ error: error.message || 'Erro ao gerar variações de imagem' });
  }
});

module.exports = router;
