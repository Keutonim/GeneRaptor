/**
 * Auth router — token exchange / status / logout for the session gate (M4).
 *
 * Mount order in express-app.mjs (CRITICAL):
 *   1. cookie-parser
 *   2. healthRouter (public, before gate)
 *   3. authRouter (exchange/status/logout, before gate)
 *   4. requireGate
 *   5. everything else
 *
 * Security:
 *   - R-04: in-memory sliding-window rate limit on exchange (5 attempts / 15s / IP).
 *   - R-05: identical response shape for success and failure (constant work).
 *   - G8: logout clears the cookie with the exact path used at exchange ('/').
 *   - The startup token travels in `Authorization: Bearer <token>` exactly
 * once; everything else rides the session cookie.
 */
import { Router } from 'express';
import {
  GATE_COOKIE_NAME,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW,
  createGateToken,
  resolveGateKey,
  resolveSessionTtlMs,
  verifyGateToken,
} from '../lib/auth.mjs';
import { getStartupTokenGate } from '../lib/startup-token.mjs';

export const authRouter = Router();

// --- Startup validation (fail-closed) --------------------------------------
// Surface TTL misconfiguration as a boot error rather than a runtime 500.
// The signing key needs no env: absent keys resolve to a per-process random.
resolveSessionTtlMs();
resolveGateKey();

// --- Rate limit (in-memory sliding window, per IP) -------------------------
/**
 * Map<ip, number[]> of recent exchange-attempt timestamps. Pruned on every
 * check. In-memory is sufficient — the app is a single local process.
 */
const exchangeAttempts = new Map();

/**
 * True if the IP has exceeded LOGIN_RATE_LIMIT attempts within LOGIN_RATE_WINDOW.
 * Prunes stale entries as a side effect.
 */
function isRateLimited(ip) {
  const now = Date.now();
  const cutoff = now - LOGIN_RATE_WINDOW;
  const recent = (exchangeAttempts.get(ip) ?? []).filter((ts) => ts > cutoff);
  exchangeAttempts.set(ip, recent);
  return recent.length >= LOGIN_RATE_LIMIT;
}

/** Record an exchange-attempt timestamp for the IP. */
function recordAttempt(ip) {
  const now = Date.now();
  const list = exchangeAttempts.get(ip) ?? [];
  list.push(now);
  exchangeAttempts.set(ip, list);
}

/** Extract the bearer credential from an Authorization header. */
function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Cookie options for the session cookie. Secure only behind TLS.
 * httpOnly blocks XSS theft; SameSite=Lax blocks cross-site POST CSRF.
 * `session` TTL omits Max-Age entirely (browser-session cookie).
 *
 * `secure` is driven by COOKIE_SECURE (default: follows NODE_ENV). This lets
 * a bare-IP HTTP localhost deploy keep the cookie working, while an HTTPS
 * deploy keeps it true.
 */
function isCookieSecure() {
  const raw = (process.env.COOKIE_SECURE ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return process.env.NODE_ENV === 'production';
}

function gateCookieOptions() {
  const ttlMs = resolveSessionTtlMs();
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isCookieSecure(),
    path: '/',
    ...(ttlMs != null ? { maxAge: ttlMs } : {}),
  };
}

// --- POST /api/auth/exchange ------------------------------------------------
// One-time startup token -> session cookie. Single use: the gate consumes the
// token on success; a repeat exchange returns 401 (readiness P4). A
// rate-limited attempt is rejected BEFORE the gate runs, so 429 spends nothing.
authRouter.post('/exchange', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    res.set('Retry-After', String(Math.ceil(LOGIN_RATE_WINDOW / 1000)));
    return res.status(429).json({ error: 'Слишком много попыток' });
  }

  const candidate = parseBearer(req.headers?.authorization);

  // Constant-time-ish: always compute the session token so both success and
  // failure branches do the same amount of work (G2). On failure we discard it.
  const token = createGateToken();
  const result = getStartupTokenGate().exchange(candidate);

  recordAttempt(ip);

  if (!result.ok) {
    console.warn(`[AUTH] token exchange failed from ${ip}`);
    return res.status(401).json({ error: 'Токен не принят' });
  }

  res.cookie(GATE_COOKIE_NAME, token, gateCookieOptions());
  console.log(`[AUTH] token exchange ok from ${ip}`);
  return res.status(200).json({ ok: true });
});

// --- GET /api/auth/status --------------------------------------------------
// Returns whether the current request is authorized: a valid session cookie,
// or the access gate being disabled altogether. Mounted before the gate so the
// React shell can probe it on boot without a 401 storm.
authRouter.get('/status', (req, res) => {
  // Gate disabled (--no-auth) means every caller is authorized —
  // the client boot probe must see the same truth the middleware enforces.
  const gateDisabled = process.env.ACCESS_GATE_DISABLED === 'true';
  const cookie = req.cookies?.[GATE_COOKIE_NAME];
  const authenticated = gateDisabled || Boolean(cookie && verifyGateToken(cookie));
  return res.status(200).json({ authenticated });
});

// --- POST /api/auth/logout -------------------------------------------------
// Must use the SAME path option as the exchange setCookie, otherwise the
// browser won't match the cookie to clear it (G8).
authRouter.post('/logout', (req, res) => {
  res.clearCookie(GATE_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isCookieSecure(),
    path: '/',
  });
  return res.status(200).json({ ok: true });
});

// Exposed for unit tests so the in-memory limiter can be reset between cases.
export function _resetLoginRateLimit() {
  exchangeAttempts.clear();
}
