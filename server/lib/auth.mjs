/**
 * Session gate — HMAC-signed cookie authentication for token-exchanged
 * sessions (M4).
 *
 * The browser exchanges the one-time startup token (server/lib/startup-token.mjs)
 * at POST /api/auth/exchange and receives a `generaptor_auth` session cookie. The
 * cookie payload is `exp.signature` where signature is HMAC-SHA256(exp, key).
 * No PII, no DB lookup — stateless verification.
 *
 * Security properties:
 *   - Session TTL configurable via --token-ttl / GENERAPTOR_TOKEN_TTL
 *     (session|24h|7d|30d, default 24h — replaces the old 30 d cookie).
 *   - Signing key: explicit env key (ACCESS_GATE_HMAC_KEY / JWT_SECRET) when
 *     provided (placeholders rejected, fail-closed); otherwise a per-process
 *     random key — a restart invalidates every session (readiness P4).
 *   - All failure branches return the same 401 JSON — no oracle.
 *   - WS keeps the cookie verification path (verifyWsConnection); no second
 * auth mechanism.
 *   - The SPA shell (non-/api routes) is public: the React TokenGate is the
 *     client-side lock, every /api call without a session returns 401.
 */
import crypto from 'crypto';

import { isProtectedApiPath, requestPathname } from './api-paths.mjs';

/** Cookie name. Opaque — does not reveal purpose. */
export const GATE_COOKIE_NAME = 'generaptor_auth';

/** Session lifetime values for --token-ttl / GENERAPTOR_TOKEN_TTL. */
const SESSION_TTL_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve the session TTL. `null` means a browser-session cookie (no
 * Max-Age; the server-side exp still uses the 24 h bound). Throws on an
 * invalid explicit value so misconfiguration surfaces at boot.
 *
 * @param {string} [raw] - explicit value (defaults to env GENERAPTOR_TOKEN_TTL).
 * @returns {number|null} TTL in ms, or null for a browser-session cookie.
 */
export function resolveSessionTtlMs(raw = process.env.GENERAPTOR_TOKEN_TTL) {
  const value = (raw ?? '').trim().toLowerCase() || '24h';
  if (value === 'session') return null;
  if (!Object.prototype.hasOwnProperty.call(SESSION_TTL_MS, value)) {
    throw new Error(
      `GENERAPTOR_TOKEN_TTL must be one of session|24h|7d|30d (got "${value}")`
    );
  }
  return SESSION_TTL_MS[value];
}

/** Login/exchange attempt cap before rate-limit kicks in (per IP, per window). */
export const LOGIN_RATE_LIMIT = 5;
/** Rate-limit window in ms. */
export const LOGIN_RATE_WINDOW = 15 * 1000;

/**
 * Placeholder secret patterns that must NEVER reach production.
 * Mirrors the `isConfigured` regex in health.mjs plus the legacy dev value.
 */
const PLACEHOLDER_SECRET_RE =
  /^change_me|^put_.*_here$|^your_.*$|^local_dev_jwt_secret_change_in_production$/;

function isPlaceholderSecret(value) {
  if (!value || typeof value !== 'string') return true;
  return PLACEHOLDER_SECRET_RE.test(value.trim());
}

/** Lazily created per-process signing key (restart kills all sessions). */
let processSessionKey = null;

/**
 * Resolve the HMAC signing key. ACCESS_GATE_HMAC_KEY wins; JWT_SECRET is the
 * fallback so existing single-secret deploys keep working. With neither set,
 * a random key is generated once per process — the single-user local-tool
 * default; sessions are then in-memory-equivalent (die on restart).
 * Placeholder values throw (fail-closed).
 */
export function resolveGateKey() {
  const explicit = process.env.ACCESS_GATE_HMAC_KEY?.trim();
  if (explicit) {
    if (isPlaceholderSecret(explicit)) {
      throw new Error(
        'ACCESS_GATE_HMAC_KEY is a placeholder value — set a strong key or unset it to use a per-process key'
      );
    }
    return explicit;
  }
  const fallback = process.env.JWT_SECRET?.trim();
  if (fallback) {
    if (isPlaceholderSecret(fallback)) {
      throw new Error(
        'JWT_SECRET is a placeholder value — set a strong key or unset it to use a per-process key'
      );
    }
    return fallback;
  }
  if (!processSessionKey) {
    processSessionKey = crypto.randomBytes(64).toString('hex');
  }
  return processSessionKey;
}

