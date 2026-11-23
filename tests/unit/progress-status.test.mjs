/**
 * H-06 (hardening): нормализация статусов прогресса на клиенте.
 *
 * Симптом: REST /api/articles/:id/progress и GET /api/articles/:id отдают СЫРОЙ
 * статус статьи из БД — 'needs_review' (с подчёркиванием), тогда как клиент
 * оперирует статусом 'needs-review' (с дефисом). Из-за этого финальный
 * статус не попадал в терминальные: UI не показывал статью и продолжал опрос
 * /progress каждые 3 секунды.
 *
 * Проверка поведения: нормализатор обязан переводить 'needs_review' в
 * 'needs-review', не трогать уже известные статусы и отдавать 'running' для
 * пустого значения (иначе UI считал бы неизвестный статус терминальным).
 */
import { describe, it, expect } from 'vitest';
import { normalizeProgressStatus } from '../../src/hooks/progressStatus';

describe('normalizeProgressStatus — единый словарь статусов прогресса', () => {
  it('сырой статус БД needs_review превращается в клиентский needs-review', () => {
    expect(normalizeProgressStatus('needs_review')).toBe('needs-review');
  });

  it('остальные статусы проходят без изменений', () => {
    for (const status of ['running', 'completed', 'error', 'stopped', 'ready', 'published', 'failed']) {
      expect(normalizeProgressStatus(status)).toBe(status);
    }
  });

  it('нужно: клиентский needs-review остаётся needs-review (идемпотентность)', () => {
    expect(normalizeProgressStatus('needs-review')).toBe('needs-review');
  });

  it('пустое значение трактуется как running (прогресс идёт, ошибки нет)', () => {
    expect(normalizeProgressStatus(undefined)).toBe('running');
    expect(normalizeProgressStatus(null)).toBe('running');
    expect(normalizeProgressStatus('')).toBe('running');
  });
});
