/**
 * Unit tests — render seams in server/agent-role-execution.mjs.
 *
 * Restores the permanent coverage QA flagged as finding F1:
 * the only suite importing buildRoleExecutionMessages did not exercise the
 * new context keys, and scratch suites covering exactly these
 * seams were deleted after development. These tests pin the seams so a
 * regression in the pure render paths is caught without the worker pipeline:
 *
 *   1. Truth-card structured price line (servicePriceMin/Max/Currency):
 *      structured columns WIN over priceText; absent/degenerate columns fall
 *      back to the legacy priceText line byte-identically (old rows unchanged).
 *   2. Catalog card structured price part («цена: …») for factchecker:
 *      appended only when the service carries price columns.
 *   3. Regulations block gating: rendered ONLY for knowledge-base-curator +
 *      factchecker; absent key / empty rows → block omitted cleanly.
 *   4. Ranked candidates block gating: rendered ONLY for topic-selector;
 *      absent key / empty array → block omitted (BP-5/manual articles inert).
 *   5. buildRoleExecutionPayload context wiring: the new context keys are
 *      forwarded from `context` into the rendered user message.
 *
 * Pure unit tests: buildRoleExecutionMessages / buildRoleExecutionPayload are
 * pure functions — no prisma, no fetch, no DB (mocked-prisma-free pattern).
 */
import { describe, expect, test } from 'vitest';
import {
  buildRoleExecutionMessages,
  buildRoleExecutionPayload,
} from '../../server/agent-role-execution.mjs';

