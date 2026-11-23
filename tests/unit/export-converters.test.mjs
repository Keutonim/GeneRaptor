/**
 * M8 — pure export converters (markdown → html / txt / md).
 *
 * The article body reaches the client as markdown; the export control copies
 * the same article in three formats. These converters are the single place
 * where a format is derived, so the expectations below are exact strings.
 */
import { describe, it, expect } from 'vitest';
import {
  markdownToHtml,
  markdownToText,
  markdownToMarkdown,
  convertMarkdown,
} from '../../src/lib/export/converters';

const MARKDOWN = [
  '# Заголовок',
  '',
  'Первый абзац с **жирным** и *курсивом* текстом.',
  '',
  '- пункт один',
  '- пункт два',
  '',
  '1. шаг первый',
  '2. шаг второй',
  '',
  '> Цитата.',
  '',
  'Ссылка: [документ](https://example.com) и `код`.',
  '',
].join('\n');

const HTML = [
  '<h1>Заголовок</h1>',
  '<p>Первый абзац с <strong>жирным</strong> и <em>курсивом</em> текстом.</p>',
  '<ul>',
  '<li>пункт один</li>',
  '<li>пункт два</li>',
  '</ul>',
  '<ol>',
  '<li>шаг первый</li>',
  '<li>шаг второй</li>',
  '</ol>',
  '<blockquote>',
  '<p>Цитата.</p>',
  '</blockquote>',
  '<p>Ссылка: <a href="https://example.com">документ</a> и <code>код</code>.</p>',
].join('\n');

const TEXT = [
  'Заголовок',
  '',
  'Первый абзац с жирным и курсивом текстом.',
  '',
  'пункт один',
  'пункт два',
  '',
  'шаг первый',
  'шаг второй',
  '',
  'Цитата.',
  '',
  'Ссылка: документ и код.',
].join('\n');

describe('markdownToHtml — семантический HTML', () => {
  it('переводит один и тот же markdown в точный HTML', () => {
    expect(markdownToHtml(MARKDOWN)).toBe(HTML);
  });

  it('экранирует HTML-спецсимволы в тексте', () => {
    expect(markdownToHtml('5 < 6 & "кавычки"')).toBe('<p>5 &lt; 6 &amp; &quot;кавычки&quot;</p>');
  });

  it('пустой markdown даёт пустой HTML', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('блок кода остаётся текстом, а не разметкой', () => {
    expect(markdownToHtml(['```js', 'const a = 1 < 2;', '```'].join('\n'))).toBe(
      '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>',
    );
  });
});

describe('markdownToText — чистый текст', () => {
  it('переводит один и тот же markdown в точный текст', () => {
    expect(markdownToText(MARKDOWN)).toBe(TEXT);
  });

  it('пустой markdown даёт пустой текст', () => {
    expect(markdownToText('')).toBe('');
  });
});

describe('markdownToMarkdown — нормализованный markdown', () => {
  it('убирает хвостовые пробелы и лишние пустые строки', () => {
    expect(markdownToMarkdown('  # Заголовок  \n\n\n\n\nАбзац   \n')).toBe('# Заголовок\n\nАбзац');
  });

  it('уже нормализованный markdown не меняется', () => {
    expect(markdownToMarkdown(MARKDOWN)).toBe(MARKDOWN.trim());
  });

  it('пустой markdown даёт пустую строку', () => {
    expect(markdownToMarkdown('')).toBe('');
  });
});

describe('convertMarkdown — формат выбирается в одном месте', () => {
  it('html / text / markdown из одного источника', () => {
    expect(convertMarkdown(MARKDOWN, 'html')).toBe(HTML);
    expect(convertMarkdown(MARKDOWN, 'text')).toBe(TEXT);
    expect(convertMarkdown(MARKDOWN, 'markdown')).toBe(MARKDOWN.trim());
  });
});
