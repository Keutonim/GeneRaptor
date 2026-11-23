/**
 * Unit tests for the topic-concatenation detector
 * (server/routes/articles.mjs — `looksLikeConcatenatedTopic` /
 * `buildTopicSuggestion` / `TOPIC_CONCATENATION_CODE`).
 *
 * Contract under test (the "U2" block of the article route):
 *   - the topic is normalised (lower-case, punctuation → space, collapsed
 *     spaces) and the detector looks for repeated CONTENT n-grams (a word or
 *     an adjacent word pair) that occur at least TOPIC_REPEAT_THRESHOLD (= 3)
 *     times;
 *   - a repeat ×2 is a legitimate topic ("… и после …") and must NOT be
 *     flagged; a repeat ×3 is a pasted keyword list and MUST be flagged;
 *   - stop words ("и", "в", "для", …) repeat legitimately and never trigger
 *     the detector;
 *   - the route answers 400 with `code: 'topic_looks_like_concatenation'` and
 *     offers the first phrase as a suggestion — no silent auto-normalisation.
 *
 * Why this suite exists: the shipped tree had NO direct coverage of the
 * detector (grep for `looksLikeConcatenatedTopic` in tests/ returned 0
 * matches — the only test lived in an engine copy that is not published with
 * this product). A detector that silently stopped working would let a pasted
 * keyword list reach generation unnoticed, so this suite pins the behaviour at
 * the behaviour level: real values in, real boolean out.
 *
 * Style: follows the shipped unit suites (postcheck-api.test.mjs) — Prisma
 * and the queue are mocked, the route module is imported for real.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: { findUnique: vi.fn(), update: vi.fn() },
    articleVersion: { findFirst: vi.fn() },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn(), getJobs: vi.fn() },
}));

import {
  looksLikeConcatenatedTopic,
  buildTopicSuggestion,
  TOPIC_CONCATENATION_CODE,
} from '../../server/routes/articles.mjs';

/** A pasted keyword list — the real-world shape the detector exists for. */
const CONCATENATED_TOPIC =
  'купить рекламу сайта купить рекламу сайта купить рекламу сайта цены';

/** A meaningful long topic — no content word repeats three times. */
const MEANINGFUL_LONG_TOPIC =
  'Руководство по подготовке статьи для лендинга: структура разделов, работа с заголовком, первые два абзаца и финальная проверка перед публикацией';

describe('looksLikeConcatenatedTopic — positive cases (concatenated topic)', () => {
  it('flags a topic whose content word is repeated three times', () => {
    expect(looksLikeConcatenatedTopic('лендинг лендинг лендинг')).toBe(true);
  });

  it('flags a pasted list of search phrases and suggests the first phrase', () => {
    expect(looksLikeConcatenatedTopic(CONCATENATED_TOPIC)).toBe(true);
    expect(buildTopicSuggestion(CONCATENATED_TOPIC)).toBe('купить рекламу сайта');
  });

  it('flags a repeated content word pair (bi-gram)', () => {
    expect(looksLikeConcatenatedTopic('текст статьи текст статьи текст статьи')).toBe(true);
  });

  it('flags a concatenation hidden behind extra spaces and punctuation', () => {
    const topic = 'лендинг   лендинг, лендинг';
    expect(looksLikeConcatenatedTopic(topic)).toBe(true);
  });
});

describe('looksLikeConcatenatedTopic — negative cases (ordinary topic)', () => {
  it('does not flag an ordinary two/three-word topic', () => {
    expect(looksLikeConcatenatedTopic('вёрстка лендинга')).toBe(false);
    expect(looksLikeConcatenatedTopic('написание текстов для блога')).toBe(false);
  });

  it('does not flag a topic where a content word repeats exactly twice', () => {
    expect(looksLikeConcatenatedTopic('аудит сайта и повторный аудит сайта')).toBe(false);
  });

  it('does not flag a topic that repeats stop words only', () => {
    expect(looksLikeConcatenatedTopic('тексты для блога и для рассылки')).toBe(false);
  });

  it('does not flag a long meaningful topic and returns an empty suggestion', () => {
    expect(MEANINGFUL_LONG_TOPIC.length).toBeGreaterThan(120);
    expect(looksLikeConcatenatedTopic(MEANINGFUL_LONG_TOPIC)).toBe(false);
    expect(buildTopicSuggestion(MEANINGFUL_LONG_TOPIC)).toBe('');
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
  ])('returns false without throwing for invalid input (%s)', (_name, value) => {
    expect(() => looksLikeConcatenatedTopic(value)).not.toThrow();
    expect(looksLikeConcatenatedTopic(value)).toBe(false);
  });
});

describe('topic concatenation — frozen error contract', () => {
  it('pins the error code the frontend branches on', () => {
    expect(TOPIC_CONCATENATION_CODE).toBe('topic_looks_like_concatenation');
  });
});
