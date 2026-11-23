// @vitest-environment jsdom
/**
 * M8 — скачивание обложки статьи файлом (docs/ui-design.md §10).
 *
 * Контракт под тестом: байты обложки забираются как blob, файл называется
 * cover-<articleId>.png, а 404/503 превращаются в машинный код и в
 * переводимое сообщение — без падения.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  coverFilename,
  coverDownloadMessage,
  downloadCover,
  fetchCoverBlob,
} from '../../src/lib/export/coverDownload';

const ARTICLE_ID = '44444444-4444-4444-4444-444444444444';

let createObjectURL;
let revokeObjectURL;
let clickSpy;

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:cover');
  revokeObjectURL = vi.fn();
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    value: createObjectURL,
    configurable: true,
  });
  Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
    value: revokeObjectURL,
    configurable: true,
  });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('coverFilename — имя файла обложки', () => {
  it('строит имя из идентификатора статьи', () => {
    expect(coverFilename(ARTICLE_ID)).toBe(`cover-${ARTICLE_ID}.png`);
  });
});

describe('fetchCoverBlob — байты обложки', () => {
  it('забирает blob по пути обложки', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new TextEncoder().encode('png-bytes'), { status: 200 }),
    );
    const blob = await fetchCoverBlob(ARTICLE_ID, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/articles/${ARTICLE_ID}/cover`);
    expect(await blob.text()).toBe('png-bytes');
  });

  it('404 отдаёт машинный код cover_not_found', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, error: 'Обложка не найдена', code: 'cover_not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(fetchCoverBlob(ARTICLE_ID, fetchImpl)).rejects.toMatchObject({
      code: 'cover_not_found',
    });
  });

  it('503 без тела отдаёт cover_not_configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(fetchCoverBlob(ARTICLE_ID, fetchImpl)).rejects.toMatchObject({
      code: 'cover_not_configured',
    });
  });
});

describe('downloadCover — файл обложки', () => {
  it('отдаёт браузеру ссылку с именем файла и отпускает object URL', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new TextEncoder().encode('png-bytes'), { status: 200 }),
    );
    vi.useFakeTimers();
    try {
      await downloadCover(ARTICLE_ID, { fetchImpl });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const anchor = clickSpy.mock.instances[0];
      expect(anchor.download).toBe(`cover-${ARTICLE_ID}.png`);
      expect(anchor.href).toContain('blob:cover');
      // object URL освобождается отложенно (иначе Firefox отменяет загрузку).
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:cover');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('coverDownloadMessage — сообщение об ошибке', () => {
  it('для отсутствующей обложки берёт ключ словаря', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const failure = await fetchCoverBlob(ARTICLE_ID, fetchImpl).catch((cause) => cause);
    const t = (key) => `t:${key}`;
    expect(coverDownloadMessage(failure, t)).toBe('t:cover.notFound');
  });

  it('для прочих ошибок берёт общий ключ словаря', () => {
    const t = (key) => `t:${key}`;
    expect(coverDownloadMessage(new Error('boom'), t)).toBe('t:cover.downloadError');
  });
});
