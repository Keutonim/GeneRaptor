import { useEffect, useRef, useState, type FormEvent, type CSSProperties } from 'react';
import { useI18n, type TranslationParams } from '../i18n';
import { tr } from '../i18n/runtime';

/**
 * TokenGate — the unlock screen (M4).
 *
 * The gate is not a tab and not a route: it is the whole window until the
 * shell mounts. It exchanges the one-time startup token (printed by the
 * server at boot) for a session cookie:
 *
 *   POST /api/auth/exchange  (Authorization: Bearer <token>)
 *     200 → session cookie set → reload → shell takes over
 *     401 → wrong token / already used / window expired
 *     429 → rate-limited (5 attempts / 15 s); the attempt spends nothing
 *
 * State machine (exactly four states, one input, one button — only the line
 * under the button changes):
 *   empty        first paint, no attempt yet — the footnote stays
 *   wrong        exchange → 401; the typed value stays so a typo can be fixed
 *   rate-limited exchange → 429; button disabled until the window opens,
 *                live countdown seeded from Retry-After (fallback 15 s)
 *   success      exchange → 200 — the gate unmounts, the shell takes over
 *
 * `initialState='wrong'` is used when the shell remounts the gate after a
 * mid-session 401 (server restart killed the cookie).
 *
 * An internal 'error' state (network down / unexpected status) renders like
 * 'wrong' but keeps its own message; it is defensive, not part of the design
 * contract.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Дизайн-токены: значения берутся из src/styles/tokens.css,
// поэтому экран блокировки следует за светлой и тёмной темой приложения.
// ─────────────────────────────────────────────────────────────────────────────
const COLOR = {
  bg: 'var(--bg)',
  card: 'var(--surface)',
  text: 'var(--text-primary)',
  textMuted: 'var(--text-secondary)',
  inputBg: 'var(--surface-raised)',
  accent: 'var(--accent)',
  accentStrong: 'var(--accent-ink)',
  danger: 'var(--danger)',
  dangerSoft: 'var(--surface-sunken)',
} as const;

const RADIUS = { card: 16, input: 8 } as const;

export type TokenGateState = 'empty' | 'wrong' | 'rate-limited' | 'success' | 'error';

/**
 * Seed seconds for the rate-limit countdown: a positive integer Retry-After
 * header, otherwise the server window (15 s).
 * Pure — экспортируется для tests/unit.
 */
