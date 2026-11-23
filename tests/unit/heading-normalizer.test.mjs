import { describe, it, expect } from 'vitest';
import { normalizeHeadings } from '../../server/lib/heading-normalizer.mjs';

/**
 * T2: нормализатор заголовков финального markdown-артикля.
 *
 * Правила:
 *  (а) единственный H1 — первый заголовок остаётся H1 (или повышается до H1,
 *      если H1 нет), остальные H1 понижаются до H2;
 *  (б) запрет пропусков уровней: каждый следующий заголовок не глубже prev+1;
 *  (в) setext-заголовки (Title\n=== / Title\n---) → atx; ГВАРД: строка `---`
 *      сразу после абзаца в документе на atx-заголовках — почти всегда
 *      артефактный hr → вставить пустую строку перед `---`, НЕ создавать заголовок.
 *      `===`-underline — честно считать заголовком.
 *
 * Детерминированная чистая функция: одинаковый ввод → одинаковый вывод.
 */

describe('normalizeHeadings — защитные случаи', () => {
  it('пустой ввод: без изменений, wasModified=false', () => {
    const { markdown, report } = normalizeHeadings('');
    expect(markdown).toBe('');
    expect(report.wasModified).toBe(false);
  });

  it('null/undefined не валит функцию', () => {
    expect(normalizeHeadings(null).markdown).toBe('');
    expect(normalizeHeadings(undefined).markdown).toBe('');
  });

  it('текст без заголовков: no-op', () => {
    const md = 'Первый абзац.\n\nВторой абзац текста без заголовков.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe(md);
    expect(report.wasModified).toBe(false);
  });
});

describe('normalizeHeadings — правило единственного H1 (а)', () => {
  it('только H2: первый заголовок становится H1, остальные остаются H2', () => {
    const md = '## Первый раздел\n\nТекст.\n\n## Второй раздел\n\nЕщё текст.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe('# Первый раздел\n\nТекст.\n\n## Второй раздел\n\nЕщё текст.');
    expect(report.wasModified).toBe(true);
    expect(report.counts.promotedToH1).toBe(1);
  });

  it('два H1: первый остаётся H1, второй понижается до H2', () => {
    const md = '# Заголовок статьи\n\nТекст вводной.\n\n# Второй H1\n\nТекст.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe('# Заголовок статьи\n\nТекст вводной.\n\n## Второй H1\n\nТекст.');
    expect(report.counts.demotedH1).toBe(1);
  });
});

describe('normalizeHeadings — запрет пропусков уровней (б)', () => {
  it('H1 → H3: H3 подтягивается до H2', () => {
    const md = '# Статья\n\n### Сразу третий уровень\n\nТекст.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe('# Статья\n\n## Сразу третий уровень\n\nТекст.');
    expect(report.counts.levelJumpsFixed).toBe(1);
  });

  it('H4 → H2 после H1: H4 подтягивается до H2', () => {
    const md = '# Статья\n\n#### Глубокий подраздел\n\nТекст.';
    const { markdown } = normalizeHeadings(md);
    expect(markdown).toBe('# Статья\n\n## Глубокий подраздел\n\nТекст.');
  });

  it('цепочка пропусков корректируется последовательно (H2 → H5 → H3)', () => {
    const md = '## Раздел\n\n##### Прыжок\n\n### Нормальный';
    const { markdown } = normalizeHeadings(md);
    // Первый → H1; H5 не глубже prev+1=2 → H2; H3 не глубже prev+1=3 → остаётся H3.
    expect(markdown).toBe('# Раздел\n\n## Прыжок\n\n### Нормальный');
  });

  it('заголовок МЕНЬШЕ prev не изменяется (H2 → H1-не-первый уже обработан правилом а)', () => {
    const md = '# Статья\n\n## Подраздел\n\n### Пункт\n\n## Другой подраздел';
    const { markdown } = normalizeHeadings(md);
    expect(markdown).toBe('# Статья\n\n## Подраздел\n\n### Пункт\n\n## Другой подраздел');
  });
});

