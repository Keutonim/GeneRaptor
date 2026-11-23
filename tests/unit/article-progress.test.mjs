/**
 * Unit tests for server/lib/article-progress.mjs (W2, 2026-08-14).
 *
 * articleProgress(status) — единый источник правды о проценте готовности
 * статьи для сериализатора списка (/api/articles) и /api/articles/:id/progress.
 *
 * Здесь же тест согласованности: для КАЖДОГО статуса
 *   serializeArticle(article).progress === percent из GET /:id/progress.
 * Prisma замокан (юнит, без БД): /progress-обработчик вызывается напрямую
 * через express-router stack (паттерн suggest-topic.test.mjs).
 */
import { test, expect, describe, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    article: { findUnique: vi.fn() },
  },
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn(), getJobs: vi.fn() },
}));

import {
  articleProgress,
  GENERATION_STATUSES,
  PROGRESS_TOTAL_STAGES,
} from '../../server/lib/article-progress.mjs';
import { articlesRouter, serializeArticle, ROLE_STATUS_MAP } from '../../server/routes/articles.mjs';
import { agentRoleData } from '../../server/agent-role-data.mjs';
import { prisma } from '../../server/db.mjs';

// Валидный UUIDv4 (валидация в роутах строгая — v4).
const ARTICLE_ID = '11111111-1111-4111-8111-111111111111';

/** Все реальные статусы статьи в системе (worker + routes). */
const ALL_STATUSES = [
  'draft',
  'queued',
  'stopped',
  ...GENERATION_STATUSES,
  'needs_review',
  'ready',
  'published',
  'failed',
];

describe('articleProgress — полная карта', () => {
  test('нулевые статусы: draft/pending/queued/stopped → 0', () => {
    for (const s of ['draft', 'pending', 'queued', 'stopped']) {
      expect(articleProgress(s)).toBe(0);
    }
  });

  test('генерируемые статусы → round(i/11*100) по порядку 11 ролей', () => {
    const expected = [
      'topic_generation', // 0
      'brief_preparation', // 9
      'knowledge_base', // 18
      'research', // 27
      'semantic_strategy', // 36
      'structure', // 45
      'article_writing', // 55
      'factcheck', // 64
      'seo_review', // 73
      'quality_control', // 82
      'humanize', // 91
    ];
    expect(GENERATION_STATUSES).toEqual(expected);
    expect(PROGRESS_TOTAL_STAGES).toBe(11);
    expected.forEach((status, i) => {
      expect(articleProgress(status)).toBe(Math.round((i / 11) * 100));
    });
  });

  test('финальные статусы: needs_review/ready/completed/published/published_manual → 100', () => {
    // QA-блокер: needs_review раньше давал 0 (findIndex → -1).
    // W1 «Автоматизация» (2026-10-27): published_manual — новый терминальный
    // статус ручной отметки, тоже обязан давать 100.
    for (const s of ['needs_review', 'ready', 'completed', 'published', 'published_manual']) {
      expect(articleProgress(s)).toBe(100);
    }
  });

  test('ошибочные статусы: error/failed → null', () => {
    expect(articleProgress('error')).toBeNull();
    expect(articleProgress('failed')).toBeNull();
  });

  test('неизвестный/пустой статус → null', () => {
    expect(articleProgress('processing')).toBeNull();
    expect(articleProgress('')).toBeNull();
    expect(articleProgress(null)).toBeNull();
    expect(articleProgress(undefined)).toBeNull();
  });
});

describe('инвариант: монотонность по ходу пайплайна', () => {
  test('процент не убывает: draft → 11 ролей → needs_review → ready', () => {
    const pipeline = ['draft', ...GENERATION_STATUSES, 'needs_review', 'ready'];
    const values = pipeline.map(articleProgress);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).not.toBeNull();
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(100);
  });
});

