import { describe, it, expect } from 'vitest';
import { sanitizeArticle } from '../../server/lib/article-sanitizer.mjs';

/**
 * T3: санитайзер финального markdown-артикля.
 *
 * Только чистые удаления/замены, НИКАКИХ вставок HTML. Удаляет:
 *  (а) CJK-символы (Han/Hangul/Hiragana/Katakana) вне URL;
 *  (б) leaked-фенсы ```markdown / ```md и дублирующиеся ``` подряд;
 *  (в) ИИ-фразы (консервативный список ru+en) — по предложению;
 *  (г) подряд идущие одинаковые заголовки и абзацы (keep first).
 *
 * report: { counts: { cjk, fences, aiPhrases, duplicateHeadings,
 * duplicateParagraphs, duplicateTables }, wasModified }.
 */

describe('sanitizeArticle — no-op', () => {
  it('чистый текст: был и остался, wasModified=false, все счётчики 0', () => {
    const md = [
      '# Заголовок статьи',
      '',
      'Обычный абзац русского текста про УЗИ.',
      '',
      '## Раздел',
      '',
      '| Метод | Цена |',
      '|---|---|',
      '| Лазер | 3000 |',
      '',
      'Ссылка: [услуга](https://example.com/usluga) и всё.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.wasModified).toBe(false);
    expect(report.counts).toEqual({
      cjk: 0,
      fences: 0,
      aiPhrases: 0,
      duplicateHeadings: 0,
      duplicateParagraphs: 0,
      duplicateTables: 0,
      cutSections: 0,
      chunkArtifacts: 0,
    });
  });

  it('пустая строка / null — не падает', () => {
    expect(sanitizeArticle('').markdown).toBe('');
    expect(sanitizeArticle('').report.wasModified).toBe(false);
    expect(sanitizeArticle(null).markdown).toBe('');
  });
});

describe('sanitizeArticle — CJK (а)', () => {
  it('китайская вставка в абзаце удаляется, пробелы схлопываются', () => {
    const md = 'Процедура 改善肌肤 улучшает тонус кожи.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('Процедура улучшает тонус кожи.');
    expect(report.counts.cjk).toBe(4); // 改善肌肤 — 4 иероглифа
    expect(report.wasModified).toBe(true);
  });

  it('корейский и японский (Hangul/Katakana/Hiragana) тоже удаляются', () => {
    const { markdown, report } = sanitizeArticle('Метод 피부개선 и マッサージ применяются.');
    expect(markdown).toBe('Метод и применяются.');
    expect(report.counts.cjk).toBeGreaterThan(0);
  });

  it('CJK в URL markdown-ссылки: URL выживает нетронутым', () => {
    const md = 'См. [источник](https://zh.wikipedia.org/wiki/皮肤) для деталей.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md); // ни URL, ни текст не изменились
    expect(report.counts.cjk).toBe(0);
    expect(report.wasModified).toBe(false);
  });

  it('CJK в автоматическом (голом) URL: URL выживает', () => {
    const md = 'Детали: https://zh.wikipedia.org/wiki/皮膚护理 — читайте.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toContain('https://zh.wikipedia.org/wiki/皮膚护理');
    expect(report.counts.cjk).toBe(0);
  });

  it('CJK в тексте анкора ссылки удаляется, URL выживает', () => {
    const md = 'См. [обзор 改善 тут](https://example.com/page) далее.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('См. [обзор тут](https://example.com/page) далее.');
    expect(report.counts.cjk).toBe(2);
  });

  it('CJK-заголовок целиком — заголовок удаляется', () => {
    const md = '# Статья\n\n## 改善肌肤\n\nОбычный абзац остаётся.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\nОбычный абзац остаётся.');
    expect(report.counts.cjk).toBe(4);
  });

  it('CJK внутри легитимного code-fence не трогается', () => {
    const md = '# Статья\n\n```\nconst x = "改善";\n```\n\nАбзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toContain('const x = "改善";');
    expect(report.counts.cjk).toBe(0);
    expect(report.wasModified).toBe(false);
  });

  it('осиротевшие пустые строки после удаления CJK-абзаца схлопываются', () => {
    const md = '# Статья\n\n改善肌肤。\n\nАбзац.';
    const { markdown } = sanitizeArticle(md);
    // Абзац целиком из CJK → строка удалена, не остаётся дыры из пустых строк.
    expect(markdown).toBe('# Статья\n\nАбзац.');
  });

  it('FIX-2: анкор, опустевший после CJK-чистки, — обёртка снимается, URL остаётся plain text', () => {
    const md = '[中文](https://example.com/source)';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('https://example.com/source');
    expect(report.counts.cjk).toBe(2);
    expect(report.wasModified).toBe(true);
  });

  it('FIX-2: обёртка снимается и в предложении вокруг ссылки', () => {
    const md = 'Источник: [中文](https://example.com/source) — читайте.';
    const { markdown } = sanitizeArticle(md);
    expect(markdown).toBe('Источник: https://example.com/source — читайте.');
  });

  it('FIX-2: непустой анкор после чистки остаётся ссылкой', () => {
    const md = 'См. [обзор 中文 и цены](https://example.com/source) далее.';
    const { markdown } = sanitizeArticle(md);
    expect(markdown).toBe('См. [обзор и цены](https://example.com/source) далее.');
  });
});

describe('sanitizeArticle — leaked-фенсы (б)', () => {
  it('обёртка ```markdown ... ``` снимается, контент сохраняется', () => {
    const md = '```markdown\n# Заголовок\n\nАбзац статьи.\n```';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Заголовок\n\nАбзац статьи.');
    expect(report.counts.fences).toBe(1);
  });

  it('обёртка ```md ... ``` снимается', () => {
    const md = '```md\n## Раздел\n\nТекст.\n```';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('## Раздел\n\nТекст.');
    expect(report.counts.fences).toBe(1);
  });

  it('дублирующиеся ``` подряд схлопываются в один', () => {
    const md = '# Статья\n\n```\ncode\n```\n```\n\nАбзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\n```\ncode\n```\n\nАбзац.');
    expect(report.counts.fences).toBe(1);
  });

  it('легитимный code-fence с языком не трогается', () => {
    const md = '# Статья\n\n```js\nconst a = 1;\n```\n\nАбзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.wasModified).toBe(false);
  });
});

