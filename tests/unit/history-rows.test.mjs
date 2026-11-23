/**
 * M6 — pure helpers of the History tab (docs/ui-design.md §7).
 *
 * Контракт под тестом: статус статьи переводится в слово (не цветной «пилюля»),
 * объём печатается моноширинно с неразрывным пробелом, фильтр по теме — на
 * клиенте (по подстроке, без учёта регистра).
 */
import { describe, it, expect } from 'vitest';
import {
  statusWord,
  formatChars,
  formatDate,
  filterArticles,
} from '../../src/features/history/helpers/historyRows';

describe('statusWord — статус словами', () => {
  it('готово / ошибка / остановлен / в работе / требует проверки', () => {
    expect(statusWord('completed')).toBe('ready');
    expect(statusWord('ready')).toBe('ready');
    expect(statusWord('published')).toBe('ready');
    expect(statusWord('failed')).toBe('error');
    expect(statusWord('error')).toBe('error');
    expect(statusWord('stopped')).toBe('stopped');
    expect(statusWord('running')).toBe('running');
    expect(statusWord('queued')).toBe('running');
    expect(statusWord('needs-review')).toBe('review');
  });

  it('неизвестный статус не ломает разметку — считается «требует проверки»', () => {
    expect(statusWord('что-то новое')).toBe('review');
  });
});

describe('formatChars — объём моноширинно', () => {
  it('разделяет тысячи неразрывным пробелом', () => {
    expect(formatChars(65000)).toBe('65\u00a0000');
  });
});

describe('formatDate — дата моноширинно', () => {
  it('печатает дату в формате ДД.ММ.ГГГГ', () => {
    expect(formatDate('2026-11-13T10:20:30.000Z')).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it('битая дата не роняет строку', () => {
    expect(formatDate('не дата')).toBe('—');
  });
});

describe('filterArticles — фильтр по теме на клиенте', () => {
  const items = [
    { id: '1', topic: 'Имплантация зубов', status: 'completed', targetLength: 65000, language: 'ru', createdAt: '2026-11-01T10:00:00.000Z' },
    { id: '2', topic: 'Брекеты: как выбрать', status: 'completed', targetLength: 65000, language: 'ru', createdAt: '2026-11-02T10:00:00.000Z' },
  ];

  it('пустой запрос отдаёт все статьи', () => {
    expect(filterArticles(items, '')).toHaveLength(2);
  });

  it('ищет по подстроке без учёта регистра', () => {
    expect(filterArticles(items, 'имплант')).toHaveLength(1);
    expect(filterArticles(items, 'ИМПЛАНТ')[0].id).toBe('1');
  });

  it('несовпавший запрос даёт пустой список', () => {
    expect(filterArticles(items, 'аптека')).toEqual([]);
  });
});
