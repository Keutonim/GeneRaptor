/**
 * M6 — хук экспорта статьи.
 *
 * Три действия копирования (HTML / TXT / Markdown) и состояние «Скопировано».
 * M8 владеет финальным набором контролов экспорта и именами файлов — здесь
 * только переиспользуемая логика копирования.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { exportPayload, type ExportFormat, type ExportableContent } from './exportContent';

export type { ExportFormat, ExportableContent };

export interface ArticleExportActions {
  copied: ExportFormat | null;
  copy: (format: ExportFormat) => Promise<void>;
}

export function useArticleExport(content: ExportableContent | null): ArticleExportActions {
  const [copied, setCopied] = useState<ExportFormat | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    async (format: ExportFormat) => {
      const ok = await copyToClipboard(exportPayload(content, format));
      if (!ok) return;
      setCopied(format);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(null), 1500);
    },
    [content],
  );

  return { copied, copy };
}