/**
 * Create a signed session token: `${exp}.${hmac}` where exp is epoch-ms and
 * hmac is the hex HMAC-SHA256 of exp signed with the gate key.
 *
 * @param {number} [expOverride] - epoch-ms expiry; defaults to now + session TTL.
 * @param {string} [keyOverride] - signing key; defaults to resolveGateKey().
 * @returns {string} the `exp.signature` token to store in the cookie.
 */
export function createGateToken(expOverride, keyOverride) {
  const key = keyOverride ?? resolveGateKey();
  const ttlMs = resolveSessionTtlMs() ?? SESSION_TTL_MS['24h'];
  const exp = expOverride ?? Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', key).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

/**
 * Constant-time comparison of two equal-length hex strings. Returns false on
 * length mismatch without throwing — HMAC digests have a fixed length so the
 * only legitimate inputs match.
 */
function safeEqualHex(a, b) {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify a session token: parse `exp.signature`, recompute the HMAC over exp,
 * compare via timingSafeEqual, and ensure exp is still in the future.
 *
 * @param {string} token - the raw cookie value.
 * @param {string} [keyOverride] - signing key; defaults to resolveGateKey().
 * @returns {boolean} true iff the token is well-formed, signature matches, and not expired.
 */
export function verifyGateToken(token, keyOverride) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // exp must be all digits (epoch ms).
  if (!/^\d+$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;
  const key = keyOverride ?? resolveGateKey();
  const expectedSig = crypto.createHmac('sha256', key).update(expStr).digest('hex');
  if (!safeEqualHex(sig, expectedSig)) return false;
  return exp > Date.now();
}

/**
 * Public API paths — reachable WITHOUT a session cookie.
 *
 * Exact (case-insensitive) paths only: a prefix exemption such as
 * `/api/auth` would let `/api/auth/../settings` slip through the gate, so the
 * public surface is an allow-list of whole paths, never a prefix.
 *
 * The classification lives in server/lib/api-paths.mjs so that the gate and
 * the Express app share exactly one rule set (SEC-01).
 */

/**
 * Gate middleware. Mounted AFTER cookie-parser and AFTER the public routes
 * (health, auth exchange/status/logout). Scope (M4): every /api/* request
 * requires a valid `generaptor_auth` session cookie; non-/api GETs (SPA shell,
 * static assets) pass through so the React TokenGate can load — it is the
 * client-side full-screen lock.
 *
 * Honours ACCESS_GATE_DISABLED=true (--no-auth / unit test harnesses).
 */
export function requireGate(req, res, next) {
  if (process.env.ACCESS_GATE_DISABLED === 'true') return next();
  if (!isProtectedApiPath(requestPathname(req))) return next();

  const cookie = req.cookies?.[GATE_COOKIE_NAME];
  if (cookie && verifyGateToken(cookie)) return next();

  return res.status(401).json({ error: 'Требуется авторизация' });
}

/**
 * Parse the cookie header of a raw HTTP request (the WebSocket upgrade path
 * bypasses Express/cookie-parser). Returns a map of name -> value.
 */
function parseRawCookies(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * WebSocket handshake verifier. Used as the `verifyClient` option of
 * WebSocketServer — runs before the upgrade completes, so an unauthorized
 * client never gets a connection. Returns true iff a valid session cookie is
 * present on the upgrade request (cookie path only — keeps this
 * the single WS auth mechanism).
 *
 * @param {{ req: import('http').IncomingMessage }} info - ws handshake info.
 * @returns {boolean}
 */
export function verifyWsConnection(info) {
  if (process.env.ACCESS_GATE_DISABLED === 'true') return true;
  const cookies = parseRawCookies(info?.req?.headers?.cookie);
  const token = cookies[GATE_COOKIE_NAME];
  if (!token) return false;
  return verifyGateToken(token);
}

// Back-compat: legacy import name from the previous no-op stub. The gate is now
// enforced via requireGate; requireAuth is kept as an alias so existing call
// sites keep resolving until they are migrated.
export const requireAuth = requireGate;
