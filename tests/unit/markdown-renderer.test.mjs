import { describe, it, expect } from 'vitest';
import {
  renderMarkdownToHtml,
  htmlToPlainText,
  looksLikeHtml,
} from '../../server/lib/markdown-renderer.mjs';
import { shouldMigrate, migrateRow } from '../../scripts/migrate-content-to-html.mjs';
import { sanitizeArticle } from '../../server/lib/article-sanitizer.mjs';
import { normalizeHeadings } from '../../server/lib/heading-normalizer.mjs';

describe('renderMarkdownToHtml — GFM end-to-end: таблицы (T1)', () => {
  it('GFM-таблица проходит весь конвейер: table/thead/tbody/tr/th/td', () => {
    const md = [
      '## Сравнение методов',
      '',
      '| Метод | Длительность | Реабилитация |',
      '| --- | --- | --- |',
      '| Лазерная шлифовка | 30 мин | 1–2 дня |',
      '| Инъекции | 20 мин | 2 дня |',
    ].join('\n');
    const html = renderMarkdownToHtml(md);

    // Полная структура таблицы сохранена после marked → DOMPurify.
    expect(html).toContain('<table>');
    expect(html).toContain('</table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('</thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('</tbody>');
    expect(html).toContain('<tr>');
    expect(html).toContain('</tr>');
    expect(html).toContain('<th>Метод</th>');
    expect(html).toContain('<th>Длительность</th>');
    expect(html).toContain('<td>Лазерная шлифовка</td>');
    expect(html).toContain('<td>30 мин</td>');
  });

  it('markdown-ссылка в ячейке таблицы становится <a href> (конвейер internal-linker)', () => {
    const md = [
      '| Услуга | Цена |',
      '| --- | --- |',
      '| [УЗИ брюшной полости](https://example.com/uzi) | 3000 |',
    ].join('\n');
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<td><a href="https://example.com/uzi">УЗИ брюшной полости</a></td>');
  });

  it('GFM-зачёркивание ~~text~~ → <del> (проходит DOMPurify)', () => {
    const html = renderMarkdownToHtml('Старая цена ~~5000~~, новая 3000 рублей.');
    expect(html).toContain('<del>5000</del>');
  });
});

describe('полный конвейер статей: sanitize → normalizeHeadings → render (T1+T2+T3)', () => {
  it('GFM-таблица выживает после санитизации и нормализации заголовков', () => {
    const md = [
      '## Сравнение методов',
      '',
      '| Метод | Цена |',
      '|---|---|',
      '| Лазер | 3000 |',
      '| Инъекции | 2000 |',
      '',
      '### Уход после процедуры 改善 кожи',
      '',
      'Обычный текст.',
    ].join('\n');

    const sanitized = sanitizeArticle(md);
    const normalized = normalizeHeadings(sanitized.markdown);
    const html = renderMarkdownToHtml(normalized.markdown);

    // Таблица цела, CJK вычищен, заголовки нормализованы (первый → H1).
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<td>Лазер</td>');
    expect(html).not.toMatch(/改善/);
    expect(html).toContain('<h1>Сравнение методов</h1>');
    expect(html).toContain('<h2>Уход после процедуры кожи</h2>');
  });

  it('артефактный --- после абзаца не склеивается в setext-заголовок при рендере', () => {
    const md = '# Статья\n\nАбзац с текстом.\n---\n\nЕщё абзац.';
    const normalized = normalizeHeadings(md);
    const html = renderMarkdownToHtml(normalized.markdown);
    // hr — отдельный элемент, абзац не «съеден» в заголовок.
    expect(html).toContain('<hr>');
    expect(html).toContain('<p>Абзац с текстом.</p>');
    expect(html).toContain('<p>Ещё абзац.</p>');
  });
});

describe('renderMarkdownToHtml — базовый markdown', () => {
  it('превращает markdown-ссылку в <a href>', () => {
    const md = 'См. [услуга](https://example.com/usluga) подробнее.';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<a href="https://example.com/usluga">услуга</a>');
  });

  it('превращает заголовки в <h1>/<h2>', () => {
    const html = renderMarkdownToHtml('# Заголовок\n\n## Подзаголовок');
    expect(html).toContain('<h1>Заголовок</h1>');
    expect(html).toContain('<h2>Подзаголовок</h2>');
  });

  it('превращает маркированный список в <ul><li>', () => {
    const html = renderMarkdownToHtml('- первый\n- второй\n- третий');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>первый</li>');
    expect(html).toContain('<li>второй</li>');
    expect(html).toContain('<li>третий</li>');
  });

  it('превращает нумерованный список в <ol><li>', () => {
    const html = renderMarkdownToHtml('1. один\n2. два\n3. три');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>один</li>');
    expect(html).toContain('<li>два</li>');
  });

  it('превращает GFM-таблицу в <table>', () => {
    const md = '| Услуга | Цена |\n|---|---|\n| УЗИ | 3000 |';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Услуга</th>');
    expect(html).toContain('<td>УЗИ</td>');
  });

  it('оборачивает обычный текст в <p>', () => {
    const html = renderMarkdownToHtml('Простой абзац текста.');
    expect(html).toContain('<p>Простой абзац текста.</p>');
  });
});

describe('renderMarkdownToHtml — пустой/некорректный ввод', () => {
  it('возвращает "" для null', () => {
    expect(renderMarkdownToHtml(null)).toBe('');
  });

  it('возвращает "" для undefined', () => {
    expect(renderMarkdownToHtml(undefined)).toBe('');
  });

  it('возвращает "" для пустой строки', () => {
    expect(renderMarkdownToHtml('')).toBe('');
  });

  it('возвращает "" для строки из пробелов', () => {
    expect(renderMarkdownToHtml('   \n\t  ')).toBe('');
  });

  it('не падает на не-строке (число)', () => {
    expect(renderMarkdownToHtml(123)).toBe('');
  });
});

describe('renderMarkdownToHtml — XSS-защита', () => {
  it('вырезает <script>', () => {
    const md = '<script>alert(1)</script>[x](javascript:alert(1))';
    const html = renderMarkdownToHtml(md);
    // Никакого executable <script> в выводе.
    expect(html).not.toMatch(/<script/i);
    // Никакого href с протоколом javascript: (это и есть реальный вектор).
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it('вырезает javascript: href из markdown-ссылки', () => {
    const md = 'клик [сюда](javascript:alert(1))';
    const html = renderMarkdownToHtml(md);
    // href с javascript: протоколом не должен появиться (это executable вектор).
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    // текст анкора сохранён как видимый контент.
    expect(html).toContain('сюда');
  });

  it('вырезает javascript: href из готового HTML', () => {
    const md = '<a href="javascript:alert(1)">bad</a>';
    const html = renderMarkdownToHtml(md);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    expect(html).toContain('bad');
  });

  it('вырезает onerror-обработчик из <img>', () => {
    const md = '<img src="x" onerror="alert(1)">';
    const html = renderMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('onerror');
  });

  it('не позволяет data:-URI в href', () => {
    const md = '[x](data:text/html,<script>alert(1)</script>)';
    const html = renderMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('data:text/html');
  });
});

describe('renderMarkdownToHtml — target/rel атрибуты (ADD_ATTR)', () => {
  it('сохраняет target="_blank" в готовом HTML', () => {
    const md = '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ссылка</a>';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('сохраняет target/rel для markdown-ссылки, обёрнутой в HTML-обёртку', () => {
    // даже если marked не добавляет target, серверная санитизация не должна
    // вырезать эти атрибуты, если они есть
    const md =
      '<a href="https://example.com" target="_blank" rel="noopener">внешняя</a> и [внутренняя](/internal)';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('href="/internal"');
  });
});

describe('renderMarkdownToHtml — idempotency (уже-HTML)', () => {
  it('не ломает уже-HTML параграф (сохраняет структуру)', () => {
    const htmlIn = '<p>Уже готовый <a href="https://example.com">HTML</a>.</p>';
    const out = renderMarkdownToHtml(htmlIn);
    expect(out).toContain('<p>');
    expect(out).toContain('<a href="https://example.com">HTML</a>');
    // не должно появиться двойного оборачивания или экранирования
    expect(out).not.toContain('&lt;p&gt;');
  });

  it('повторный рендер результата стабилен', () => {
    const md = '## Раздел\n\nТекст со [ссылкой](https://x.com).';
    const once = renderMarkdownToHtml(md);
    const twice = renderMarkdownToHtml(once);
    // второй прогон по уже-HTML не должен радикально менять результат
    expect(twice).toContain('<h2>Раздел</h2>');
    expect(twice).toContain('<a href="https://x.com">ссылкой</a>');
  });
});

describe('htmlToPlainText', () => {
  it('вырезает HTML-теги, оставляя текст', () => {
    expect(htmlToPlainText('<p>Привет <a href="x">мир</a>.</p>')).toBe('Привет мир.');
  });

  it('возвращает "" для null/undefined', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText(undefined)).toBe('');
  });

  it('возвращает "" для пустой строки', () => {
    expect(htmlToPlainText('')).toBe('');
  });

  it('инлайн-пробелы схлопывает, края обрезает (внутри одного абзаца)', () => {
    const html = '<p>  Абзац   текста  </p>';
    expect(htmlToPlainText(html)).toBe('Абзац текста');
  });

  it('не содержит HTML-тегов', () => {
    const html = '<ul><li>один</li><li>два</li></ul>';
    const text = htmlToPlainText(html);
    expect(text).not.toContain('<');
    expect(text).toContain('один');
    expect(text).toContain('два');
  });
});

describe('htmlToPlainText — U6: блочно-осознанный плейн-текст (переносы сохраняются)', () => {
  it('заголовки и абзацы разделяются пустой строкой (\\n\\n), а не склеиваются', () => {
    const html = '<h1>Заголовок</h1>\n\n<p>  Абзац   текста  </p>';
    expect(htmlToPlainText(html)).toBe('Заголовок\n\nАбзац текста');
  });

  it('таблица 3×3 (thead/tbody через DOM): строки через \\n, ячейки через « | »', () => {
    const md = [
      '| Метод | Длительность | Реабилитация |',
      '| --- | --- | --- |',
      '| Лазерная шлифовка | 30 мин | 1–2 дня |',
      '| Инъекции | 20 мин | 2 дня |',
    ].join('\n');
    const text = htmlToPlainText(renderMarkdownToHtml(md));
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Метод | Длительность | Реабилитация');
    expect(lines[1]).toBe('Лазерная шлифовка | 30 мин | 1–2 дня');
    expect(lines[2]).toBe('Инъекции | 20 мин | 2 дня');
    // GFM-разделители (|---|---|) в вывод не текут: строки не начинаются/не
    // заканчиваются голой pipe и не состоят из дефисов.
    for (const line of lines) {
      expect(line.startsWith('|')).toBe(false);
      expect(line.endsWith('|')).toBe(false);
      expect(/^-+$/.test(line)).toBe(false);
    }
  });

  it('список: каждый пункт «• текст» на своей строке', () => {
    const html = renderMarkdownToHtml('- первый\n- второй\n- третий');
    expect(htmlToPlainText(html)).toBe('• первый\n• второй\n• третий');
  });

  it('нумерованный список тоже «• » (единый маркер по спецификации U6)', () => {
    const html = renderMarkdownToHtml('1. один\n2. два');
    expect(htmlToPlainText(html)).toBe('• один\n• два');
  });

  it('ссылка → текст анкора, href в вывод не попадает', () => {
    const html = renderMarkdownToHtml('См. [услуга](https://example.com/usluga) подробнее.');
    const text = htmlToPlainText(html);
    expect(text).toBe('См. услуга подробнее.');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('http');
  });

  it('hr → разделитель «---» отдельным абзацем', () => {
    const html = renderMarkdownToHtml('Абзац до разделителя.\n\n---\n\nАбзац после.');
    expect(htmlToPlainText(html)).toBe('Абзац до разделителя.\n\n---\n\nАбзац после.');
  });

  it('markdown-символы (**, ###, |) в выводе отсутствуют', () => {
    const md = [
      '### Подзаголовок с **жирным** и *курсивом*',
      '',
      'Абзац с **болдом** внутри.',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    const text = htmlToPlainText(renderMarkdownToHtml(md));
    expect(text).not.toContain('**');
    expect(text).not.toContain('###');
    expect(text).not.toContain('*');
    expect(text).toContain('Подзаголовок с жирным и курсивом');
    expect(text).toContain('Абзац с болдом внутри.');
    expect(text).toContain('a | b');
  });

  it('переносы ЕСТЬ: полный документ → несколько строк (не одна строка-каша)', () => {
    const md = [
      '# Заголовок статьи',
      '',
      'Первый абзац текста статьи.',
      '',
      '## Раздел',
      '',
      '- пункт один',
      '- пункт два',
      '',
      'Финальный абзац.',
    ].join('\n');
    const text = htmlToPlainText(renderMarkdownToHtml(md));
    expect(text).toContain('\n');
    expect(text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(6);
    expect(text.startsWith('Заголовок статьи\n\nПервый абзац текста статьи.')).toBe(true);
  });

  it('<br> → перенос строки внутри абзаца', () => {
    expect(htmlToPlainText('<p>строка один<br>строка два</p>')).toBe('строка один\nстрока два');
  });

  it('таблица и абзацы разделены пустой строкой (таблица — один блок)', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\nАбзац после таблицы.';
    const text = htmlToPlainText(renderMarkdownToHtml(md));
    expect(text).toBe('a | b\n1 | 2\n\nАбзац после таблицы.');
  });

  it('прогоны 3+ переносов схлопываются до 2', () => {
    const html = '<div><p>один</p></div><div><div><p>два</p></div></div>';
    expect(htmlToPlainText(html).split('\n').filter((l) => l === '').length).toBeLessThanOrEqual(1);
  });

  it('code-fence: содержимое pre сохраняет внутренние переносы', () => {
    const html = '<pre>строка 1\nстрока 2</pre>';
    expect(htmlToPlainText(html)).toBe('строка 1\nстрока 2');
  });
});

describe('looksLikeHtml — эвристика для миграции', () => {
  it('true для текста с <p>', () => {
    expect(looksLikeHtml('<p>html</p>')).toBe(true);
  });

  it('true для текста с <a ', () => {
    expect(looksLikeHtml('<a href="x">link</a>')).toBe(true);
  });

  it('true для текста с <h1>', () => {
    expect(looksLikeHtml('<h1>Title</h1><p>body</p>')).toBe(true);
  });

  it('false для чистого markdown (заголовки/списки без HTML)', () => {
    expect(looksLikeHtml('# Заголовок\n\nТекст\n\n- пункт')).toBe(false);
  });

  it('false для markdown со ссылками [..](..)', () => {
    expect(looksLikeHtml('Текст [ссылка](https://x.com) далее')).toBe(false);
  });

  it('false для пустой/null строки', () => {
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml(null)).toBe(false);
    expect(looksLikeHtml(undefined)).toBe(false);
  });
});

describe('migration script — shouldMigrate', () => {
  it('true для markdown-контента (есть заголовки/ссылки, нет HTML-тегов)', () => {
    const md = '# Заголовок\n\n## Раздел\n\nТекст со [ссылкой](https://x.com).';
    expect(shouldMigrate({ contentHtml: md })).toBe(true);
  });

  it('false для уже-HTML контента', () => {
    const html = '<h1>Title</h1><p>body <a href="x">link</a></p>';
    expect(shouldMigrate({ contentHtml: html })).toBe(false);
  });

  it('false для null/пустого content_html', () => {
    expect(shouldMigrate({ contentHtml: null })).toBe(false);
    expect(shouldMigrate({ contentHtml: '' })).toBe(false);
    expect(shouldMigrate({})).toBe(false);
  });
});

describe('migration script — migrateRow (idempotency)', () => {
  it('превращает markdown в HTML + плейн-текст + characterCount', () => {
    const md = '# Заголовок\n\nАбзац со [ссылкой](https://x.com).';
    const result = migrateRow(md);
    expect(result.contentHtml).toContain('<h1>Заголовок</h1>');
    expect(result.contentHtml).toContain('<a href="https://x.com">ссылкой</a>');
    // U6: блочные переносы сохраняются (заголовок и абзац — разные блоки).
    expect(result.contentText).toBe('Заголовок\n\nАбзац со ссылкой.');
    expect(result.characterCount).toBe(result.contentText.length);
  });

  it('после миграции результат выглядит как HTML (повторный прогон → no-op)', () => {
    const md = '# Заголовок\n\n## Раздел\n\nТекст со [ссылкой](https://x.com).';
    const once = migrateRow(md);
    // результат первой миграции — HTML, значит shouldMigrate его пропустит.
    expect(shouldMigrate({ contentHtml: once.contentHtml })).toBe(false);

    // и повторный migrateRow не ломает структуру.
    const twice = migrateRow(once.contentHtml);
    expect(twice.contentHtml).toContain('<h1>Заголовок</h1>');
    expect(twice.contentHtml).toContain('<a href="https://x.com">ссылкой</a>');
  });

  it('санитизирует XSS в markdown при миграции', () => {
    const md = '<a href="javascript:alert(1)">bad</a> и [x](javascript:alert(2))';
    const result = migrateRow(md);
    expect(result.contentHtml).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });
});


/* ════════════════════════════════════════════════════════════════════════
 * P1c (2026-09-18): JSON-LD script в contentHtml невидим для
 * плейн-текста. Воркер аттачит schema-скрипт в contentHtml ПОСЛЕ сборки
 * contentText, но GET /articles/:id/content роута пересчитывает contentText
 * из ХРАНИМОГО contentHtml — JSON machine-data не должен утекать в текст.
 * ═══════════════════════════════════════════════════════════════════════ */

describe('htmlToPlainText — JSON-LD/script слепота (P1c)', () => {
  const HTML = '<h1>Тема</h1>\n<p>Текст статьи.</p>';
  const JSONLD =
    '<script type="application/ld+json" data-generaptor="article-schema">' +
    JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', headline: 'Тема' }] }) +
    '</script>';

  it('плейн-текст идентичен с приложенным JSON-LD и без него', () => {
    expect(htmlToPlainText(`${HTML}\n${JSONLD}`)).toBe(htmlToPlainText(HTML));
  });

  it('содержимое <style> тоже не утекает в текст', () => {
    expect(htmlToPlainText(`${HTML}\n<style>p { color: red; }</style>`)).toBe(htmlToPlainText(HTML));
  });

  it('скрипт внутри абзаца не оставляет пустых блоков и не склеивает текст', () => {
    const html = '<p>До</p>\n<script>var x = 1;</script>\n<p>После</p>';
    expect(htmlToPlainText(html)).toBe('До\n\nПосле');
  });
});
