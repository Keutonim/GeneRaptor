/**
 * API path classification (SEC-01).
 *
 * Express matches mount paths CASE-INSENSITIVELY: `app.use('/api', router)`
 * also serves `/API/...` and `/Api/...`. Any security decision made on the
 * raw request path must therefore use the same case-insensitive rule — the
 * previous `req.path.startsWith('/api/')` check let the whole API through on
 * a different casing (authentication bypass, AppSec SEC-01).
 *
 * The helpers live in their own module so that both the access gate
 * (server/lib/auth.mjs) and the Express app (server/express-app.mjs) classify
 * paths with exactly ONE rule set.
 */

/**
 * Public API paths — reachable WITHOUT a session cookie.
 *
 * Exact (case-insensitive) paths only: a prefix exemption such as `/api/auth`
 * would let `/api/auth/../settings` slip through the gate, so the public
 * surface is an allow-list of whole paths, never a prefix.
 */
export const PUBLIC_API_PATHS = Object.freeze([
  '/api/health',
  '/api/auth/exchange',
  '/api/auth/status',
  '/api/auth/logout',
]);

const PUBLIC_API_PATH_SET = new Set(PUBLIC_API_PATHS);

/**
 * The pathname of the request, independent of the mount point of the
 * middleware. `req.path` is RELATIVE to the mount point (inside
 * `app.use('/api', requireGate)` it is `/articles`), so it must not be used
 * for a path-based security decision. `req.originalUrl` is the untouched
 * request target; the query string is stripped.
 *
 * @param {{ originalUrl?: string, url?: string }} req
 * @returns {string}
 */
export function requestPathname(req) {
  const raw = typeof req?.originalUrl === 'string' && req.originalUrl ? req.originalUrl : (req?.url ?? '');
  const queryAt = raw.indexOf('?');
  return queryAt >= 0 ? raw.slice(0, queryAt) : raw;
}

/**
 * Is the path part of the API surface at all (any casing)?
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isApiPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  const normalized = pathname.toLowerCase();
  return normalized === '/api' || normalized.startsWith('/api/');
}

/**
 * Is this request part of the PROTECTED API surface?
 *
 * The comparison is case-INSENSITIVE on purpose: Express matches mount paths
 * case-insensitively (`app.use('/api', articlesRouter)`), so `/API/articles`
 * reaches the very same handler as `/api/articles`. A case-sensitive
 * `startsWith('/api/')` check therefore let the whole API through on a
 * different casing — the authentication bypass fixed in SEC-01.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isProtectedApiPath(pathname) {
  if (!isApiPath(pathname)) return false;
  return !PUBLIC_API_PATH_SET.has(pathname.toLowerCase());
}
