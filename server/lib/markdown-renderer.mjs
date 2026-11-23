/**
 * Markdown → HTML рендер с серверной XSS-санитизацией.
 *
 * Контекст (B1, fix/sources-and-link-rendering-2026-07-29):
 * internal-linker вставляет markdown-ссылки [текст](url) в финальный текст статьи,
 * но worker (saveFinalVersion) раньше клал этот markdown в content_html как есть.
 * Фронт скармливает content_html в DOMPurify → markdown-ссылки оставались литералами.
 *
 * Этот модуль — единственное место, где markdown статьи превращается в HTML.
 * Серверная санитизация обязательна: LLM может вернуть <script> или javascript: href.
 *
 * Экспорты:
 *  - renderMarkdownToHtml(md): string  — markdown/HTML → санитизированный HTML.
 *  - htmlToPlainText(html): string     — HTML → плейн-текст с блочными
 *      переносами (U6: абзацы/списки/таблицы/br/hr — не одна строка-каша).
 *  - looksLikeHtml(s): boolean         — эвристика для миграции (уже-HTML vs markdown).
 */

import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// ── Настройка marked: GFM (таблицы, зачёркивание), без breaks (одиночный \n — не <br>). ──
marked.setOptions({ gfm: true, breaks: false });

// ── Единое jsdom-окно для серверной санитизации (создаётся один раз). ──
// DOMPurify.sanitize не имеет состояния между вызовами, окно можно переиспользовать.
const PURIFY_WINDOW = new JSDOM('').window;
const purify = createDOMPurify(PURIFY_WINDOW);

// Окно для htmlToPlainText (.textContent).
const TEXT_WINDOW = new JSDOM('').window;

/**
 * Конфиг DOMPurify: разрешаем target/rel (для ссылок, открывающихся в новой вкладке).
 * Остальное — дефолтные правила (вырезают script, on* , javascript: href и т.д.).
 */
const SANITIZE_CONFIG = { ADD_ATTR: ['target', 'rel'] };

/**
 * Превращает markdown (или уже-HTML) в санитизированный HTML.
 *
 * @param {string} md — markdown или HTML текст (может содержать LLM-артефакты)
 * @returns {string} санитизированный HTML ('' для пустого/null ввода)
 */
export function renderMarkdownToHtml(md) {
  if (typeof md !== 'string') return '';
  const trimmed = md.trim();
  if (!trimmed) return '';

  // marked.parse синхронно возвращает string при дефолтных настройках
  // (async=true по умолчанию выключен — без расширений, возвращающих Promise).
  const rawHtml = marked.parse(trimmed);

  // Серверная санитизация — единственный барьер от XSS из LLM-вывода.
  const clean = purify.sanitize(rawHtml, SANITIZE_CONFIG);

  // marked добавляет trailing \n после блочных элементов — убираем крайние пробелы.
  return clean.trim();
}

/**
 * Извлекает плейн-текст из HTML (strip тегов).
 * Используется для content_text и подсчёта characterCount.
 *
 * U6 (2026-08-20): блочно-осознанный обход DOM (JSDOM) вместо
 * `.textContent.replace(/\s+/g,' ')` — старая схема убивала ВСЕ переносы
 * (contentText = одна строка-каша, ячейки таблиц склеены). Теперь:
 *   - h1–h6 / p / div / blockquote → абзац (разделение пустой строкой \n\n);
 *   - li  → «• текст» + \n (список — строкой на пункт);
 *   - tr  → строка «ячейка | ячейка» + \n (thead/tbody обходятся DOM-ом);
 *   - br  → \n; hr → разделитель «---» отдельным абзацем;
 *   - a   → текст анкора (href в плейн-текст не попадает);
 *   - инлайн-пробелы схлопываются, переносы — НЕТ; прогоны 3+ \n → 2.
 * Никаких markdown-символов источника (**, ###, |---|) в вывод не течёт:
 * marked уже превратил их в теги, мы читаем только текстовые узлы.
 *
 * @param {string} html
 * @returns {string} текст без тегов, с блочными переносами ('' для пустого ввода)
 */

/** Блочные элементы: собственный абзац, разделённый пустой строкой. */
const PARAGRAPH_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'main', 'nav', 'p', 'pre', 'section',
]);

