/**
 * M6 — единая точка выбора, что копировать из статьи.
 *
 * M8: the engine row keeps the authoritative `contentHtml` / `contentText` /
 * `contentMarkdown`; when a row has no such field, the pure converters
 * derive the very same payload from the engine markdown.
 */
import { convertMarkdown, type ExportFormat } from '../../lib/export/converters';

export type { ExportFormat };

export interface ExportableContent {
  contentHtml: string;
  contentText: string;
  contentMarkdown: string;
}

/** Формат → текст для буфера обмена. */
export function exportPayload(
  content: ExportableContent | null,
  format: ExportFormat,
): string {
  if (!content) return '';
  const direct =
    format === 'html'
      ? content.contentHtml
      : format === 'markdown'
        ? content.contentMarkdown
        : content.contentText;
  if (direct) return direct;
  return convertMarkdown(content.contentMarkdown ?? '', format);
}
