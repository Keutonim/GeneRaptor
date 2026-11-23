/**
 * SEC-03 (CWE-346 / CWE-601) — Host and Origin validation.
 *
 * Threat model (AppSec round, docs/security.md §2): the server accepted ANY
 * `Host` header and ANY `Origin` on the API surface. A browser that resolves a
 * hostile name to 127.0.0.1 (DNS rebinding) or a page on another origin that
 * sends a state-changing request was processed by the server exactly like a
 * request from the local UI.
 *
 * Rules enforced here:
 *   1. the `Host` header must name one of the server's OWN hosts — the
 *      loopback names (127.0.0.1, localhost, ::1) plus the configured bind
 *      host (and, for a wildcard bind, the machine's own interface
 *      addresses) — and the port it names must be the port the server
 *      ACTUALLY listens on (taken from the request, never from the header);
 *   2. a state-changing request (POST/PUT/PATCH/DELETE under /api/*) that
 *      carries an `Origin` (or, when it is absent, a `Referer`) must come
 *      from the server's own origin — the origin the UI is served from plus
 *      the configured CORS origin; anything else is refused;
 *   3. a MISSING origin is allowed — a command-line client is not a browser
 *      and must keep working;
 *   4. the WebSocket upgrade obeys the same origin rule (the upgrade request
 *      bypasses the Express middleware, so the check happens at handshake
 *      time).
 *
 * No secret values are involved here — only host names, ports and origins.
 */
import os from 'node:os';

// The launcher hands the dev-UI-origin marker over as an argv flag.
// data-dir.mjs owns the launcher-argv extraction (next to --data-dir); the
// ACCEPTANCE rules for the value live here, in devUiOrigins — one decision,
// one place.
import { resolveDevUiOrigin } from './data-dir.mjs';

/** Host names that always belong to this server. */
const LOOPBACK_HOSTNAMES = Object.freeze(['127.0.0.1', 'localhost', '::1']);

/** Bind hosts that mean "every interface". */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*']);

/** Methods that change state and therefore need an origin check. */
export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Splits a `Host` header into hostname and port.
 *
 * @param {string} raw - the raw header value.
 * @returns {{hostname: string, port: number|null}|null} null when the header
 *   is missing or malformed.
 */
export function parseHostHeader(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  // IPv6 literal — [::1] or [::1]:8787
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { hostname: bracketed[1].toLowerCase(), port: bracketed[2] ? Number(bracketed[2]) : null };
  }

  const parts = value.split(':');
  if (parts.length === 1) return { hostname: parts[0].toLowerCase(), port: null };
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { hostname: parts[0].toLowerCase(), port: Number(parts[1]) };
  }
  // A bare IPv6 address without brackets (or anything else) is malformed.
  return null;
}

/** True for a bind host that means "every interface". */
export function isWildcardBind(host) {
  return WILDCARD_BIND_HOSTS.has(String(host ?? '').trim().toLowerCase());
}

/**
 * The host names this server answers to.
 *
 * @param {string} [bindHost] - the configured bind host (GENERAPTOR_HOST).
 * @returns {Set<string>} lower-cased host names.
 */
export function ownHostnames(bindHost) {
  const set = new Set(LOOPBACK_HOSTNAMES);
  const host = String(bindHost ?? '').trim().toLowerCase();
  if (host && !isWildcardBind(host)) {
    set.add(host);
    return set;
  }
  // A wildcard bind means the server answers on every interface — its own
  // interface addresses are then part of "the server's own hosts".
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      const address = String(entry?.address || '').split('%')[0].toLowerCase();
      if (address) set.add(address);
    }
  }
  return set;
}

/** The port a request without an explicit port is assumed to use. */
function defaultPort(protocol) {
  return String(protocol || '').toLowerCase() === 'https' ? 443 : 80;
}

