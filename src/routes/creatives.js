const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

let openai = null;
const getOpenAI = () => {
  if (!openai) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
};

// POST /api/creatives/generate
router.post('/generate', async (req, res) => {
  try {
    const {
      product_name, product_description, target_audience,
      objective = 'conversao', tone = 'direto', num_variations = 3,
      image_url, cpa_atual, roas_atual
    } = req.body;

    if (!product_name && !product_description)
      return res.status(400).json({ error: 'Informe product_name ou product_description' });

    const count = Math.min(parseInt(num_variations) || 3, 5);

    const systemPrompt = `Você é um especialista em copywriting para tráfego pago no Brasil, com foco em Meta Ads (Facebook/Instagram).
Você conhece todos os gatilhos mentais, frameworks de copy (AIDA, PAS, Before/After/Bridge) e as melhores práticas de 2026.
Responda APENAS em JSON puro, sem markdown.`;

    const userPrompt = `Crie ${count} variações de copy para anúncios Meta Ads com os seguintes dados:

Produto/Serviço: ${product_name || 'Não informado'}
Descrição: ${product_description || 'Não informado'}
Público-alvo: ${target_audience || 'Não definido'}
Objetivo: ${objective}
Tom: ${tone}
${cpa_atual ? `CPA atual: R$${cpa_atual}` : ''}
${roas_atual ? `ROAS atual: ${roas_atual}x` : ''}

Para cada variação, retorne:
{
  "variations": [
    {
      "id": 1,
      "framework": "AIDA | PAS | BAB | Hook-Story-CTA",
      "headline": "Título principal (máx 40 chars)",
      "primary_text": "Texto do anúncio (máx 125 chars para feed)",
      "description": "Descrição/subtítulo (máx 30 chars)",
      "cta": "Texto do botão: Saiba Mais | Comprar Agora | etc",
      "hooks": ["Hook variante 1", "Hook variante 2"],
      "target_insight": "Por que este copy vai funcionar com o público-alvo",
      "estimated_ctr": "alto | médio | baixo"
    }
  ],
  "tokens_used": 0
}`;

    const ai = getOpenAI();
    const completion = await ai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    });

    const result = JSON.parse(completion.choices[0].message.content);
    result.tokens_used = completion.usage.total_tokens;
    res.json(result);
  } catch (err) {
    console.error('[Creatives] Erro generate:', err.message);
    res.status(500).json({ error: 'Erro ao gerar criativos: ' + err.message });
  }
});

// POST /api/creatives/generate-image
router.post('/generate-image', async (req, res) => {
  try {
    const { prompt, width = 1024, height = 1024 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt e obrigatorio' });

    const validSizes = ['1024x1024', '1792x1024', '1024x1792'];
    const size = validSizes.includes(`${width}x${height}`) ? `${width}x${height}` : '1024x1024';

    const ai = getOpenAI();
    const response = await ai.images.generate({
      model:   'dall-e-3',
      prompt:  `Imagem profissional para anuncio de Meta Ads (Facebook/Instagram) no Brasil. ${prompt}. Estilo: limpo, moderno, sem texto na imagem.`,
      n:       1,
      size,
      quality: 'standard',
    });

    res.json({ image_url: response.data[0].url });
  } catch (err) {
    console.error('[Creatives] Erro generate-image:', err.message);
    res.status(500).json({ error: 'Erro ao gerar imagem: ' + err.message });
  }
});

// POST /api/creatives/generate-image-variations
router.post('/generate-image-variations', async (req, res) => {
  try {
    const { image_base64, image_url, num_variations = 3, product_name, objective } = req.body;
    if (!image_base64 && !image_url) return res.status(400).json({ error: 'image_base64 ou image_url e obrigatorio' });

    const count = Math.min(parseInt(num_variations) || 3, 5);
    const imageContent = image_base64
      ? { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
      : { type: 'image_url', image_url: { url: image_url } };

    const ai = getOpenAI();
    const completion = await ai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            imageContent,
            {
              type: 'text',
              text: `Analise este criativo de anuncio e sugira ${count} variações para testar em Meta Ads.
${product_name ? `Produto: ${product_name}` : ''}
${objective ? `Objetivo: ${objective}` : ''}

Retorne JSON puro:
{
  "analysis": "O que está funcionando e o que pode melhorar neste criativo",
  "images": [
    {
      "id": 1,
      "type": "variacao | contraste | formato_alternativo",
      "description": "Descrição detalhada do que mudar visualmente",
      "dalle_prompt": "Prompt DALL-E para gerar esta variação",
      "hypothesis": "Por que esta variação pode ter CTR maior",
      "element_to_change": "cor | pessoa | background | texto | composicao"
    }
  ]
}`
            }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
    });

    const result = JSON.parse(completion.choices[0].message.content);
    result.tokens_used = completion.usage.total_tokens;
    res.json(result);
  } catch (err) {
    console.error('[Creatives] Erro generate-image-variations:', err.message);
    res.status(500).json({ error: 'Erro ao analisar criativo: ' + err.message });
  }
});

module.exports = router;
