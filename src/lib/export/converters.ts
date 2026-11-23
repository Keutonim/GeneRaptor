/**
 * M8 — pure converters for the article export.
 *
 * The article body reaches the client as markdown; the export control copies
 * the same article as HTML, TXT or Markdown. The conversion lives here — pure
 * and deterministic — so a clipboard payload can be asserted exactly.
 */
import { stripMarkdown } from '../strip-markdown';

export type ExportFormat = 'html' | 'text' | 'markdown';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const UNORDERED = /^[-*+]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```(.*)$/;

/** HTML-escape the characters that would otherwise become markup. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPES[char]);
}

/** Inline markdown → HTML: code spans, links, images, bold, italic. */
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const withoutCode = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  const escaped = escapeHtml(withoutCode);
  const linked = escaped
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_match, alt: string, url: string) => `<img src="${url}" alt="${alt}">`,
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
    );
  const marked = linked
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(?<!\w)\*([^*\s][^*]*)\*(?!\w)/g, '<em>$1</em>')
    .replace(/(?<!\w)_([^_\s][^_]*)_(?!\w)/g, '<em>$1</em>');
  return marked.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)]);
}

/** A line that opens a new block ends the current paragraph. */
function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    HEADING.test(trimmed) ||
    RULE.test(trimmed) ||
    UNORDERED.test(trimmed) ||
    ORDERED.test(trimmed) ||
    QUOTE.test(trimmed) ||
    FENCE.test(trimmed)
  );
}

/** A paragraph keeps soft line breaks as `<br>`. */
function renderParagraph(text: string): string {
  return `<p>${renderInline(text).replace(/\n/g, '<br>')}</p>`;
}

/** Markdown → semantic HTML (headings, paragraphs, lists, quote, code, rule). */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(trimmed);
    if (fence) {
      const language = escapeHtml(fence[1].trim());
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index].trim())) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const code = escapeHtml(body.join('\n'));
      html.push(
        language
          ? `<pre><code class="language-${language}">${code}</code></pre>`
          : `<pre><code>${code}</code></pre>`,
      );
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (RULE.test(trimmed)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (UNORDERED.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = UNORDERED.exec(lines[index].trim());
        if (!item) break;
        items.push(`<li>${renderInline(item[1].trim())}</li>`);
        index += 1;
      }
      html.push('<ul>', ...items, '</ul>');
      continue;
    }

    if (ORDERED.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = ORDERED.exec(lines[index].trim());
        if (!item) break;
        items.push(`<li>${renderInline(item[1].trim())}</li>`);
        index += 1;
      }
      html.push('<ol>', ...items, '</ol>');
      continue;
    }

    if (QUOTE.test(trimmed)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const item = QUOTE.exec(lines[index].trim());
        if (!item) break;
        quoted.push(item[1].trim());
        index += 1;
      }
      html.push('<blockquote>', renderParagraph(quoted.join('\n')), '</blockquote>');
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(renderParagraph(paragraph.join('\n')));
  }

  return html.join('\n');
}

/** Markdown → plain text (the legacy stripper is the single text source). */
export function markdownToText(markdown: string): string {
  if (!markdown) return '';
  return stripMarkdown(markdown);
}

/** Markdown → normalized markdown: no trailing spaces, no double blank lines. */
export function markdownToMarkdown(markdown: string): string {
  if (!markdown) return '';
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The format decision lives in one place. */
export function convertMarkdown(markdown: string, format: ExportFormat): string {
  if (format === 'html') return markdownToHtml(markdown);
  if (format === 'text') return markdownToText(markdown);
  return markdownToMarkdown(markdown);
}