/** User-message content rendered by the seam for the given inputs. */
function userPromptFor(args) {
  const messages = buildRoleExecutionMessages(args);
  expect(Array.isArray(messages)).toBe(true);
  const userMessage = messages.find((m) => m?.role === 'user');
  expect(userMessage).toBeTruthy();
  expect(typeof userMessage.content).toBe('string');
  return userMessage.content;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Truth-card structured price line (serviceCard «- Цена: …»)
// ─────────────────────────────────────────────────────────────────────────────

describe('render seams — truth-card structured price line (P2-1)', () => {
  test('structured columns win: 5 000–7 000 ₽ replaces the legacy priceText', () => {
    const prompt = userPromptFor({
      roleId: 'article-author',
      serviceName: 'Консультация',
      priceLabel: 'легаси-прайс',
      servicePriceMin: 5000,
      servicePriceMax: 7000,
      servicePriceCurrency: 'RUB',
    });
    expect(prompt).toContain('- Цена: 5 000–7 000 ₽');
    // The legacy label must NOT leak when structured columns are present.
    expect(prompt).not.toContain('легаси-прайс');
  });

  test.each([
    ['min only → «от 5 000 ₽»', { servicePriceMin: 5000, servicePriceCurrency: 'RUB' }, '- Цена: от 5 000 ₽'],
    ['max only → «до 7 000 ₽»', { servicePriceMax: 7000, servicePriceCurrency: 'RUB' }, '- Цена: до 7 000 ₽'],
    ['min == max → single number', { servicePriceMin: 5000, servicePriceMax: 5000, servicePriceCurrency: 'RUB' }, '- Цена: 5 000 ₽'],
    ['no currency → no suffix', { servicePriceMin: 5000, servicePriceMax: 7000 }, '- Цена: 5 000–7 000'],
    ['currency lowercase → uppercased ISO code', { servicePriceMin: 5000, servicePriceMax: 7000, servicePriceCurrency: 'usd' }, '- Цена: 5 000–7 000 USD'],
    ['big numbers → deterministic space grouping', { servicePriceMin: 195320, servicePriceMax: 195320, servicePriceCurrency: 'RUB' }, '- Цена: 195 320 ₽'],
  ])('%s', (_label, structured, expectedLine) => {
    const prompt = userPromptFor({
      roleId: 'article-author',
      serviceName: 'Консультация',
      priceLabel: 'легаси-прайс',
      ...structured,
    });
    expect(prompt).toContain(expectedLine);
    expect(prompt).not.toContain('легаси-прайс');
  });

  test('degenerate structured values (negative / NaN) → fallback to legacy priceText', () => {
    const prompt = userPromptFor({
      roleId: 'article-author',
      serviceName: 'Консультация',
      priceLabel: 'по запросу',
      servicePriceMin: -100,
      servicePriceMax: Number.NaN,
      servicePriceCurrency: 'RUB',
    });
    expect(prompt).toContain('- Цена: по запросу');
  });

  test('absent structured keys → legacy truth card byte-identical (old rows unchanged)', () => {
    // No servicePrice* keys at all: the card must render exactly as before
    // Full byte-level pin of the service card block.
    const prompt = userPromptFor({
      roleId: 'article-author',
      serviceName: 'Консультация',
      priceLabel: 'от 5 000 ₽',
    });
    const expectedCard = [
      '📋 Карточка услуги (источник правды):',
      '- Название: Консультация',
      '- Описание: Не указано',
      '- Показания: Не указано',
      '- Противопоказания: Не указано',
      '- Цена: от 5 000 ₽',
      '- URL: Не указано',
    ].join('\n');
    expect(prompt).toContain(expectedCard);
  });

  test('absent structured keys + empty priceLabel → «Не указано» fallback intact', () => {
    const prompt = userPromptFor({
      roleId: 'article-author',
      serviceName: 'Консультация',
    });
    expect(prompt).toContain('- Цена: Не указано');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Catalog card structured price part (factchecker canon block)
// ─────────────────────────────────────────────────────────────────────────────

describe('render seams — catalog card structured price part (P2-1)', () => {
  test('service with price columns → «цена: …» appended to the catalog card', () => {
    const prompt = userPromptFor({
      roleId: 'factchecker',
      catalogServices: [
        { name: 'Консультация', priceMin: 5000, priceMax: 7000, priceCurrency: 'RUB' },
      ],
    });
    expect(prompt).toContain('- Консультация | цена: 5 000–7 000 ₽');
  });

  test('service without price columns → catalog card byte-identical to old rows', () => {
    const prompt = userPromptFor({
      roleId: 'factchecker',
      catalogServices: [{ name: 'Консультация' }],
    });
    // Exact pinned catalog section for a row without the price columns:
    // nothing appended after the name — old crawl rows render unchanged.
    expect(prompt).toContain('🏥 Канонические услуги источника (1, показано 1):\n- Консультация');
    expect(prompt).not.toContain('цена: ');
  });

  test('mixed catalog: priced and unpriced services render independently', () => {
    const prompt = userPromptFor({
      roleId: 'factchecker',
      catalogServices: [
        { name: 'Консультация' },
        { name: 'УЗИ', priceMin: 1500, priceCurrency: 'RUB' },
      ],
    });
    expect(prompt).toContain('- Консультация\n');
    expect(prompt).toContain('- УЗИ | цена: от 1 500 ₽');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Regulations block gating (curator + factchecker ONLY)
// ─────────────────────────────────────────────────────────────────────────────

describe('render seams — regulations block gating (P2-1)', () => {
  const regulations = [
    { kind: 'protocol', title: 'Протокол ведения пациентов', url: 'https://example.com/p.pdf' },
    { kind: 'license', title: 'Лицензия №ЛО-77' },
  ];

  test('factchecker + regulations rows → canon block rendered', () => {
    const prompt = userPromptFor({
      roleId: 'factchecker',
      catalogRegulations: regulations,
    });
    expect(prompt).toContain('📋 РЕГЛАМЕНТЫ И ПРОТОКОЛЫ ИСТОЧНИКА');
    expect(prompt).toContain('- Протокол: «Протокол ведения пациентов» | url: https://example.com/p.pdf');
    expect(prompt).toContain('- Лицензия: «Лицензия №ЛО-77»');
  });

  test('knowledge-base-curator + regulations rows → canon block rendered', () => {
    const prompt = userPromptFor({
      roleId: 'knowledge-base-curator',
      catalogRegulations: regulations,
    });
    expect(prompt).toContain('📋 РЕГЛАМЕНТЫ И ПРОТОКОЛЫ ИСТОЧНИКА');
    expect(prompt).toContain('- Протокол: «Протокол ведения пациентов»');
  });

  test('article-author + SAME regulations rows → block omitted (gating)', () => {
    const prompt = userPromptFor({
      roleId: 'article-author',
      catalogRegulations: regulations,
    });
    expect(prompt).not.toContain('РЕГЛАМЕНТЫ И ПРОТОКОЛЫ');
  });

  test('seo-reviewer + SAME regulations rows → block omitted (gating)', () => {
    const prompt = userPromptFor({
      roleId: 'seo-reviewer',
      catalogRegulations: regulations,
    });
    expect(prompt).not.toContain('РЕГЛАМЕНТЫ И ПРОТОКОЛЫ');
  });

  test('factchecker + absent key → block omitted cleanly (QA invariant 10)', () => {
    const prompt = userPromptFor({ roleId: 'factchecker' });
    expect(prompt).not.toContain('РЕГЛАМЕНТЫ И ПРОТОКОЛЫ');
  });

  test('factchecker + empty array → block omitted cleanly', () => {
    const prompt = userPromptFor({ roleId: 'factchecker', catalogRegulations: [] });
    expect(prompt).not.toContain('РЕГЛАМЕНТЫ И ПРОТОКОЛЫ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Ranked candidates block gating (topic-selector ONLY)
// ─────────────────────────────────────────────────────────────────────────────

describe('render seams — ranked candidates block gating (P2-3)', () => {
  const ranked = [
    { topic: 'Имплантация зубов', frequency: 1500, score: 0.85 },
    { topic: 'Чистка зубов', frequency: null, score: 0.4 },
  ];

  test('topic-selector + candidates → numbered ranking block rendered', () => {
    const prompt = userPromptFor({
      roleId: 'topic-selector',
      rankedCandidates: [
        { topic: 'Имплантация зубов', frequency: 1500, score: 0.85 },
        { topic: 'Чистка зубов', frequency: undefined, score: 0.4 },
      ],
    });
    expect(prompt).toContain(
      '🏆 Ранжированные кандидаты (спрос + выгода компании; выбирай преимущественно из верхних позиций):'
    );
    // Ordinal IS the ranking; score is rendered with 3 decimals.
    expect(prompt).toContain('1. Имплантация зубов — спрос 1500 показов/мес, score 0.850');
    // Undefined/missing frequency degrades to «спрос неизвестен».
    expect(prompt).toContain('2. Чистка зубов — спрос неизвестен, score 0.400');
  });

  test('frequency: null renders as 0 (Number(null) === 0) — pinned edge', () => {
    // The scorer emits frequency: null for no-data candidates (nulls last);
    // Number(null) is 0, so the block shows «спрос 0 показов/мес». Pin this
    // so an accidental change of the null-semantics is caught.
    const prompt = userPromptFor({
      roleId: 'topic-selector',
      rankedCandidates: [{ topic: 'Чистка зубов', frequency: null, score: 0.4 }],
    });
    expect(prompt).toContain('1. Чистка зубов — спрос 0 показов/мес, score 0.400');
  });

  test('entries without a topic are filtered out of the block', () => {
    const prompt = userPromptFor({
      roleId: 'topic-selector',
      rankedCandidates: [
        { topic: 'Имплантация зубов', frequency: 1500, score: 0.85 },
        { frequency: 10, score: 0.1 }, // no topic → dropped
      ],
    });
    expect(prompt).toContain('1. Имплантация зубов — спрос 1500 показов/мес, score 0.850');
    // Exactly ONE numbered line in the block (the topic-less entry is dropped).
    const block = prompt.slice(prompt.indexOf('🏆 Ранжированные кандидаты'));
    expect(block.match(/^\d+\. /gm).length).toBe(1);
  });

  test('topic-selector + absent key → block omitted (manual articles / BP-5 inert)', () => {
    const prompt = userPromptFor({ roleId: 'topic-selector' });
    expect(prompt).not.toContain('Ранжированные кандидаты');
  });

  test('topic-selector + empty array → block omitted', () => {
    const prompt = userPromptFor({ roleId: 'topic-selector', rankedCandidates: [] });
    expect(prompt).not.toContain('Ранжированные кандидаты');
  });

  test('other roles + SAME candidates → block omitted (gating)', () => {
    for (const roleId of ['article-author', 'factchecker', 'knowledge-base-curator', 'seo-reviewer']) {
      const prompt = userPromptFor({ roleId, rankedCandidates: ranked });
      expect(prompt).not.toContain('Ранжированные кандидаты');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildRoleExecutionPayload wiring: context keys → rendered user message
// ─────────────────────────────────────────────────────────────────────────────

describe('render seams — buildRoleExecutionPayload context wiring (S2)', () => {
  test('context.servicePrice* → structured truth-card line in the payload', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'article-author',
      context: {
        serviceName: 'Консультация',
        priceLabel: 'легаси-прайс',
        servicePriceMin: 5000,
        servicePriceMax: 7000,
        servicePriceCurrency: 'RUB',
      },
    });
    const user = payload.messages.find((m) => m?.role === 'user').content;
    expect(user).toContain('- Цена: 5 000–7 000 ₽');
    expect(user).not.toContain('легаси-прайс');
  });

  test('context.rankedCandidates → ranked block in the topic-selector payload', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'topic-selector',
      context: {
        rankedCandidates: [{ topic: 'Имплантация зубов', frequency: 1500, score: 0.85 }],
      },
    });
    const user = payload.messages.find((m) => m?.role === 'user').content;
    expect(user).toContain('🏆 Ранжированные кандидаты');
    expect(user).toContain('1. Имплантация зубов — спрос 1500 показов/мес, score 0.850');
  });

  test('context.catalogRegulations → regulations block in the factchecker payload', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'factchecker',
      context: {
        catalogRegulations: [{ kind: 'protocol', title: 'Протокол ведения пациентов' }],
      },
    });
    const user = payload.messages.find((m) => m?.role === 'user').content;
    expect(user).toContain('📋 РЕГЛАМЕНТЫ И ПРОТОКОЛЫ ИСТОЧНИКА');
    expect(user).toContain('- Протокол: «Протокол ведения пациентов»');
  });

  test('context WITHOUT the new keys → all three blocks inert (byte-stable seam)', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'topic-selector',
      context: { serviceName: 'Консультация', priceLabel: 'по запросу' },
    });
    const user = payload.messages.find((m) => m?.role === 'user').content;
    expect(user).toContain('- Цена: по запросу');
    expect(user).not.toContain('Ранжированные кандидаты');
    expect(user).not.toContain('РЕГЛАМЕНТЫ И ПРОТОКОЛЫ');
    expect(user).not.toContain('цена: ');
  });
});
