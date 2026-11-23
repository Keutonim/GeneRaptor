/**
 * ИИ-консенсус между источниками: сравнивает факты, находит поддержанные ≥2 источниками.
 * Synthetic sources получают evidenceLevel 'high' (подтверждены независимыми источниками).
 */

/**
 * @param {Array<{provider, sourceUrl, title, snippet, extractedText, evidenceLevel, metadata}>} sources
 * @param {{ callRouterAI: Function, minSupport?: number }} opts
 * @returns {Promise<{ consensusFacts: Array, syntheticSources: Array }>}
 */
export async function buildConsensus(sources, opts = {}) {
  const { callRouterAI, minSupport = 2 } = opts;

  // 1. Защита: <2 источников → консенсус невозможен
  if (!Array.isArray(sources) || sources.length < 2) {
    return { consensusFacts: [], syntheticSources: [] };
  }

  // 2. Подготовить текст источников для промпта
  const sourcesText = sources
    .map(
      (s, i) =>
        `[Источник ${i + 1}] ${s.title || 'без названия'} (${s.provider}/${s.evidenceLevel})\nURL: ${s.sourceUrl || 'нет'}\nТекст: ${(s.extractedText || s.snippet || '').slice(0, 500)}\n`
    )
    .join('\n---\n\n');

  // 3. Промпт для callRouterAI — извлечь и сгруппировать факты
  const prompt = `Ты аналитик. Сравни утверждения из источников ниже. 
Для каждого ключевого факта о процедуре укажи, сколько источников его поддерживают.

Верни СТРОГО JSON (без markdown, без комментариев):
{
  "consensusFacts": [
    {
      "factRu": "краткая формулировка факта",
      "supportCount": 3,
      "supportingSourceUrls": ["url1", "url2", "url3"]
    }
  ]
}

Правила:
- Группируй похожие утверждения (например "сохраняется до 2 лет" из 3 источников = 1 факт с supportCount 3)
- factRu — конкретный проверяемый факт (не общие фразы)
- supportCount — реальное число источников, которые утверждают ЭТО
- supportingSourceUrls — URL источников из текста ниже
- Игнорируй маркетинговые заявления ("лучший", "инновационный") — только проверяемые факты

ИСТОЧНИКИ:
${sourcesText}`;

  // 4. Вызов RouterAI
  try {
    const result = await callRouterAI({
      model: process.env.CONSENSUS_MODEL || 'deepseek/deepseek-v3.2', // standard, быстрее
      messages: [
        {
          role: 'system',
          content: 'Ты строгий аналитик источников. Возвращаешь только валидный JSON.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 6500,
      temperature: 0.1, // детерминированность для фактов
    });

    // 5. Парсинг ответа
    const content = result?.data?.choices?.[0]?.message?.content || '';
    // Извлечь JSON (может быть в markdown-блоке)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[consensus] No JSON in response');
      return { consensusFacts: [], syntheticSources: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    let facts = Array.isArray(parsed.consensusFacts) ? parsed.consensusFacts : [];

    // 6. Фильтр по minSupport
    facts = facts.filter(
      (f) =>
        f.factRu &&
        Number(f.supportCount) >= minSupport &&
        Array.isArray(f.supportingSourceUrls) &&
        f.supportingSourceUrls.length > 0
    );

    // 7. Создать synthetic sources (evidenceLevel 'high')
    const syntheticSources = facts.map((f) => ({
      provider: 'consensus',
      sourceUrl: f.supportingSourceUrls[0], // первый поддерживающий URL
      title: `Консенсус ${f.supportCount} источников`,
      snippet: f.factRu,
      extractedText: f.factRu,
      evidenceLevel: 'high',
      publishedAt: null,
      metadata: {
        supportCount: Number(f.supportCount),
        supportingSourceUrls: f.supportingSourceUrls,
      },
    }));

    console.log(
      `[consensus] ${facts.length} consensus facts (support ≥${minSupport}) from ${sources.length} sources`
    );
    return { consensusFacts: facts, syntheticSources };
  } catch (e) {
    console.warn(`[consensus] failed (non-blocking): ${e.message}`);
    return { consensusFacts: [], syntheticSources: [] };
  }
}
