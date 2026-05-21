const express    = require('express');
const Anthropic   = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ─── GERAR VARIAÇÕES DE CRIATIVO COM IA ───────────────────────────────────────
// POST /api/creatives/generate
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { text, image_base64, url } = req.body;

    if (!text && !image_base64 && !url) {
      return res.status(400).json({ error: 'Forneça pelo menos um: texto, imagem ou URL' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `Você é um especialista em copywriting de resposta direta e criativos de alta conversão para tráfego pago (Meta Ads, Google Ads, TikTok Ads).

Sua missão: analisar o material fornecido e gerar 6 variações de criativo com máxima conversão, cada uma com um hook, ângulo e formato completamente diferentes.

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

module.exports = router;