describe('normalizeHeadings — setext-заголовки (в)', () => {
  it('=== underline конвертируется в atx H1', () => {
    const md = 'Заголовок статьи\n===\n\nПервый абзац.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe('# Заголовок статьи\n\nПервый абзац.');
    expect(report.counts.setextConverted).toBe(1);
  });

  it('--- underline после абзаца в atx-документе = артефактный hr: пустая строка вставляется, заголовок НЕ создаётся', () => {
    const md = '# Статья\n\nКакой-то абзац текста.\n---\n\nСледующий абзац.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe('# Статья\n\nКакой-то абзац текста.\n\n---\n\nСледующий абзац.');
    expect(report.counts.hrDisambiguated).toBe(1);
    expect(report.counts.setextConverted).toBe(0);
  });

  it('легитимный hr после пустой строки не трогается (нет вставки)', () => {
    const md = '# Статья\n\nАбзац.\n\n---\n\nДругой абзац.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe(md);
    expect(report.counts.hrDisambiguated).toBe(0);
    expect(report.wasModified).toBe(false);
  });

  it('--- underline в setext-документе (без atx) честно конвертируется в ## Title', () => {
    const md = 'Вступительный заголовок\n---\n\nПервый абзац.\n\nВторой абзац.';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe('# Вступительный заголовок\n\nПервый абзац.\n\nВторой абзац.');
    expect(report.counts.setextConverted).toBe(1);
  });

  it('--- underline после МНОГОСТРОЧНОГО абзаца — артефактный hr даже в setext-документе', () => {
    const md = 'Первая строка абзаца,\nвторая строка абзаца.\n---\n\nДальше текст.';
    const { markdown, report } = normalizeHeadings(md);
    // Многострочный setext-контент не конвертируем — это артефакт: hr + вставка пустой строки.
    expect(markdown).toBe('Первая строка абзаца,\nвторая строка абзаца.\n\n---\n\nДальше текст.');
    expect(report.counts.setextConverted).toBe(0);
    expect(report.counts.hrDisambiguated).toBe(1);
  });
});

describe('normalizeHeadings — protection cases', () => {
  it('заголовки внутри code-fence не трогаются', () => {
    const md = '# Статья\n\n```markdown\n## Это код, не заголовок\n### И это тоже\n```\n\nАбзац.';
    const { markdown } = normalizeHeadings(md);
    // Строки фенса сохранены дословно, уровни внутри фенса не сдвинуты.
    const lines = markdown.split('\n');
    expect(lines).toEqual([
      '# Статья',
      '',
      '```markdown',
      '## Это код, не заголовок',
      '### И это тоже',
      '```',
      '',
      'Абзац.',
    ]);
  });

  it('таблица GFM не ломается: строка |---|---| — не hr/setext', () => {
    const md = '# Статья\n\n| Метод | Цена |\n|---|---|\n| Лазер | 3000 |';
    const { markdown, report } = normalizeHeadings(md);
    expect(markdown).toBe(md);
    expect(report.wasModified).toBe(false);
  });
});

describe('normalizeHeadings — качество', () => {
  it('идемпотентность: повторный прогон не меняет результат', () => {
    const md = [
      'Заголовок',
      '===',
      'Текст.',
      '---',
      '## Раздел',
      '### Пункт',
      '# Второй H1',
      '##### Глубокий прыжок',
    ].join('\n');
    const once = normalizeHeadings(md);
    const twice = normalizeHeadings(once.markdown);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.report.wasModified).toBe(false);
  });

  it('возвращает отчёт со всеми счётчиками', () => {
    const { report } = normalizeHeadings('## A');
    expect(report).toHaveProperty('wasModified');
    expect(report.counts).toEqual(
      expect.objectContaining({
        setextConverted: expect.any(Number),
        hrDisambiguated: expect.any(Number),
        promotedToH1: expect.any(Number),
        demotedH1: expect.any(Number),
        levelJumpsFixed: expect.any(Number),
      })
    );
  });
});
