/**
 * One-time startup token gate (readiness P4).
 *
 * Lifecycle (D5, default ON):
 *   - Generated once per server process start from a CSPRNG (32 random bytes,
 *     base64url, 43 chars = 256 bits >= the 128-bit minimum).
 *   - Printed to CLI stdout once at boot; never stored in the DB, never
 *     logged again after boot, never reused across runs.
 *   - Accepted only inside a bounded acceptance window (15 min from issue)
 *     and invalidated by the first successful exchange (single-use). A second
 *     exchange with the same token fails — the e2e "exchange twice -> 401".
 *   - Restart => new process => new token; the old token is never valid again.
 *
 * Overrides:
 *   - GENERAPTOR_TOKEN (`--token <fixed>`): operator-fixed token. Not
 *     consumed by exchanges and not bounded by the window (multi-use).
 *   - GENERAPTOR_STARTUP_TOKEN: the launcher (start.mjs) generates a one-time
 *     token and hands it to the server process via env so the launcher can
 *     print the banner. Still one-time + window-bounded.
 *   - ACCESS_GATE_DISABLED (`--no-auth`): auth fully off (checked where the
 *     gate middleware lives, server/lib/auth.mjs).
 */
import crypto from 'crypto';

/** Acceptance window for the one-time token: 15 minutes (10-15 min). */
export const TOKEN_ACCEPTANCE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Generate a fresh startup token: 32 random bytes, base64url (43 chars).
 */
export function generateStartupToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Constant-time comparison of two token strings via SHA-256 digests
 * (fixed length) + timingSafeEqual. Hides the candidate/token lengths.
 */
function tokensEqual(candidate, expected) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create a token gate instance.
 *
 * @param {object} [options]
 * @param {string|null} [options.token] - explicit token; self-generated when null.
 * @param {boolean} [options.fixed] - fixed-token mode: multi-use, no window.
 * @param {number} [options.issuedAt] - epoch-ms issue time (window anchor).
 * @param {number} [options.windowMs] - acceptance window length (one-time mode).
 * @returns {{ token: string, fixed: boolean, exchange(candidate: string, now?: number): {ok: boolean} }}
 */
export function createTokenGate({
  token = null,
  fixed = false,
  issuedAt = Date.now(),
  windowMs = TOKEN_ACCEPTANCE_WINDOW_MS,
} = {}) {
  const activeToken = token ?? generateStartupToken();
  let consumed = false;

  return {
    token: activeToken,
    fixed,
    /**
     * Try to exchange a candidate token for a session.
     * A rate-limited caller simply never calls this, so a 429 spends nothing.
     *
     * @param {string} candidate
     * @param {number} [now] - epoch-ms clock (injectable for tests).
     * @returns {{ok: boolean}}
     */
    exchange(candidate, now = Date.now()) {
      if (typeof candidate !== 'string' || candidate.length === 0) return { ok: false };
      if (!tokensEqual(candidate, activeToken)) return { ok: false };
      if (fixed) return { ok: true };
      if (consumed) return { ok: false };
      if (now > issuedAt + windowMs) return { ok: false };
      consumed = true;
      return { ok: true };
    },
  };
}

/** Build the process gate from the current environment. */
function createGateFromEnv() {
  const fixedToken = process.env.GENERAPTOR_TOKEN?.trim();
  if (fixedToken) return createTokenGate({ token: fixedToken, fixed: true });
  const launcherToken = process.env.GENERAPTOR_STARTUP_TOKEN?.trim();
  if (launcherToken) return createTokenGate({ token: launcherToken });
  return createTokenGate();
}

/** Process-wide gate state (one token per process start). */
let gate = createGateFromEnv();

/** The active gate (singleton). */
export function getStartupTokenGate() {
  return gate;
}

/**
 * Replace the singleton gate. Test hook: pass a gate to inject, or nothing
 * to re-resolve from the current env.
 */
export function _setTokenGateForTests(next) {
  gate = next ?? createGateFromEnv();
}
