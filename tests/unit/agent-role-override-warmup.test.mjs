/**
 * Unit test: прогрев кэша правок промптов ДО выполнения ролей (TL P1-2).
 *
 * Проблема: кэш правок подтягивался fire-and-forget на старте воркера и
 * сервера. Задача могла начаться раньше, чем кэш прогрелся, — тогда правки
 * промптов молча не применились бы (владелец увидел бы «сохранилось, но не
 * работает»).
 *
 * Что проверяем: processArticleGeneration СНАЧАЛА дожидается
 * loadAgentRoleOverrides(), и только потом идёт в БД за статьёй.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Общий порядок событий: 'load' (прогрев кэша) → 'db' (загрузка статьи). */
const events = vi.hoisted(() => ({ order: [] }));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    agentRoleSetting: { findMany: async () => [] },
    article: {
      findUnique: async () => {
        events.order.push('db');
        return null;
      },
      update: async () => ({}),
    },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  redisClient: { ping: vi.fn(async () => 'PONG') },
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  autoGenerationQueue: { add: vi.fn(), removeRepeatable: vi.fn() },
  closeQueues: vi.fn(async () => {}),
}));

vi.mock('../../server/websocket.mjs', () => ({
  broadcastProgress: vi.fn(),
}));

vi.mock('../../server/lib/agent-role-overrides.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadAgentRoleOverrides: async () => {
      events.order.push('load');
      return actual.loadAgentRoleOverrides();
    },
  };
});

import { processArticleGeneration } from '../../server/workers/article-generation.mjs';

beforeEach(() => {
  events.order.length = 0;
});

describe('processArticleGeneration — прогрев кэша правок промптов (TL P1-2)', () => {
  it('сначала дожидается loadAgentRoleOverrides(), потом обращается к БД', async () => {
    const job = {
      id: 'job-warmup',
      data: { articleId: 'article-that-does-not-exist' },
      updateProgress: vi.fn(async () => {}),
    };

    // Статья не найдена → задача падает. Нам важно, ДО какого момента
    // прогрелся кэш, а не код ошибки.
    try {
      await processArticleGeneration(job);
    } catch {
      /* ожидаемо: статьи нет */
    }

    expect(events.order[0]).toBe('load');
    expect(events.order).toContain('db');
    expect(events.order.indexOf('load')).toBeLessThan(events.order.indexOf('db'));
  });
});