describe('sanitizeArticle — ИИ-фразы (в)', () => {
  it('«как ИИ…» предложение удаляется из строки', () => {
    const md = 'Работа выполняется по стандарту. Как ИИ, я не могу консультировать. Приходите на приём.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('Работа выполняется по стандарту. Приходите на приём.');
    expect(report.counts.aiPhrases).toBeGreaterThan(0);
  });

  it('строка-предложение целиком ИИ-фразы — удаляется вся строка', () => {
    const md = '# Статья\n\nНадеюсь, эта статья была полезной!\n\nАбзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\nАбзац.');
    expect(report.counts.aiPhrases).toBe(1);
  });

  it('английские ИИ-фразы удаляются', () => {
    const md = 'Text here. As an AI language model, I cannot provide professional advice. More text.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).not.toMatch(/as an AI language model/i);
    expect(report.counts.aiPhrases).toBeGreaterThan(0);
  });

  it('обычный текст без ИИ-фраз не трогается', () => {
    const md = 'Мы не можем гарантировать результат — влияет индивидуальная реакция.';
    const { markdown, report } = sanitizeArticle(md);
    // «не можем» (не «я не могу») — легитимная профессиональная формулировка.
    expect(markdown).toBe(md);
    expect(report.counts.aiPhrases).toBe(0);
  });

  it('ИИ-фраза внутри code-fence не трогается', () => {
    const md = '# Статья\n\n```\nКак языковая модель я не могу.\n```\n\nАбзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toContain('Как языковая модель я не могу.');
    expect(report.counts.aiPhrases).toBe(0);
  });

  it('FIX-1: легитимная цитата клиента «я не могу уснуть из-за дискомфорта» выживает as-is', () => {
    const md = 'Клиенты жалуются: „я не могу уснуть из-за дискомфорта“ — частая жалоба.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.aiPhrases).toBe(0);
    expect(report.wasModified).toBe(false);
  });

  it('ложный профессиональный дисклеймер «я не являюсь <профессия>» — ловится в ЛЮБОЙ отрасли', () => {
    // Форма одинакова для любой профессии → родовой шаблон, а не перечисление.
    const cases = [
      'Я не являюсь врачом.',
      'Я не являюсь инженером.',
      'Я не являюсь юристом.',
      'Я не являюсь маркетологом и не могу дать рекомендации.',
    ];
    for (const line of cases) {
      const { markdown, report } = sanitizeArticle(`Текст до. ${line} Текст после.`);
      expect(markdown, `должно быть удалено: ${line}`).toBe('Текст до. Текст после.');
      expect(report.counts.aiPhrases).toBeGreaterThan(0);
    }
  });

  it('FIX-1: ИИ-мета формы «я не могу <мета-глагол>» по-прежнему удаляются', () => {
    const cases = [
      'Я не могу предоставить профессиональные рекомендации.',
      'Я не могу помочь с этим вопросом.',
      'Я не могу создать контент на эту тему.',
      'Я не могу сгенерировать текст.',
      'Я не могу ответить на этот вопрос.',
      'As an AI, I must decline this request.',
    ];
    for (const line of cases) {
      const { markdown, report } = sanitizeArticle(`Текст до. ${line} Текст после.`);
      expect(markdown, `должно быть удалено: ${line}`).toBe('Текст до. Текст после.');
      expect(report.counts.aiPhrases).toBeGreaterThan(0);
    }
  });
});

