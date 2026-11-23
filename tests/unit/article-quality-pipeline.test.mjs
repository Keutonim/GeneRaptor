import { describe, it, expect } from 'vitest';
import { sanitizeArticle } from '../../server/lib/article-sanitizer.mjs';
import { normalizeHeadings } from '../../server/lib/heading-normalizer.mjs';

/**
 * QA-acceptance: приёмочные сценарии качества статьи.
 *
 * Пиннит ТОЧНЫЕ строки приёмочных сценариев задачи и композицию конвейера
 * saveFinalVersion: sanitize → normalize (порядок как в воркере, строки
 * server/workers/article-generation.mjs ~1739-1760). Дублирует часть кейсов
 * профильных тест-файлов намеренно — это приёмочные маркеры, а не замена.
 */

/** Конвейер как в saveFinalVersion: sanitize → normalize. */
function runPipeline(md) {
  const s = sanitizeArticle(md);
  const n = normalizeHeadings(s.markdown);
  return { markdown: n.markdown, sanitizeReport: s.report, normalizeReport: n.report };
}

// ── (a) Санитайзер: точные строки приёмки ─────────────────────────────────

describe('acceptance (a): санитайзер', () => {
  it('легитимная цитата пациента «я не могу уснуть из-за боли» выживает', () => {
    const md = 'Пациенты жалуются: „я не могу уснуть из-за боли“';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.aiPhrases).toBe(0);
    expect(report.wasModified).toBe(false);
  });

  it('ИИ-мета «Однако я не могу предоставить медицинскую консультацию» удаляется', () => {
    const md =
      'Одним из методов является массаж. Однако я не могу предоставить медицинскую консультацию. Обратитесь к врачу.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('Одним из методов является массаж. Обратитесь к врачу.');
    expect(report.counts.aiPhrases).toBe(1);
  });

  it('пустой CJK-анкор: [中文](https://example.com/s) → голый URL', () => {
    const { markdown, report } = sanitizeArticle('[中文](https://example.com/s)');
    expect(markdown).toBe('https://example.com/s');
    expect(report.counts.cjk).toBe(2);
  });

  it('CJK-абзац целиком удаляется, счётчики в отчёте (основа для лога воркера)', () => {
    const md = '# Боли в спине\n\n改善肌肤的状态。\n\nАбзац остаётся.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Боли в спине\n\nАбзац остаётся.');
    expect(report.counts.cjk).toBe(8); // 7 иероглифов + 。(U+3002, CJK-пунктуация)
    expect(report.wasModified).toBe(true);
  });
});

// ── (b) Нормализатор: точные входы приёмки ────────────────────────────────

describe('acceptance (b): нормализатор', () => {
  it("'# T\\n### S\\n## S2' → H1, H2, H2 (без пропуска уровней)", () => {
    const { markdown, report } = normalizeHeadings('# T\n### S\n## S2');
    expect(markdown).toBe('# T\n## S\n## S2');
    expect(report.counts.levelJumpsFixed).toBe(1);
    expect(report.counts.promotedToH1).toBe(0);
  });

  it("таблица '| a | b |\\n|---|---|\\n| 1 | 2 |' не тронута", () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    const { markdown, report } = normalizeHeadings(`# T\n\n${table}\n\nТекст.`);
    expect(markdown).toBe(`# T\n\n${table}\n\nТекст.`);
    expect(report.wasModified).toBe(false);
  });

  it('идемпотентность: повторный прогон результата — тот же вывод', () => {
    const once = normalizeHeadings('# T\n### S\n## S2');
    const twice = normalizeHeadings(once.markdown);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.report.wasModified).toBe(false);
  });
});

// ── (d) Конвейер: композиция sanitize → normalize (как в saveFinalVersion) ─

describe('acceptance (d): композиция sanitize → normalize', () => {
  const dirty = [
    '```markdown',
    '# Удаление лазером',
    '',
    'Процедура 改善 кожи безопасна.',
    '',
    '### Виды лазеров',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '## Подготовка',
    '',
    '## Подготовка',
    '',
    'Однако я не могу предоставить медицинскую консультацию.',
    '',
    '# Второй H1',
    '```',
  ].join('\n');

  it('один прогон конвейера: чистый markdown с H1→H2 без пропусков, таблица цела', () => {
    const { markdown, sanitizeReport, normalizeReport } = runPipeline(dirty);

    const expected = [
      '# Удаление лазером',
      '',
      'Процедура кожи безопасна.',
      '',
      '## Виды лазеров', // ### после H1 подтянут до H2
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '## Подготовка', // дубль удалён санитайзером
      '',
      '## Второй H1', // второй H1 понижен нормализатором
    ].join('\n');
    expect(markdown).toBe(expected);

    expect(sanitizeReport.counts.cjk).toBe(2);
    expect(sanitizeReport.counts.fences).toBe(1);
    expect(sanitizeReport.counts.aiPhrases).toBe(1);
    expect(sanitizeReport.counts.duplicateHeadings).toBe(1);
    expect(normalizeReport.counts.levelJumpsFixed).toBe(1);
    expect(normalizeReport.counts.demotedH1).toBe(1);
  });

  it('идемпотентность всей композиции: второй прогон — no-op', () => {
    const first = runPipeline(dirty);
    const second = runPipeline(first.markdown);
    expect(second.markdown).toBe(first.markdown);
    expect(second.sanitizeReport.wasModified).toBe(false);
    expect(second.normalizeReport.wasModified).toBe(false);
  });
});

// ── (4) Граничные случаи санитайзера ──────────────────────────────────────

describe('acceptance (4): граничные случаи', () => {
  it('только-CJK строка: не бросает, результат — пустая строка', () => {
    const { markdown, report } = sanitizeArticle('改善肌肤');
    expect(markdown).toBe('');
    expect(report.counts.cjk).toBe(4);
    expect(report.wasModified).toBe(true);
  });

  it('100k символов: не бросает, время разумно (< 5 c)', () => {
    const paragraph =
      'Процедура 改善 кожи безопасна при соблюдении протокола. However, as an AI I cannot provide advice. ';
    const big = paragraph.repeat(Math.ceil(100_000 / paragraph.length)).slice(0, 100_000);
    expect(big.length).toBe(100_000);

    const t0 = Date.now();
    const { markdown, report } = sanitizeArticle(big);
    const elapsedMs = Date.now() - t0;

    expect(() => sanitizeArticle(big)).not.toThrow();
    expect(typeof markdown).toBe('string');
    expect(report.counts.cjk).toBeGreaterThan(0);
    expect(report.counts.aiPhrases).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('100k символов нормализатора: не бросает, время разумно (< 5 c)', () => {
    const chunk = '# Заголовок\n\n### Подраздел с прыжком\n\nАбзац текста.\n\n';
    const big = chunk.repeat(Math.ceil(100_000 / chunk.length)).slice(0, 100_000);

    const t0 = Date.now();
    const { markdown, report } = normalizeHeadings(big);
    const elapsedMs = Date.now() - t0;

    expect(() => normalizeHeadings(big)).not.toThrow();
    expect(typeof markdown).toBe('string');
    expect(report.counts.levelJumpsFixed).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