describe('согласованность карты с ролями проекта', () => {
  test('порядок GENERATION_STATUSES совпадает с agentRoleData × ROLE_STATUS_MAP', () => {
    expect(agentRoleData).toHaveLength(11);
    const fromRoles = agentRoleData.map((role) => ROLE_STATUS_MAP[role.id]);
    expect(fromRoles).toEqual(GENERATION_STATUSES);
  });

  /**
   * Tester (2026-08-14): worker-карта ROLE_STATUS_MAP не экспортируется
   * (модуль тяжёлый — db/queue/crawler), поэтому сверяем динамически:
   * извлекаем литерал из исходника воркера и сравниваем три карты —
   * routes, worker и GENERATION_STATUSES. Расхождение любой из трёх
   * копий сразу даёт красный тест (дубликат карты — известный долг,
   * этот тест держит его консистентным до дедупликации в фазе 2).
   */
  test('worker ROLE_STATUS_MAP (из исходника) ≡ routes-карта ≡ GENERATION_STATUSES', () => {
    const workerSource = readFileSync(
      new URL('../../server/workers/article-generation.mjs', import.meta.url),
      'utf8'
    );
    const match = workerSource.match(/const ROLE_STATUS_MAP = (\{[\s\S]*?\});/);
    expect(match, 'ROLE_STATUS_MAP literal найден в article-generation.mjs').toBeTruthy();
    const workerMap = new Function(`return (${match[1]})`)();

    expect(Object.keys(workerMap)).toHaveLength(11);
    // Три источника обязаны совпадать построчно.
    expect(workerMap).toEqual(ROLE_STATUS_MAP);
    expect(agentRoleData.map((role) => workerMap[role.id])).toEqual(GENERATION_STATUSES);
  });
});

/* ------------------------------------------------------------------ */
/*  Согласованность serializeArticle ↔ GET /:id/progress               */
/* ------------------------------------------------------------------ */

/** Достаёт handler GET /articles/:id/progress из express-router stack. */
function getProgressHandler() {
  const layer = articlesRouter.stack.find((l) => l.route?.path === '/articles/:id/progress');
  if (!layer) throw new Error('progress route not found');
  return layer.route.stack[0].handle;
}

/** Вызывает /progress-обработчик с фейковыми req/res (без HTTP-сервера). */
async function fetchProgressPayload(status) {
  prisma.article.findUnique.mockResolvedValue({ id: ARTICLE_ID, status, agentRuns: [] });
  const handler = getProgressHandler();
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  await handler({ params: { id: ARTICLE_ID } }, res);
  if (!res.payload?.success) throw new Error(`progress endpoint failed for ${status}`);
  return res.payload.data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('serializeArticle.progress === /progress percent (для каждого статуса)', () => {
  test.each(ALL_STATUSES)('статус %s: число одно и то же в списке и в /progress', async (status) => {
    const serialized = serializeArticle({ id: ARTICLE_ID, topic: 'Тема', status, agentRuns: [] });
    const progressPayload = await fetchProgressPayload(status);

    expect(serialized.progress).toBe(articleProgress(status));
    expect(progressPayload.percent).toBe(articleProgress(status));
    expect(serialized.progress).toBe(progressPayload.percent);
  });

  test('needs_review больше не даёт 0 в /progress (QA-блокер)', async () => {
    const progressPayload = await fetchProgressPayload('needs_review');
    expect(progressPayload.percent).toBe(100);
  });

  test('needs_review в /progress — терминальный кадр: currentStage=totalStages, percent=100 (H-06)', async () => {
    const progressPayload = await fetchProgressPayload('needs_review');
    // Прогон завершён (контент сохранён, нужна ручная проверка) — кадр должен
    // быть таким же терминальным, как WS-кадр воркера: 100 % и последний этап.
    expect(progressPayload.currentStage).toBe(progressPayload.totalStages);
    expect(progressPayload.totalStages).toBe(PROGRESS_TOTAL_STAGES);
    expect(progressPayload.percent).toBe(100);
    expect(progressPayload.stageName).toBe('Требуется проверка');
  });

  test('failed даёт null в обоих источниках (честное «неизвестно»)', async () => {
    const progressPayload = await fetchProgressPayload('failed');
    expect(progressPayload.percent).toBeNull();
    expect(serializeArticle({ id: ARTICLE_ID, topic: 'Т', status: 'failed', agentRuns: [] }).progress).toBeNull();
  });

  test('статусы в процессе: /progress сохраняет currentStage/stageName, percent из хелпера', async () => {
    const payload = await fetchProgressPayload('research'); // роль 4
    expect(payload.currentStage).toBe(4);
    expect(payload.stageName).toBe('Агент исследования');
    expect(payload.percent).toBe(articleProgress('research'));
  });
});