describe('sanitizeArticle — задвоенности (г)', () => {
  it('подряд идущие одинаковые заголовки: остаётся первый', () => {
    const md = '# Статья\n\n## Диагностика\n\n## Диагностика\n\nТекст.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\n## Диагностика\n\nТекст.');
    expect(report.counts.duplicateHeadings).toBe(1);
  });

  it('одинаковые заголовки через разные уровни (## vs ###) тоже дубликат', () => {
    const md = '# Статья\n\n## Лечение\n\n### Лечение\n\nТекст.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\n## Лечение\n\nТекст.');
    expect(report.counts.duplicateHeadings).toBe(1);
  });

  it('НЕ соседние одинаковые заголовки не трогаются', () => {
    const md = '# Статья\n\n## Диагностика\n\nТекст А.\n\n## Диагностика\n\nТекст Б.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.duplicateHeadings).toBe(0);
  });

  it('подряд идущие одинаковые абзацы: остаётся первый', () => {
    const md = '# Статья\n\nПроцедура занимает тридцать минут.\n\nПроцедура занимает тридцать минут.\n\nДальше.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\nПроцедура занимает тридцать минут.\n\nДальше.');
    expect(report.counts.duplicateParagraphs).toBe(1);
  });

  it('разные абзацы не трогаются', () => {
    const md = '# Статья\n\nПервый абзац.\n\nВторой абзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.duplicateParagraphs).toBe(0);
  });

  it('FIX-3: две подряд идентичные GFM-таблицы — keep first, отдельная метрика duplicateTables', () => {
    const table = ['| Метод | Цена |', '|---|---|', '| Лазер | 3000 |'].join('\n');
    const md = `# Статья\n\n${table}\n\n${table}\n\nАбзац.`;
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(`# Статья\n\n${table}\n\nАбзац.`);
    expect(report.counts.duplicateTables).toBe(1);
    expect(report.counts.duplicateParagraphs).toBe(0);
  });

  it('FIX-3: разные таблицы не трогаются', () => {
    const md = [
      '# Статья',
      '',
      '| Метод | Цена |',
      '|---|---|',
      '| Лазер | 3000 |',
      '',
      '| Метод | Длительность |',
      '|---|---|',
      '| Лазер | 30 мин |',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.duplicateTables).toBe(0);
    expect(report.wasModified).toBe(false);
  });
});

describe('sanitizeArticle — комбинированные случаи', () => {
  it('CJK + ИИ-фраза + дубль в одном документе', () => {
    const md = [
      '# Мезотерапия',
      '',
      'Мезотерапия 改善 кожи курсом процедур.',
      '',
      'Как языковая модель, я не могу давать профессиональные рекомендации.',
      '',
      '## Курс',
      '',
      'Курс — 6 процедур.',
      '',
      'Курс — 6 процедур.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(
      ['# Мезотерапия', '', 'Мезотерапия кожи курсом процедур.', '', '## Курс', '', 'Курс — 6 процедур.'].join('\n')
    );
    expect(report.counts.cjk).toBe(2);
    expect(report.counts.aiPhrases).toBeGreaterThan(0);
    expect(report.counts.duplicateParagraphs).toBe(1);
  });

  it('GFM-таблица выживает после санитизации (конвейер T1)', () => {
    const md = [
      '# Сравнение',
      '',
      '| Метод | Цена |',
      '|---|---|',
      '| Лазер | 3000 |',
      '| Инъекции | 2000 |',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.wasModified).toBe(false);
  });

  it('идемпотентность: повторный прогон — no-op', () => {
    const md = '```markdown\n# Заголовок\n\n改善 текст. Надеюсь, эта статья была полезной.\n```';
    const once = sanitizeArticle(md);
    const twice = sanitizeArticle(once.markdown);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.report.wasModified).toBe(false);
  });

  it('tech-lead: коллизия с URL-плейсхолдером — чужой \\u0000N\\u0000 не превращается в "undefined"', () => {
    // Во входном markdown уже был паттерн, совпадающий с внутренним
    // плейсхолдером (NUL + цифра + NUL). Индекс вне диапазона urls —
    // текст должен остаться как был, а не подмениться строкой "undefined".
    const md = 'Заметка \u00007\u0000 без ссылок';
    const { markdown } = sanitizeArticle(md);
    expect(markdown).toBe('Заметка \u00007\u0000 без ссылок');
  });
});

