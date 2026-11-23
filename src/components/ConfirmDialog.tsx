/**
 * Confirmation dialog for a destructive action.
 *
 * The panel is opaque (`--surface`) and lives on its own layer above the app
 * (z-index 60), so it never reads as a transparent block inside the page
 * flow. Escape, a click on the backdrop and the cancel button all close it;
 * Tab is trapped inside the panel and the focus lands on the primary action
 * when it opens.
 */
import React, { useEffect, useId, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import '../styles/confirm.css';

export interface ConfirmDialogProps {
  /** Short question that names the action. */
  title: string;
  /** One sentence that names what exactly is affected. */
  text: string;
  /** Label of the destructive action. */
  confirmLabel: string;
  /** Label of the quiet second action. */
  cancelLabel: string;
  /** The destructive action is running — the confirm button is blocked. */
  busy?: boolean;
  /** Extra class on the panel (keeps the history anchor). */
  className?: string;
  /** Stable test anchor of the panel. */
  testId?: string;
  /** Stable test anchor of the confirm button. */
  confirmTestId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  text,
  confirmLabel,
  cancelLabel,
  busy = false,
  className,
  testId,
  confirmTestId,
  onConfirm,
  onCancel,
}) => {
  const titleId = useId();
  const textId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // The dialog is the only thing on screen — the focus goes to the action.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Escape is listened for on the document, not on the panel: while the
  // delete request is running the confirm button is disabled and the browser
  // drops the focus from it — the dialog must still close on Escape.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && panel.contains(active);
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="confirm__overlay"
      onClick={(event) => {
        // A click on the backdrop closes; a click inside the panel does not.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className={className ? `confirm__panel ${className}` : 'confirm__panel'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        data-testid={testId}
        ref={panelRef}
        onKeyDown={handleKeyDown}
      >
        <div className="confirm__head">
          <TriangleAlert size={18} strokeWidth={1.5} className="confirm__icon" aria-hidden="true" />
          <h2 className="confirm__title" id={titleId}>
            {title}
          </h2>
        </div>
        <p className="confirm__text" id={textId}>
          {text}
        </p>
        <div className="confirm__actions">
          <button type="button" className="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="button button--danger-fill"
            data-testid={confirmTestId}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