export function parseRetryAfter(
  header: string | null,
  fallbackSeconds = 15,
): number {
  const parsed = Number.parseInt(String(header ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackSeconds;
}

/**
 * Map an exchange response onto the state machine. Pure — экспортируется
 * для tests/unit.
 */
export function deriveExchangeStatus(
  status: number,
  retryAfterHeader: string | null,
  translate: (key: string, params?: TranslationParams) => string = tr,
): {
  state: Exclude<TokenGateState, 'empty'>;
  message: string | null;
  retryAfterSec?: number;
} {
  if (status === 200) {
    return { state: 'success', message: null };
  }
  if (status === 401) {
    return {
      state: 'wrong',
      message: translate('token.wrong'),
    };
  }
  if (status === 429) {
    return {
      state: 'rate-limited',
      message: null,
      retryAfterSec: parseRetryAfter(retryAfterHeader),
    };
  }
  return {
    state: 'error',
    message: translate('token.serverError'),
  };
}

export default function TokenGate({
  initialState = 'empty',
}: {
  /** 'wrong' when the shell remounts the gate after a mid-session 401. */
  initialState?: 'empty' | 'wrong';
}) {
  const { t } = useI18n();
  const [tokenValue, setTokenValue] = useState('');
  const [gateState, setGateState] = useState<TokenGateState>(initialState);
  const [message, setMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Stagger-enter: включаем класс после первого paint (skip animation on load).
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Авто-фокус на инпуте после появления.
  useEffect(() => {
    if (mounted) inputRef.current?.focus();
  }, [mounted]);

  // Rate-limit countdown: тикает каждую секунду; на нуле окно открывается —
  // кнопка снова активна, состояние возвращается к empty.
  useEffect(() => {
    if (gateState !== 'rate-limited') return;
    if (countdown <= 0) {
      setGateState('empty');
      setMessage(null);
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [gateState, countdown]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading || gateState === 'rate-limited' || tokenValue.length === 0) return;

    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch('/api/auth/exchange', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenValue.trim()}` },
      });

      if (res.status === 200) {
        // Сессионная кука установлена сервером. Перезагружаемся — gate
        // размонтируется, оболочка приложения вступает в силу (success).
        setGateState('success');
        window.location.reload();
        return;
      }

      const derived = deriveExchangeStatus(res.status, res.headers.get('retry-after'), t);
      setGateState(derived.state);
      if (derived.state === 'rate-limited') {
        setCountdown(derived.retryAfterSec ?? 15);
      } else {
        setMessage(derived.message);
      }
      // wrong: набранное значение остаётся — можно исправить опечатку.
      inputRef.current?.focus();
    } catch {
      setGateState('error');
      setMessage(t('token.unavailable'));
    } finally {
      setLoading(false);
    }
  }

  const rateLimited = gateState === 'rate-limited';
  const buttonDisabled = loading || rateLimited || tokenValue.length === 0;
  const showError = (gateState === 'wrong' || gateState === 'error') && message !== null;

  return (
    <div style={styles.overlay}>
      {/* keyframes + stagger delay injection */}
      <style>{`
        @keyframes tg-fade-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .tg-item { opacity: 0; }
        .tg-mounted .tg-item {
          animation: tg-fade-up 0.42s cubic-bezier(0.2, 0, 0, 1) both;
        }
        .tg-mounted .tg-item:nth-child(1) { animation-delay: 0ms; }
        .tg-mounted .tg-item:nth-child(2) { animation-delay: 90ms; }
        .tg-mounted .tg-item:nth-child(3) { animation-delay: 180ms; }
        .tg-mounted .tg-item:nth-child(4) { animation-delay: 270ms; }
        .tg-mounted .tg-item:nth-child(5) { animation-delay: 360ms; }
        .tg-shake { animation: tg-shake 0.32s cubic-bezier(0.2, 0, 0, 1); }
        @keyframes tg-shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-4px); }
          75% { transform: translateX(4px); }
        }
      `}</style>

      <form
        onSubmit={handleSubmit}
        className={mounted ? 'tg-mounted' : undefined}
        style={styles.card}
        autoComplete="off"
      >
        {/* Brand mark + title */}
        <div className="tg-item" style={styles.header}>
          <div style={styles.brandDot} aria-hidden="true" />
          <h1 style={styles.title}>GeneRaptor</h1>
          <p style={styles.subtitle}>{t('token.subtitle')}</p>
        </div>

        {/* Input — min hit area 44px, radius 12 (concentric с card 20) */}
        <div className="tg-item" style={styles.inputWrap}>
          <input
            ref={inputRef}
            type="text"
            value={tokenValue}
            onChange={(e) => setTokenValue(e.target.value)}
            placeholder={t('token.placeholder')}
            autoComplete="off"
            disabled={loading}
            aria-label={t('token.label')}
            aria-invalid={showError}
            style={{
              ...styles.input,
              ...(showError ? styles.inputError : null),
            }}
          />
        </div>

        {/* Button — disabled while rate-limited countdown runs */}
        <div className="tg-item" style={styles.buttonWrap}>
          <button
            type="submit"
            disabled={buttonDisabled}
            style={{
              ...styles.button,
              ...(buttonDisabled ? styles.buttonDisabled : null),
            }}
          >
            {loading ? t('token.opening') : t('token.open')}
          </button>
        </div>

        {/* Line under the button — the only thing that changes between states */}
        <div
          className={`tg-item ${showError || rateLimited ? 'tg-shake' : ''}`}
          style={styles.statusWrap}
          aria-live="assertive"
        >
          {rateLimited ? (
            <p style={styles.statusText}>
              <span style={styles.statusDot} aria-hidden="true" />
              {t('token.rateLimited', { countdown })}
            </p>
          ) : showError ? (
            <p style={styles.statusText}>
              <span style={styles.statusDot} aria-hidden="true" />
              {message}
            </p>
          ) : null}
        </div>

        {/* Footnote — stays in every state */}
        <div className="tg-item" style={styles.footnoteWrap}>
          <p style={styles.footnote}>
            {t('token.footnote')}
          </p>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Стили. Inline CSSProperties — проект использует этот паттерн
// (src/app/AppShell.tsx).
// ─────────────────────────────────────────────────────────────────────────────
const styles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: COLOR.bg,
    WebkitFontSmoothing: 'antialiased',
    MozOsxFontSmoothing: 'grayscale',
    padding: 24,
    zIndex: 1000,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    border: '1px solid var(--border)',
    borderRadius: RADIUS.card,
    background: COLOR.card,
    padding: 32,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    marginBottom: 24,
  },
  brandDot: {
    width: 40,
    height: 40,
    borderRadius: 12,
    marginBottom: 16,
    background: COLOR.accent,
  },
  title: {
    margin: 0,
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: COLOR.text,
    textWrap: 'balance',
  },
  subtitle: {
    margin: '6px 0 0',
    fontSize: 14,
    color: COLOR.textMuted,
    textWrap: 'pretty',
  },
  inputWrap: {
    marginBottom: 12,
  },
  input: {
    width: '100%',
    minHeight: 44,
    padding: '12px 14px',
    fontSize: 16,
    fontFamily: 'var(--font-mono)',
    color: COLOR.text,
    background: COLOR.inputBg,
    border: 'none',
    borderRadius: RADIUS.input,
    outline: 'none',
    boxSizing: 'border-box',
    boxShadow: 'inset 0 0 0 1px var(--border)',
    transitionProperty: 'box-shadow',
    transitionDuration: '0.18s',
    transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  inputError: {
    boxShadow: `inset 0 0 0 1px ${COLOR.danger}`,
  },
  buttonWrap: {
    marginBottom: 4,
  },
  button: {
    width: '100%',
    minHeight: 44,
    padding: '12px 16px',
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--surface)',
    background: COLOR.accent,
    border: 'none',
    borderRadius: RADIUS.input,
    cursor: 'pointer',
    transitionProperty: 'transform, box-shadow, opacity',
    transitionDuration: '0.14s',
    transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
    boxShadow: 'none',
  },
  statusWrap: {
    minHeight: 20,
    marginTop: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: {
    margin: 0,
    fontSize: 13,
    color: COLOR.danger,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: COLOR.danger,
    flexShrink: 0,
  },
  footnoteWrap: {
    marginTop: 8,
  },
  footnote: {
    margin: 0,
    fontSize: 12,
    color: COLOR.textMuted,
    textAlign: 'center',
  },
};