describe('sanitizeArticle — вырезание тех. секций (P3, 2026-08-16)', () => {
  it('«## Дополнительная экспертная информация» посередине: секция вырезана, соседние целы', () => {
    const md = [
      '# Статья',
      '',
      '## Основная часть',
      '',
      'Текст основной части.',
      '',
      '## Дополнительная экспертная информация',
      '',
      '- пункт раз',
      '- пункт два',
      '',
      'Эта информация дополняет основной материал.',
      '',
      '## Заключение',
      '',
      'Итог статьи.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(
      ['# Статья', '', '## Основная часть', '', 'Текст основной части.', '', '## Заключение', '', 'Итог статьи.'].join('\n')
    );
    expect(report.counts.cutSections).toBe(1);
    expect(report.wasModified).toBe(true);
  });

  it('«## Источники» в конце документа: вырезана до EOF', () => {
    const md = [
      '# Статья',
      '',
      'Текст статьи.',
      '',
      '## Источники',
      '',
      '1. [Источник 1](https://example.com/1)',
      '2. [Источник 2](https://example.com/2)',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\nТекст статьи.');
    expect(report.counts.cutSections).toBe(1);
  });

  it('«# Источники» (H1) тоже вырезается', () => {
    const md = '# Тема\n\nТекст.\n\n# Источники\n\nСписок.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Тема\n\nТекст.');
    expect(report.counts.cutSections).toBe(1);
  });

  it('вырезание до следующего заголовка ТОГО ЖЕ или выше уровня: ### подсекция не обрывает вырезку', () => {
    const md = [
      '# Статья',
      '',
      '## Дополнительная экспертная информация',
      '',
      'Вступление секции.',
      '',
      '### Подраздел тех. секции',
      '',
      'Текст подраздела.',
      '',
      '## Полезная секция',
      '',
      'Остаётся.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\n## Полезная секция\n\nОстаётся.');
    expect(report.counts.cutSections).toBe(1);
  });

  it('инлайн-ссылки в ОСНОВНОМ тексте выживают (режем только секции, не ссылки)', () => {
    const md = [
      '# Статья',
      '',
      'Обзор [методики](https://example.com/method) и [цен](https://example.com/price).',
      '',
      '## Источники',
      '',
      ' технический блок ',
    ].join('\n');
    const { markdown } = sanitizeArticle(md);
    expect(markdown).toBe(
      '# Статья\n\nОбзор [методики](https://example.com/method) и [цен](https://example.com/price).'
    );
  });

  it('обычный заголовок «Источники данных для клиентов» НЕ вырезается (точное совпадение)', () => {
    const md = '# Статья\n\n## Источники данных для клиентов\n\nСписок.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.cutSections).toBe(0);
    expect(report.wasModified).toBe(false);
  });

  it('совпадение регистронезависимо и устойчиво к лишним пробелам в заголовке', () => {
    const md = '# Статья\n\n##   источники  \n\nСписок.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья');
    expect(report.counts.cutSections).toBe(1);
  });

  it('тех. заголовок внутри code-fence НЕ вырезается', () => {
    const md = '# Статья\n\n```\n## Источники\n```\n\nАбзац.';
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe(md);
    expect(report.counts.cutSections).toBe(0);
  });

  it('две тех. секции в одном документе: обе вырезаны, счётчик 2', () => {
    const md = [
      '# Статья',
      '',
      '## Дополнительная экспертная информация',
      '',
      'Блок 1.',
      '',
      '## Середина',
      '',
      'Текст.',
      '',
      '## Источники',
      '',
      'Блок 2.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\n## Середина\n\nТекст.');
    expect(report.counts.cutSections).toBe(2);
  });

  it('идемпотентность: после вырезания повторный прогон — no-op', () => {
    const md = '# Статья\n\nТекст.\n\n## Источники\n\nСписок.';
    const once = sanitizeArticle(md);
    const twice = sanitizeArticle(once.markdown);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.report.wasModified).toBe(false);
    expect(twice.report.counts.cutSections).toBe(0);
  });

  // QA (2026-08-16, приёмка c): в существующих кейсах уровни # и ##; тех.блок
  // «Дополнительная экспертная информация» приходит и уровнем ### (подсекция
  // внутри H2-секции) — ката обязана резать ЛЮБОЙ уровень заголовка.
  it('«### Дополнительная экспертная информация» (H3) внутри H2-секции: вырезана, родительская секция цела', () => {
    const md = [
      '# Статья',
      '',
      '## Цены на имплантацию',
      '',
      'Текст секции цен.',
      '',
      '### Дополнительная экспертная информация',
      '',
      '- пункт раз',
      '',
      '## Заключение',
      '',
      'Итог.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).toBe('# Статья\n\n## Цены на имплантацию\n\nТекст секции цен.\n\n## Заключение\n\nИтог.');
    expect(report.counts.cutSections).toBe(1);
  });
});