/**
 * Checks the `Host` header against the server's own hosts AND the port the
 * server actually listens on.
 *
 * @param {string} hostHeader - the raw header value.
 * @param {number|string} actualPort - the port the server listens on.
 * @param {object} [options]
 * @param {Set<string>} [options.hostnames] - pre-computed own host names.
 * @param {string} [options.protocol] - request protocol ('http' | 'https').
 * @returns {boolean}
 */
export function isAllowedHostHeader(hostHeader, actualPort, options = {}) {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) return false;
  const hostnames = options.hostnames ?? ownHostnames(options.bindHost);
  if (!hostnames.has(parsed.hostname)) return false;
  const port = parsed.port ?? defaultPort(options.protocol);
  return Number(port) === Number(actualPort);
}

/**
 * The origin of a URL string (`scheme://host[:port]`), lower-cased.
 *
 * @param {string} value
 * @returns {string|null} null when the value is not a URL.
 */
export function originOf(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The loopback alias pair. EXACTLY one alias per origin —
 * 127.0.0.1 <-> localhost. '::1' is deliberately absent (director decision):
 * the dev server binds 127.0.0.1, so a third spelling would be extra trust
 * without a need.
 */
const LOOPBACK_ALIAS_BY_HOST = new Map([
  ['127.0.0.1', 'localhost'],
  ['localhost', '127.0.0.1'],
]);

/** Hosts a dev-UI-origin marker may name (acceptance is still fail-closed). */
const DEV_UI_ORIGIN_HOSTNAMES = new Set(LOOPBACK_HOSTNAMES);

/**
 * SEC-03 stays strict: the origins a dev-UI-origin marker adds.
 *
 * In the dev topology the UI lives on the Vite port and the browser may open
 * EITHER loopback spelling of it (http://localhost:<uiPort> or
 * http://127.0.0.1:<uiPort>). They name the SAME machine and the SAME port —
 * the same application — so both are the UI's own origin. The marker is a
 * TOPOLOGY fact handed over by the launcher (`--dev-ui-origin`), never a
 * NODE_ENV guess: the owner's .env says NODE_ENV=production while the launcher
 * still starts Vite.
 *
 * Acceptance is fail-closed — ALL of these must hold, otherwise [] is returned
 * and the allowed set stays unchanged:
 *   - exactly ONE origin (a list, a wildcard, whitespace, 'null' → ignored);
 *   - an http/https scheme (preserved in the alias);
 *   - a loopback host (127.0.0.1 / localhost / ::1);
 *   - an EXPLICIT port (no implicit 80/443 — "any loopback port" is never allowed);
 *   - nothing but the authority (a path, query, fragment or credentials → ignored).
 *
 * This is NOT a relaxation for foreign origins: only the two loopback spellings
 * of the SAME port are added, and a non-loopback marker adds nothing at all.
 *
 * @param {unknown} devUiOrigin - the marker value (one origin string).
 * @returns {string[]} the marker origin plus at most one alias; [] when invalid.
 */
export function devUiOrigins(devUiOrigin) {
  if (typeof devUiOrigin !== 'string') return [];
  const raw = devUiOrigin.trim();
  if (!raw) return [];
  if (raw.toLowerCase() === 'null') return [];
  // One origin only: a comma/space separated list is not a marker.
  if (/[\s,]/.test(raw)) return [];
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd < 0) return [];
  // Nothing beyond the authority — a path, query, fragment or userinfo is not
  // an origin (and would smuggle extra text into the allowed set).
  if (/[/?#@]/.test(raw.slice(schemeEnd + 3))) return [];

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
  // WHATWG URL keeps the brackets in `hostname` for an IPv6 literal ('[::1]').
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!DEV_UI_ORIGIN_HOSTNAMES.has(hostname)) return [];
  // The port is mandatory and must be a real one (URL keeps '0' — refuse it).
  if (!parsed.port || Number(parsed.port) < 1) return [];

  const origin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  const aliasHost = LOOPBACK_ALIAS_BY_HOST.get(hostname);
  if (!aliasHost) return [origin]; // ::1 — accepted as itself, no alias.
  return [origin, `${parsed.protocol}//${aliasHost}:${parsed.port}`.toLowerCase()];
}

/**
 * The origins this server answers to: the origin the UI is served from (one
 * per own host name, with the actual port) plus the configured CORS origin.
 *
 * This is the SINGLE place the set is built — the HTTP guard and the WS
 * handshake both call it, so they can never diverge.
 *
 * @param {object} params
 * @param {number|string} params.actualPort
 * @param {string} [params.bindHost]
 * @param {string} [params.corsOrigin]
 * @param {string} [params.protocol]
 * @param {string} [params.devUiOrigin] - the launcher's dev-topology
 *   marker (`--dev-ui-origin`). Present ONLY when the launcher starts Vite
 *   itself; packaged and --api-only runs never carry it, so their set is
 *   unchanged whatever NODE_ENV says. Adds the marker origin plus its single
 *   loopback alias (see devUiOrigins — fail-closed).
 * @returns {Set<string>}
 */
export function allowedOrigins({
  actualPort,
  bindHost,
  corsOrigin,
  protocol = 'http',
  devUiOrigin,
}) {
  const set = new Set();
  const cors = originOf(corsOrigin);
  if (cors) set.add(cors);
  for (const hostname of ownHostnames(bindHost)) {
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    set.add(`${protocol}://${host}:${actualPort}`.toLowerCase());
  }
  // The dev-UI alias is a GUARD allowance only — cors({origin}) is never
  // widened, so the reading surface with cookies stays exactly CORS_ORIGIN.
  for (const origin of devUiOrigins(devUiOrigin)) set.add(origin);
  return set;
}

/**
 * Checks an `Origin` (or a `Referer`) against the allowed origins.
 *
 * A missing value is ALLOWED (a command-line client is not a browser).
 *
 * @param {string} value - the Origin header or the Referer URL.
 * @param {object} options
 * @param {Set<string>} options.allowedOrigins
 * @returns {boolean}
 */
export function isAllowedOrigin(value, { allowedOrigins: allowed }) {
  const raw = String(value ?? '').trim();
  if (!raw) return true;
  if (raw.toLowerCase() === 'null') return false; // sandboxed iframe / file://
  const origin = originOf(raw);
  if (!origin) return false;
  return allowed.has(origin);
}

/**
 * Checks a WebSocket upgrade request. The upgrade bypasses the Express
 * middleware, so the origin rule is applied here, at handshake time.
 *
 * @param {object} info - the `verifyClient` handshake info.
 * @param {object} [options]
 * @param {number|string} [options.actualPort]
 * @param {string} [options.bindHost]
 * @param {string} [options.corsOrigin]
 * @param {string|null} [options.devUiOrigin] - the same marker the HTTP guard
 *   uses; defaults to the one parsed from this process' argv.
 * @returns {{allowed: boolean, status?: number, reason?: string}}
 */
export function checkUpgradeOrigin(info, options = {}) {
  const req = info?.req;
  const actualPort = options.actualPort ?? req?.socket?.localPort;
  const bindHost = options.bindHost ?? process.env.GENERAPTOR_HOST?.trim() ?? '127.0.0.1';
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  const origin = info?.origin || req?.headers?.origin;
  const referer = req?.headers?.referer;
  const candidate = origin || referer;
  if (!candidate) return { allowed: true };

  const allowed = allowedOrigins({
    actualPort,
    bindHost,
    corsOrigin,
    // The WS upgrade obeys the SAME marker-driven rule as the HTTP
    // guard — one set, one decision, no NODE_ENV participation.
    devUiOrigin: options.devUiOrigin ?? resolveDevUiOrigin(),
  });
  if (!isAllowedOrigin(candidate, { allowedOrigins: allowed })) {
    return { allowed: false, status: 403, reason: 'origin' };
  }
  return { allowed: true };
}
