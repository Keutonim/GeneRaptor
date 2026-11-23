/**
 * One-time token delivery via URL fragment + session probe helpers.
 *
 * The launcher opens `<uiUrl>/#token=<value>`. A fragment is never serialized
 * into the request line nor into Referer, so the token cannot reach the HTTP
 * logger; after the exchange the fragment is removed from the address AND
 * from the history entry (replaceState).
 *
 * The token is accepted ONLY from the own address fragment — never from the
 * query, never from a request body, never from another origin.
 */

/** Strict `#token=<base64url>`; 1..512 chars, no spaces, no second fragment. */
const TOKEN_HASH_RE = /^#token=([A-Za-z0-9_-]{1,512})$/;

/** The startup token from the own address fragment, or null. */
export function parseTokenFromHash(hash: string): string | null {
  const m = TOKEN_HASH_RE.exec(String(hash ?? ''));
  return m ? m[1] : null;
}

/**
 * Drop the fragment from the address bar and from the current history entry.
 * Only the current same-origin pathname + search are used — no redirect
 * parameter is ever honoured (open-redirect boundary).
 */
export function stripTokenFromLocation(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/** Exchange the one-time token for the session cookie (single automatic attempt). */
export function exchangeStartupToken(token: string): Promise<Response> {
  return fetch('/api/auth/exchange', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Boot probe: the server ALWAYS answers 200 `{authenticated}` — the truth is
 * in the body, never in the HTTP status.
 * A network failure propagates: the caller owns the fail-open fallback.
 */
export async function fetchAuthStatus(): Promise<boolean> {
  const res = await fetch('/api/auth/status');
  if (!res.ok) return false;
  const body = (await res.json().catch(() => null)) as { authenticated?: unknown } | null;
  return body?.authenticated === true;
}