/* ── U5 (2026-08-20): чанк-артефакты продолжения ────────────────────────── */

import {
  isChunkArtifactLine,
  stripTrailingContinuation,
  CHUNK_ARTIFACT_RES,
} from '../../server/lib/article-sanitizer.mjs';

describe('sanitizeArticle — чанк-артефакты (е), U5', () => {
  it('прод-паттерн 00983341: «*(Продолжение следует в следующем батче...)*» — абзац удалён, счётчик=1', () => {
    const md = [
      '# Статья',
      '',
      '## Секция один',
      '',
      'Текст первой секции статьи.',
      '',
      '*(Продолжение следует в следующем батче...)*',
      '',
      '## Секция два',
      '',
      'Текст второй секции статьи.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(markdown).not.toContain('Продолжение следует');
    expect(markdown).not.toContain('батче');
    expect(report.counts.chunkArtifacts).toBe(1);
    // Соседние секции не задеты.
    expect(markdown).toContain('## Секция один');
    expect(markdown).toContain('## Секция два');
    expect(markdown).toContain('Текст первой секции статьи.');
  });

  it('вариации реестра: [Продолжение], To be continued..., Батч 3 из 9, Continued in next batch', () => {
    const md = [
      '# Статья', '',
      'Текст.', '',
      '[Продолжение]', '',
      'Текст два.', '',
      'To be continued...', '',
      'Батч 3 из 9', '',
      'Continued in next batch', '',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(report.counts.chunkArtifacts).toBe(4);
    expect(markdown).not.toContain('[Продолжение]');
    expect(markdown).not.toContain('To be continued');
    expect(markdown).not.toContain('Батч 3');
    expect(markdown).not.toContain('Continued in next');
    expect(markdown).toContain('Текст.');
    expect(markdown).toContain('Текст два.');
  });

  // ── НЕГАТИВЫ (КРИТИЧНО: голое «продолжение/продолжается» не якорь) ──
  it('ОТРАСЛЕВЫЕ НЕГАТИВЫ: «процесс продолжается», «выплаты продолжаются», «продолжение курса» — ЖИВУТ', () => {
    const md = [
      '# Статья', '',
      'Процесс занимает несколько дней после запуска.', '',
      'Выплаты продолжаются до 10 дней по графику.', '',
      'Работа продолжается дистанционно под наблюдением специалиста.', '',
      'Продолжение курса работ обсуждается на консультации.', '',
      'Окончание курса не означает конец наблюдения.',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(report.counts.chunkArtifacts).toBe(0);
    expect(report.wasModified).toBe(false);
    expect(markdown).toBe(md);
  });

  it('негатив: фраза внутри предложения, а не самостоятельный абзац — строка живёт', () => {
    const md = [
      '# Статья', '',
      'Внедрение занимает месяц, а полный переход продолжается до полугода после запуска.', '',
    ].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(report.counts.chunkArtifacts).toBe(0);
    expect(markdown).toContain('продолжается до полугода');
  });

  it('негатив: длинный абзац (>200 симв.), начинающийся со слов про продолжение — живёт', () => {
    const longPara = 'Продолжение работ требует внимательного отношения к рекомендациям специалиста: ' +
      'регулярные проверки, контрольные замеры, соблюдение регламента и бережный режим нагрузки. ' +
      'Только при выполнении всех условий переход проходит в запланированные сроки.';
    expect(longPara.length).toBeGreaterThan(200);
    const { markdown, report } = sanitizeArticle(`# Статья\n\n${longPara}\n`);
    expect(report.counts.chunkArtifacts).toBe(0);
    expect(markdown).toContain('Продолжение работ требует');
  });

  it('артефакт внутри code-fence не удаляется', () => {
    const md = ['# Статья', '', '```', 'Продолжение следует', '```', '', 'Текст.'].join('\n');
    const { markdown, report } = sanitizeArticle(md);
    expect(report.counts.chunkArtifacts).toBe(0);
    expect(markdown).toContain('Продолжение следует');
  });

  it('идемпотентность: повторный прогон уже-чистого текста — no-op', () => {
    const md = '# Статья\n\nТекст.\n\n*(Продолжение следует в следующем батче...)*\n';
    const once = sanitizeArticle(md);
    const twice = sanitizeArticle(once.markdown);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.report.counts.chunkArtifacts).toBe(0);
    expect(twice.report.wasModified).toBe(false);
  });
});

describe('isChunkArtifactLine — детектор реестра', () => {
  it('true для самостоятельных коротких абзацев-артефактов', () => {
    expect(isChunkArtifactLine('*(Продолжение следует в следующем батче...)*')).toBe(true);
    expect(isChunkArtifactLine('Продолжение следует')).toBe(true);
    expect(isChunkArtifactLine('[Продолжение]')).toBe(true);
    expect(isChunkArtifactLine('Батч 2 из 9')).toBe(true);
    expect(isChunkArtifactLine('To be continued...')).toBe(true);
    expect(isChunkArtifactLine('(Окончание следует)')).toBe(true);
  });
  it('false для null/пустых/длинных/контентных строк', () => {
    expect(isChunkArtifactLine(null)).toBe(false);
    expect(isChunkArtifactLine('')).toBe(false);
    expect(isChunkArtifactLine('   ')).toBe(false);
    expect(isChunkArtifactLine('Симптомы продолжаются несколько дней')).toBe(false);
    expect(isChunkArtifactLine(`${'Продолжение следует '.repeat(20)} и ещё много текста`)).toBe(false);
  });
  it('реестр покрывает ru+en паттерны задачи', () => {
    expect(CHUNK_ARTIFACT_RES.length).toBeGreaterThanOrEqual(7);
  });
});

describe('stripTrailingContinuation — хвост-ONLY обрезка чанков (U5)', () => {
  it('трейлинг-артефакт чанка снят, тело не тронуто', () => {
    const chunk = ['# Секция', '', 'Абзац текста секции.', '', '*(Продолжение следует в следующем батче...)*'];
    const out = stripTrailingContinuation(chunk.join('\n'));
    expect(out).toBe('# Секция\n\nАбзац текста секции.');
  });

  it('хвостовые пустые строки после артефакта схлопываются', () => {
    const chunk = 'Абзац.\n\nПродолжение следует\n\n\n';
    expect(stripTrailingContinuation(chunk)).toBe('Абзац.');
  });

  it('без артефакта — no-op (бит-в-бит)', () => {
    const chunk = '# Секция\n\nОбычный последний абзац.';
    expect(stripTrailingContinuation(chunk)).toBe(chunk);
  });

  it('артефакт НЕ в хвосте — no-op (только хвост!)', () => {
    const chunk = 'Продолжение следует\n\nНастоящий контент секции.';
    expect(stripTrailingContinuation(chunk)).toBe(chunk);
  });

  it('негатив: последний абзац с «продолжаются» — no-op', () => {
    const chunk = '# Секция\n\nСимптомы продолжаются несколько дней.';
    expect(stripTrailingContinuation(chunk)).toBe(chunk);
  });

  it('null/пустая строка — no-op', () => {
    expect(stripTrailingContinuation(null)).toBe(null);
    expect(stripTrailingContinuation('')).toBe('');
  });
});