/** Схлопывание инлайн-пробелов вокруг переносов (переносы из <br> сохраняются). */
function cleanInlineText(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Инлайн-текст поддерева: текстовые узлы (пробелы → один пробел), <br> → \n. */
function inlineTextOf(node) {
  if (node.nodeType === 3) {
    return (node.nodeValue || '').replace(/[\s\u00a0]+/g, ' ');
  }
  if (node.nodeType !== 1) return '';
  const tag = node.tagName ? node.tagName.toLowerCase() : '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return node.getAttribute?.('alt') ? ` ${node.getAttribute('alt')} ` : '';
  if (tag === 'pre') return node.textContent || '';
  // Machine data / styling is never visible text: the JSON-LD schema script
  // (P1c, attached to contentHtml after postcheck) must not leak into
  // contentText even when a consumer re-derives text from stored HTML.
  if (tag === 'script' || tag === 'style') return '';
  let out = '';
  for (const child of node.childNodes) out += inlineTextOf(child);
  return out;
}

/** Строка таблицы: th/td через « | » (DOM-обход — thead/tbody не важны). */
function rowTextOf(tr) {
  const cells = [];
  for (const child of tr.childNodes) {
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'th' || tag === 'td') {
      cells.push(cleanInlineText(inlineTextOf(child)));
    }
  }
  return cells.filter(Boolean).join(' | ');
}

/**
 * Обход контейнера → массив блочных строк.
 * Список (ul/ol) схлопывается в ОДИН блок (пункты через \n внутри), таблица —
 * в один блок (строки через \n) — межблочное разделение \n\n остаётся снаружи.
 */
function collectBlocks(node) {
  const blocks = [];
  let inline = '';

  const flushInline = () => {
    const cleaned = cleanInlineText(inline);
    if (cleaned) blocks.push(cleaned);
    inline = '';
  };

  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      inline += (child.nodeValue || '').replace(/[\s\u00a0]+/g, ' ');
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tag = child.tagName.toLowerCase();

    // P1c (2026-09-18): <script>/<style> are invisible — skipping them at the
    // block level too, so a JSON-LD script appended to contentHtml never adds
    // blocks/blank lines to the derived plain text.
    if (tag === 'script' || tag === 'style') {
      continue;
    }

    if (tag === 'br') {
      inline += '\n';
      continue;
    }

    if (tag === 'li') {
      flushInline();
      const text = cleanInlineText(inlineTextOf(child));
      if (text) blocks.push(`• ${text}`);
      continue;
    }

    if (tag === 'tr') {
      flushInline();
      const row = rowTextOf(child);
      if (row) blocks.push(row);
      continue;
    }

    if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'ul' || tag === 'ol') {
      flushInline();
      // Внутри — только li/tr (смешанный инлайн-мусор между ними отбрасывается
      // flushInline с пустым буфером); пункты/строки разделяются \n.
      const inner = collectBlocks(child).join('\n');
      if (inner) blocks.push(inner);
      continue;
    }

    if (tag === 'hr') {
      flushInline();
      blocks.push('---');
      continue;
    }

    if (tag === 'pre') {
      // Код-блок: содержимое как есть (переносы/отступы не схлопываем).
      flushInline();
      const code = (child.textContent || '').trim();
      if (code) blocks.push(code);
      continue;
    }

    if (PARAGRAPH_TAGS.has(tag)) {
      flushInline();
      const inner = collectBlocks(child);
      if (inner.length) blocks.push(inner.join('\n\n'));
      continue;
    }

    // Инлайн-элемент (strong/em/a/span/code…): текст в текущий буфер.
    inline += inlineTextOf(child);
  }

  flushInline();
  return blocks;
}

export function htmlToPlainText(html) {
  if (typeof html !== 'string') return '';
  if (!html.trim()) return '';

  const dom = new JSDOM(`<body>${html}</body>`, { window: TEXT_WINDOW });
  const body = dom.window.document.body;
  const text = collectBlocks(body).join('\n\n');
  // Прогоны 3+ переносов → 2; края — чистые.
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Эвристика «похоже ли на HTML» — для миграционного скрипта (idempotency).
 * Если в тексте уже есть блочные/строчные HTML-теги — считаем, что это уже HTML,
 * и повторная конвертация не требуется (marked всё равно отрендерит, но мы хотим
 * явный skip, чтобы не трогать уже-корректные статьи и избежать двойной обработки).
 *
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeHtml(s) {
  if (typeof s !== 'string' || !s) return false;
  // Блочные/строчные теги, которые marked гарантированно производит.
  return /<(p|a |a$|h[1-6]|ul|ol|li|table|blockquote|pre|div|br)\b/i.test(s);
}
