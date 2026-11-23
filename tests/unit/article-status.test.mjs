/**
 * Unit tests for server/lib/article-status.mjs (W1 «Автоматизация», 2026-10-27).
 *
 * Единый источник правды для статуса ручной публикации:
 *   - MANUAL_PUBLISH_STATUS — литерал статуса Article.status;
 *   - MANUAL_PUBLISH_ALLOWED_STATUSES — исходные статусы, из которых разрешена
 *     ручная отметка (D8: 'published' — только Rentry, в список НЕ входит);
 *   - PUBLICATION_STATUS_MANUAL — значение Publication.status для ручной записи;
 *   - isFinalStatus — хелпер терминальности для воркера/прогресса.
 * Prisma/queue замоканы (юнит, без БД) — модуль не должен их трогать.
 */
import { test, expect, describe, vi } from 'vitest';

vi.mock('../../server/db.mjs', () => ({ prisma: {} }));
vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn(), getJobs: vi.fn() },
}));

import {
  MANUAL_PUBLISH_STATUS,
  MANUAL_PUBLISH_ALLOWED_STATUSES,
  PUBLICATION_STATUS_MANUAL,
  isFinalStatus,
} from '../../server/lib/article-status.mjs';
import { articleProgress } from '../../server/lib/article-progress.mjs';

describe('MANUAL_PUBLISH_STATUS — единственный источник литерала', () => {
  test('литерал = published_manual', () => {
    expect(MANUAL_PUBLISH_STATUS).toBe('published_manual');
  });

  test('PUBLICATION_STATUS_MANUAL = published_manual (Publication.status ручной записи)', () => {
    expect(PUBLICATION_STATUS_MANUAL).toBe('published_manual');
  });
});

describe('MANUAL_PUBLISH_ALLOWED_STATUSES — матрица доступа', () => {
  test('список = [ready, needs_review, review] (как в плане волны)', () => {
    expect(MANUAL_PUBLISH_ALLOWED_STATUSES).toEqual(['ready', 'needs_review', 'review']);
  });

  test("D8: 'published' НЕ входит в разрешённые исходные статусы", () => {
    expect(MANUAL_PUBLISH_ALLOWED_STATUSES).not.toContain('published');
  });

  test('D8: сам published_manual не является исходным статусом (повторная отметка — отдельный путь)', () => {
    expect(MANUAL_PUBLISH_ALLOWED_STATUSES).not.toContain('published_manual');
  });

  test('черновики/процессные/ошибочные статусы не разрешены', () => {
    for (const s of ['draft', 'queued', 'stopped', 'failed', 'error', 'research', 'publication']) {
      expect(MANUAL_PUBLISH_ALLOWED_STATUSES).not.toContain(s);
    }
  });
});

describe('isFinalStatus — терминальность для воркера/прогресса', () => {
  test('published_manual — терминальный', () => {
    expect(isFinalStatus(MANUAL_PUBLISH_STATUS)).toBe(true);
  });

  test('существующие финальные статусы остаются терминальными', () => {
    for (const s of ['needs_review', 'ready', 'completed', 'published']) {
      expect(isFinalStatus(s)).toBe(true);
    }
  });

  test('не-финальные статусы → false', () => {
    for (const s of ['draft', 'queued', 'stopped', 'research', 'failed', 'error', '']) {
      expect(isFinalStatus(s)).toBe(false);
    }
    expect(isFinalStatus(null)).toBe(false);
    expect(isFinalStatus(undefined)).toBe(false);
  });
});

describe('согласованность с article-progress.mjs', () => {
  test('articleProgress(published_manual) = 100 (FINAL_STATUSES расширен)', () => {
    expect(articleProgress(MANUAL_PUBLISH_STATUS)).toBe(100);
  });
});
