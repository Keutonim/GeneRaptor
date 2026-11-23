import { useEffect, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n';
import TokenGate, { parseRetryAfter } from './TokenGate';
import {
  parseTokenFromHash,
  stripTokenFromLocation,
  exchangeStartupToken,
  fetchAuthStatus,
} from '../lib/session';

/**
 * SessionGate — the passwordless entry screen.
 *
 * The launcher opens the app with the one-time token in the URL fragment.
 * This screen exchanges it for the session cookie WITHOUT a single input
 * field and without a page reload:
 *
 *   fragment token → GET /api/auth/status (a session may already exist)
 *                  → POST /api/auth/exchange (exactly one automatic attempt)
 *     200 → cookie set → replaceState drops the fragment → shell mounts
 *     401 → drop the fragment (a dead token is not kept in the address),
 *           re-probe the status (another tab may have won the race),
 *           otherwise the "startup link is stale" hint
 *     429 → keep the fragment (the token is alive, the limit spends nothing),
 *           countdown from Retry-After, then a BOUNDED number of automatic
 *           retries; after the cap the hint is static and only the
 *           manual Refresh button retries
 *     5xx / network → keep the fragment, "server unavailable" hint + Refresh
 *
 * No fragment and no session → the "restart the studio" hint. The manual
 * TokenGate survives ONLY as a secondary fallback behind a small link
 * — it is never the main path.
 *
 * A mid-session 401 remounts this screen with reason='session-expired' and a
 * fresh key: the fragment is gone by then, so the hint explains the restart
 * and «Refresh» recovers the tab through the browser-wide cookie.
 *
 * Cancellation: every effect run owns a LOCAL `cancelled` flag in
 * its closure. React.StrictMode (src/main.tsx) mounts effects twice in dev:
 * the simulated unmount cancels the first flow and the remount starts exactly
 * one live flow, so the automatic exchange happens exactly ONCE per mount.
 * A shared resettable ref would let the second effect run
 * re-arm the first flow and produce a second exchange.
 */

type Phase = 'exchanging' | 'hint' | 'manual';
type HintKind = 'no-token' | 'rejected' | 'rate-limited' | 'unavailable' | 'expired';

/**
 * Cap on AUTOMATIC retries after a 429. The server limiter allows
 * 5 attempts / 15 s / IP; one initial exchange plus two automatic retries
 * spends 3 of them and leaves headroom for a second tab or a manual entry.
 * An unbounded countdown loop would keep the limiter hot forever and lock
 * the owner out of their own studio (login DoS). After the cap the hint is
 * static and only the manual Refresh button retries.
 */
export const MAX_AUTO_RETRIES = 2;

const HINT_KEY: Record<HintKind, string> = {
  'no-token': 'session.hint.noToken',
  rejected: 'session.hint.rejected',
  'rate-limited': 'session.hint.rateLimited',
  unavailable: 'session.hint.unavailable',
  expired: 'session.hint.expired',
};

/**
 * T-13: hint key for the rate-limited state. Below the auto-retry cap the
 * hint counts down to the next automatic attempt. At/above the cap no timer
 * runs, so a countdown would freeze at its last value (including 0) — the
 * hint switches to a STATIC copy that points at the manual Refresh button.
 */
export function rateLimitedHintKey(autoRetries: number): string {
  return autoRetries >= MAX_AUTO_RETRIES
    ? 'session.hint.rateLimitedCap'
    : 'session.hint.rateLimited';
}

export default function SessionGate({
  reason,
  onAuthenticated,
}: {
  reason: 'boot' | 'session-expired';
  onAuthenticated: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('exchanging');
  const [hintKind, setHintKind] = useState<HintKind>('no-token');
  const [countdown, setCountdown] = useState(0);
  // Bumping `attempt` re-runs the boot effect with a fresh cancellation scope:
  // the deliberate retries (countdown expiry, manual Refresh) go through it.
  const [attempt, setAttempt] = useState(0);
  const [autoRetries, setAutoRetries] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const token = parseTokenFromHash(window.location.hash);
      if (!token) {
        setHintKind(reason === 'session-expired' ? 'expired' : 'no-token');
        setPhase('hint');
        return;
      }
      setPhase('exchanging');
      // A session may already exist (another tab got there first) — then the
      // token is NOT spent.
      try {
        if (await fetchAuthStatus()) {
          if (cancelled) return;
          stripTokenFromLocation();
          onAuthenticated();
          return;
        }
      } catch {
        /* server unreachable — try the exchange below */
      }
      // A cancelled flow (StrictMode's simulated unmount) must not spend the
      // token: the check belongs BEFORE the exchange, not only after it.
      if (cancelled) return;
      try {
        const res = await exchangeStartupToken(token);
        if (cancelled) return;
        if (res.status === 200) {
          stripTokenFromLocation();
          onAuthenticated();
          return;
        }
        if (res.status === 401) {
          stripTokenFromLocation(); // a dead token is not kept in the address
          try {
            if (await fetchAuthStatus()) {
              if (!cancelled) onAuthenticated();
              return;
            }
          } catch {
            /* the hint below */
          }
          if (cancelled) return;
          setHintKind('rejected');
          setPhase('hint');
          return;
        }
        if (res.status === 429) {
          // Keep the fragment: the token is alive, the limit spends nothing.
          setCountdown(parseRetryAfter(res.headers.get('retry-after')));
          setHintKind('rate-limited');
          setPhase('hint');
          return;
        }
        setHintKind('unavailable'); // 5xx and alike — repeatable, keep the fragment
        setPhase('hint');
      } catch {
        if (cancelled) return;
        setHintKind('unavailable'); // network failure — keep the fragment
        setPhase('hint');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [reason, onAuthenticated, attempt]);

  // 429 countdown: at zero the window is open again — retry through a fresh
  // effect run, but only MAX_AUTO_RETRIES times. After the cap the
  // hint stays static: no timer, no background exchange, manual Refresh only.
  useEffect(() => {
    if (phase !== 'hint' || hintKind !== 'rate-limited') return;
    if (autoRetries >= MAX_AUTO_RETRIES) return;
    if (countdown <= 0) return;
    // The retry decision lives INSIDE the tick: it fires exactly once per
    // countdown expiry, so an autoRetries re-render cannot double-trigger it.
    const id = setTimeout(() => {
      if (countdown - 1 <= 0) {
        setCountdown(0);
        setAutoRetries((a) => a + 1);
        setAttempt((a) => a + 1);
      } else {
        setCountdown((c) => c - 1);
      }
    }, 1000);
    return () => clearTimeout(id);
  }, [phase, hintKind, countdown, autoRetries]);

  async function handleRefresh() {
    if (parseTokenFromHash(window.location.hash)) {
      // A user-initiated retry takes control back: the automatic budget resets.
      setAutoRetries(0);
      setAttempt((a) => a + 1);
      return;
    }
    try {
      if (await fetchAuthStatus()) {
        onAuthenticated();
        return;
      }
    } catch {
      /* stay on the hint */
    }
    setPhase('hint');
  }

  // The manual fallback is one-way until success or a browser reload.
  if (phase === 'manual') return <TokenGate initialState="empty" />;

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.brandDot} aria-hidden="true" />
        <h1 style={styles.title}>GeneRaptor</h1>
        {phase === 'exchanging' ? (
          <p data-testid="session-exchanging" style={styles.exchanging} aria-live="polite">
            {t('session.exchanging')}
          </p>
        ) : (
          <div data-testid="session-hint" style={styles.hint} aria-live="polite">
            <h2 style={styles.hintTitle}>{t('session.hint.title')}</h2>
            <p style={styles.hintText}>
              {hintKind === 'rate-limited'
                ? t(rateLimitedHintKey(autoRetries), { countdown })
                : t(HINT_KEY[hintKind])}
            </p>
            <button type="button" style={styles.button} onClick={() => void handleRefresh()}>
              {t('session.refresh')}
            </button>
            <button type="button" style={styles.link} onClick={() => setPhase('manual')}>
              {t('session.manualToggle')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles: inline CSSProperties + the design tokens of src/styles/tokens.css,
// the same pattern as TokenGate.tsx (the screen follows both themes).
// ─────────────────────────────────────────────────────────────────────────────
const styles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    WebkitFontSmoothing: 'antialiased',
    MozOsxFontSmoothing: 'grayscale',
    padding: 24,
    zIndex: 1000,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    border: '1px solid var(--border)',
    borderRadius: 16,
    background: 'var(--surface)',
    padding: 32,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  brandDot: {
    width: 40,
    height: 40,
    borderRadius: 12,
    marginBottom: 16,
    background: 'var(--accent)',
  },
  title: {
    margin: 0,
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: 'var(--text-primary)',
    textWrap: 'balance',
  },
  exchanging: {
    margin: '16px 0 0',
    fontSize: 14,
    color: 'var(--text-secondary)',
  },
  hint: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '100%',
  },
  hintTitle: {
    margin: '16px 0 0',
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  hintText: {
    margin: '8px 0 20px',
    fontSize: 14,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    textWrap: 'pretty',
  },
  button: {
    width: '100%',
    minHeight: 44,
    padding: '12px 16px',
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--surface)',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  link: {
    marginTop: 12,
    padding: '4px 8px',
    fontSize: 12,
    color: 'var(--text-secondary)',
    background: 'transparent',
    border: 'none',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
};