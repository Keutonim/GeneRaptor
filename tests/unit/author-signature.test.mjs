/**
 * B2 (2026-08-25): buildAuthorSignature — два формата подписи (контракт №6).
 *
 *   со specialist.pageUrl:
 *     '\n\n---\n\n**Автор статьи:** [ФИО, должность](pageUrl)\n'
 *   без pageUrl — прежний формат:
 *     '\n\n---\n\n**Автор статьи:** ФИО, должность\n'
 *
 * Инварианты: И2 — подпись строит КОД (не автор); pageUrl берётся только из
 * карточки специалиста (белый список БД), свободного URL-ввода нет.
 *
 * Юнит без БД: тяжёлые импорты воркера (redis-очереди, prisma) замоканы;
 * buildAuthorSignature экспортирована из воркера именно для этого теста.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUniqueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    specialist: { findUnique: findUniqueMock },
  },
}));
vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
}));
vi.mock('../../server/websocket.mjs', () => ({
  broadcastProgress: vi.fn(),
  createWebSocketServer: vi.fn(),
}));

import { buildAuthorSignature } from '../../server/workers/article-generation.mjs';

describe('B2 — buildAuthorSignature: формат с pageUrl и без', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it('specialistId null → пустая строка (без подписи, никакого «null» в тексте)', async () => {
    expect(await buildAuthorSignature({ specialistId: null }, 'a1')).toBe('');
    expect(await buildAuthorSignature({}, 'a1')).toBe('');
  });

  it('без pageUrl — прежний формат: **Автор статьи:** ФИО, должность', async () => {
    const sig = await buildAuthorSignature({
      specialistId: 's1',
      specialist: { fullName: 'Иванова Анна Сергеевна', position: 'Врач-дерматолог', pageUrl: null },
    }, 'a1');
    expect(sig).toBe('\n\n---\n\n**Автор статьи:** Иванова Анна Сергеевна, Врач-дерматолог\n');
  });

  it('с pageUrl — markdown-ссылка: [ФИО, должность](pageUrl)', async () => {
    const sig = await buildAuthorSignature({
      specialistId: 's1',
      specialist: {
        fullName: 'Иванова Анна Сергеевна',
        position: 'Врач-дерматолог',
        pageUrl: 'https://acme.example/doctors/ivanova',
      },
    }, 'a1');
    expect(sig).toBe(
      '\n\n---\n\n**Автор статьи:** [Иванова Анна Сергеевна, Врач-дерматолог](https://acme.example/doctors/ivanova)\n'
    );
  });

  it('pageUrl из пробелов считается отсутствующим (без битой ссылки)', async () => {
    const sig = await buildAuthorSignature({
      specialistId: 's1',
      specialist: { fullName: 'Иванова Анна Сергеевна', position: 'Врач-дерматолог', pageUrl: '   ' },
    }, 'a1');
    expect(sig).toBe('\n\n---\n\n**Автор статьи:** Иванова Анна Сергеевна, Врач-дерматолог\n');
  });

  it('без должности — только ФИО (оба формата)', async () => {
    expect(await buildAuthorSignature({
      specialistId: 's1',
      specialist: { fullName: 'Петров Пётр Петрович' },
    }, 'a1')).toBe('\n\n---\n\n**Автор статьи:** Петров Пётр Петрович\n');
    expect(await buildAuthorSignature({
      specialistId: 's1',
      specialist: { fullName: 'Петров Пётр Петрович', pageUrl: 'https://acme.example/d' },
    }, 'a1')).toBe('\n\n---\n\n**Автор статьи:** [Петров Пётр Петрович](https://acme.example/d)\n');
  });

  it('fallback-путь (article без specialist): findUnique, select включает pageUrl (Правка v1.1 п.11)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      fullName: 'Сидорова Мария Ивановна',
      position: 'Врач-косметолог',
      pageUrl: 'https://acme.example/doctors/sidorova',
    });
    const sig = await buildAuthorSignature({ specialistId: 's2' }, 'a1');
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 's2' },
      select: { fullName: true, position: true, pageUrl: true },
    });
    expect(sig).toBe(
      '\n\n---\n\n**Автор статьи:** [Сидорова Мария Ивановна, Врач-косметолог](https://acme.example/doctors/sidorova)\n'
    );
  });

  it('fullName пуст → подпись не добавляется (warn-путь)', async () => {
    findUniqueMock.mockResolvedValueOnce({ fullName: '   ', position: 'Врач' });
    expect(await buildAuthorSignature({ specialistId: 's3' }, 'a1')).toBe('');
  });
});
