/**
 * M4 launcher flags + boot banners.
 *
 * The launcher (start.mjs) owns CLI flags and maps them onto the env the
 * server consumes, so flag parsing lives in exactly one place and stays
 * unit-testable without spawning processes:
 *
 *   --no-auth            -> ACCESS_GATE_DISABLED=true + loud warning
 *   --token <fixed>      -> GENERAPTOR_TOKEN (operator fixed, multi-use)
 *   --token-ttl <v>      -> GENERAPTOR_TOKEN_TTL (session|24h|7d|30d)
 *   --host [addr]        -> GENERAPTOR_HOST (explicit opt-in to expose;
 * default remains loopback-only)
 *
 * Banner formatters are pure: the token is printed exactly once at boot on a
 * parseable `[Auth] token: <value>` line and never logged again (analysis
 * ); the --no-auth warning is unmissable.
 *
 * The dev-UI-origin marker (resolveDevUiOrigin / devUiOriginArgs) is
 * pure too — it decides from the TOPOLOGY only, never from NODE_ENV.
 */
import { devUiOrigins } from './request-origin.mjs';

/**
 * A launcher usage error: the CLI was called with a broken argument.
 *
 * SEC-05: `--host` without a value used to fall back to '0.0.0.0' — a typo
 * silently turned a loopback-only install into a network-wide one. The flag
 * now has exactly one safe meaning: an explicit address.
 */
export class LauncherUsageError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'LauncherUsageError';
  }
}

/**
 * Parse M4 auth/network flags from an argv slice. Unknown flags are ignored
 * (sibling launcher features own their own args).
 *
 * @param {string[]} argv
 * @returns {{ token: string|null, tokenTtl: string|null, noAuth: boolean, host: string|null }}
 * @throws {LauncherUsageError} when a flag is used without its value.
 */
export function parseAuthFlags(argv = []) {
  const out = { token: null, tokenTtl: null, noAuth: false, host: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-auth') {
      out.noAuth = true;
    } else if (arg === '--token') {
      out.token = argv[++i] ?? null;
    } else if (arg.startsWith('--token=')) {
      out.token = arg.slice('--token='.length);
    } else if (arg === '--token-ttl') {
      out.tokenTtl = argv[++i] ?? null;
    } else if (arg.startsWith('--token-ttl=')) {
      out.tokenTtl = arg.slice('--token-ttl='.length);
    } else if (arg === '--host') {
      // SEC-05: no silent fallback to a network-wide bind.
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new LauncherUsageError(
          '--host requires an address (for example: --host 127.0.0.1 or --host 0.0.0.0).',
        );
      }
      out.host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length).trim();
      if (!value) {
        throw new LauncherUsageError(
          '--host requires an address (for example: --host 127.0.0.1 or --host 0.0.0.0).',
        );
      }
      out.host = value;
    }
  }
  return out;
}

/**
 * Map parsed flags onto the environment passed to the server process.
 * Mutates and returns `env`.
 *
 * @param {{token: string|null, tokenTtl: string|null, noAuth: boolean, host: string|null}} flags
 * @param {Record<string,string>} [env]
 */
export function applyAuthFlags(flags, env = process.env) {
  if (flags.noAuth) env.ACCESS_GATE_DISABLED = 'true';
  if (flags.token) env.GENERAPTOR_TOKEN = flags.token;
  if (flags.tokenTtl) env.GENERAPTOR_TOKEN_TTL = flags.tokenTtl;
  if (flags.host) env.GENERAPTOR_HOST = flags.host;
  return env;
}

/**
 * Resolve the launcher ports and the env the server child inherits.
 *
 * O-1: `--port` used to be assigned to the Vite UI port only. In a source
 * checkout the launcher takes the development branch, so with `--api-only`
 * (no Vite server is started) the requested port was silently dropped and the
 * API kept its default — the operator asked for a port and got another one.
 *
 * Now `--port` always names the port of the LOCAL APP:
 *
 *   - packaged build (UI + API in one server): the API port;
 *   - source checkout, ordinary mode: the Vite UI port (the API keeps its
 *     own GENERAPTOR_API_PORT);
 *   - source checkout, `--api-only`: the API port — there is no Vite server
 *     that could take the port instead.
 *
 * Pure: no side effects, the caller applies the returned `env` patch.
 *
 * @param {object} [options]
 * @param {number|null} [options.port] - the `--port` value (null = absent)
 * @param {boolean} [options.apiOnly] - the `--api-only` flag
 * @param {boolean} [options.useProdBuild] - packaged build (the API serves the UI)
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {{apiPort: number, uiPort: number, env: Record<string, string>}}
 */
export function resolveLauncherPorts({
  port = null,
  apiOnly = false,
  useProdBuild = false,
  env = process.env,
} = {}) {
  const apiPortFromEnv = Number(env.GENERAPTOR_API_PORT || 8787);
  const uiPortFromEnv = Number(env.PORT || 5173);

  // Packaged build: one server serves the UI and the API — one port.
  if (useProdBuild) {
    const apiPort = port ?? apiPortFromEnv;
    return { apiPort, uiPort: apiPort, env: { GENERAPTOR_API_PORT: String(apiPort) } };
  }

  // --api-only without a Vite server: the local app IS the API, so `--port`
  // is the API port. CORS_ORIGIN is deliberately left alone — the API's own
  // origin is allowed anyway (own hostname + the port it really listens on)
  // and the launcher default (http://localhost:5173) keeps the manually
  // started Vite dev server working. No new origin is opened.
  if (apiOnly) {
    const apiPort = port ?? apiPortFromEnv;
    return {
      apiPort,
      uiPort: uiPortFromEnv,
      env: { GENERAPTOR_API_PORT: String(apiPort), PORT: String(uiPortFromEnv) },
    };
  }

  // Ordinary dev mode: the Vite dev server takes `--port`, the API keeps its
  // own port (the dev UI calls the API through the Vite proxy).
  const apiPort = apiPortFromEnv;
  const uiPort = port ?? uiPortFromEnv;
  const patch = { PORT: String(uiPort) };
  if (port !== null && !env.CORS_ORIGIN) {
    patch.CORS_ORIGIN = `http://127.0.0.1:${uiPort}`;
  }
  return { apiPort, uiPort, env: patch };
}

/**
 * The dev-UI-origin MARKER is a topology decision.
 *
 * The browser may open either loopback spelling of the Vite UI origin
 * (localhost vs 127.0.0.1). Both name the same application, so the SEC-03
 * Origin guard accepts both — but ONLY when the launcher really starts Vite
 * itself. That fact is known here, and nowhere else:
 *
 *   - packaged build (the API serves dist/): the UI is the API's own origin,
 *     there is nothing to alias → NO marker;
 *   - `--api-only`: no Vite server is started by us → NO marker;
 *   - dev topology: the marker is the UI origin, handed to the API child as an
 *     argv flag (no new env variable — nothing can be inherited).
 *
 * NODE_ENV takes NO part in this decision. The owner's .env sets
 * NODE_ENV=production while the launcher still starts Vite (no dist/ in that
 * checkout) — a NODE_ENV-based rule silently left his 403 bug unfixed
 * (results/s5-security-verify.md §3.1).
 *
 * The acceptance rule is the server's own (devUiOrigins): one loopback origin
 * with an explicit port. A non-loopback bind (`--host 0.0.0.0` / LAN) therefore
 * yields no marker either — cross-origin trust in LAN mode stays exactly what
 * the operator configured through CORS_ORIGIN.
 *
 * Pure: no side effects, no env reads.
 *
 * @param {object} [options]
 * @param {boolean} [options.useProdBuild] - the API serves the built UI
 * @param {boolean} [options.apiOnly] - the `--api-only` flag
 * @param {string} [options.hostForUrl] - the bind host, URL-formatted
 * @param {number|string} [options.uiPort] - the Vite UI port
 * @returns {string|null} the marker origin, or null when there is no dev UI
 */
export function resolveDevUiOrigin({
  useProdBuild = false,
  apiOnly = false,
  hostForUrl = DEFAULT_BIND_HOST,
  uiPort,
} = {}) {
  if (useProdBuild || apiOnly) return null;
  const candidate = `http://${formatHostForUrl(hostForUrl)}:${uiPort}`;
  // One acceptance rule, shared with the server: the normalized origin, or null.
  return devUiOrigins(candidate)[0] ?? null;
}

/**
 * The argv fragment that carries the marker to the API child.
 *
 * No marker → an EMPTY fragment: the child's argv then contains no flag at all,
 * so nothing is inherited and the server keeps the single-spelling origin set.
 *
 * @param {string|null|undefined} devUiOrigin
 * @returns {string[]}
 */
export function devUiOriginArgs(devUiOrigin) {
  const origin = devUiOrigins(devUiOrigin)[0];
  return origin ? ['--dev-ui-origin', origin] : [];
}

/**
 * Boot banner for the startup token. One-time mode states single-use + the
 * acceptance window; fixed mode (--token) does not.
 *
 * `uiServed: false` — the URL does NOT serve the UI (the --api-only launcher
 * points at the API root, where `GET /` answers 404 when no built frontend is
 * mounted). The banner must not send the operator to an address that cannot
 * work: it says that no UI is served there and that the token belongs into
 * the app's unlock screen.
 *
 * `note` — an optional extra line (FIX-08/FIX-09). It explains WHERE the UI
 * really is, so the operator is never sent to an address that answers 404.
 *
 * @param {{ token: string, url: string, fixed?: boolean, windowMinutes?: number, uiServed?: boolean, note?: string|null }} opts
 * @returns {string}
 */
export function formatTokenBanner({
  token,
  url,
  fixed = false,
  windowMinutes = 15,
  uiServed = true,
  note = null,
}) {
  const validity = fixed
    ? 'fixed token (--token): reusable, no expiry window'
    : `ONE-TIME: single use, valid for ${windowMinutes} min`;
  const paste = uiServed
    ? `[Auth] Paste this token at ${url} to unlock the app.`
    : `[Auth] No UI is served at ${url} — paste this token into the app's unlock screen.`;
  const lines = [
    '[Auth] ----------------------------------------------------------',
    `[Auth] token: ${token}`,
  ];
  if (note) lines.push(`[Auth] ${note}`);
  lines.push(paste, `[Auth] ${validity}`, '[Auth] ----------------------------------------------------------');
  return lines.join('\n');
}

/**
 * FIX-08 / FIX-09 — the single source of truth about WHERE the UI is.
 *
 * The API server mounts the built frontend (`dist/`) whenever that directory
 * exists (server/express-app.mjs) — in EVERY mode, `--api-only` included.
 * So:
 *
 *   - `dist/` exists      -> the UI is served at the API root. `--api-only`
 *                            does NOT disable the UI (it only skips the Vite
 *                            dev server).
 *   - no `dist/`, Vite    -> the API root answers 404; the UI lives in the
 *                            Vite dev server (it has to be started first).
 *   - no `dist/`, no Vite -> nothing serves the UI (broken install).
 *
 * @param {{ hasDist?: boolean, viteAvailable?: boolean, devServerRunning?: boolean, apiUrl?: string, devUiUrl?: string }} opts
 * @returns {{
 *   mode: 'api-root'|'dev-server'|'dev-server-not-started'|'none',
 *   uiServedAtApiRoot: boolean,
 *   uiUrl: string|null,
 *   pasteUrl: string|null,
 *   uiServed: boolean,
 *   uiLabel: string,
 *   note: string|null,
 * }}
 */
export function resolveUiAvailability({
  hasDist = false,
  viteAvailable = false,
  devServerRunning = false,
  apiUrl = '',
  devUiUrl = '',
} = {}) {
  if (hasDist) {
    return {
      mode: 'api-root',
      uiServedAtApiRoot: true,
      uiUrl: apiUrl || null,
      pasteUrl: apiUrl || null,
      uiServed: Boolean(apiUrl),
      uiLabel: apiUrl
        ? `${apiUrl} (served from dist/ by the API server)`
        : 'served from dist/ by the API server',
      note: apiUrl
        ? `The UI is served from dist/ by this API server — the app is at ${apiUrl}.`
        : 'The UI is served from dist/ by this API server.',
    };
  }

  if (viteAvailable && devUiUrl) {
    const running = Boolean(devServerRunning);
    return {
      mode: running ? 'dev-server' : 'dev-server-not-started',
      uiServedAtApiRoot: false,
      uiUrl: devUiUrl,
      pasteUrl: devUiUrl,
      uiServed: true,
      uiLabel: running
        ? `${devUiUrl} (Vite dev server)`
        : `not running — start the Vite dev server: npm run dev (${devUiUrl})`,
      note: running
        ? null
        : `The frontend is not built (no dist/) — the API root serves no UI. Start the Vite dev server with "npm run dev" (${devUiUrl}), then paste the token there.`,
    };
  }

  return {
    mode: 'none',
    uiServedAtApiRoot: false,
    uiUrl: null,
    pasteUrl: null,
    uiServed: false,
    uiLabel: 'not available — no dist/ build and no Vite dev server',
    note: 'The frontend build is missing (no dist/) — this API server serves no UI. Reinstall the package, or build it with "npm run build".',
  };
}

/**
 * FIX-08 — the launcher's `Frontend:` status line.
 *
 * The line must never lie: in a packaged build the API server itself serves
 * the built UI, so `--api-only` cannot claim "disabled".
 *
 * @param {{ mode: string, apiOnly: boolean }} opts
 * @returns {string|null} `null` when the launcher starts Vite itself (Vite
 *   prints its own banner).
 */
export function formatFrontendStatusLine({ mode, apiOnly }) {
  if (mode === 'api-root') {
    return apiOnly
      ? 'served from dist/ by the API server (--api-only does not disable the UI)'
      : 'served from dist/ by the API server (production mode)';
  }
  if (apiOnly) {
    return 'disabled (--api-only) — the API root serves no UI (no dist/ build)';
  }
  return null;
}

/**
 * Loud --no-auth warning (the escape hatch prints a loud warning).
 *
 * @returns {string}
 */
export function formatNoAuthWarning() {
  return [
    '[Auth] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '[Auth] !!  WARNING: AUTH IS DISABLED (--no-auth)             !!',
    '[Auth] !!  The API is open to anyone who can reach this      !!',
    '[Auth] !!  machine. Use only on a trusted, isolated machine. !!',
    '[Auth] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  ].join('\n');
}

/**
 * Env marker: "the --no-auth warning was already printed".
 *
 * D8 (hardening): the launcher printed the warning and the API server it
 * spawns printed it again (ACCESS_GATE_DISABLED=true is inherited by the
 * child). The launcher owns the warning and marks the child env so the server
 * stays silent — the same de-dup idea the startup-token banner uses.
 */
export const GENERAPTOR_NO_AUTH_WARNING_SHOWN = 'GENERAPTOR_NO_AUTH_WARNING_SHOWN';

/**
 * Print the --no-auth warning ONCE and mark the env so the spawned server
 * does not repeat it.
 *
 * @param {Record<string,string>} [env] env handed to the server child
 * @param {(message: string) => void} [log] output sink (stdout by default)
 * @returns {string} the printed warning
 */
export function announceNoAuth(env = process.env, log = console.log) {
  const warning = formatNoAuthWarning();
  log(warning);
  env[GENERAPTOR_NO_AUTH_WARNING_SHOWN] = 'true';
  return warning;
}

/**
 * Should THIS process print the --no-auth warning?
 *
 * True only when the access gate is off AND nobody warned yet (the launcher
 * did not mark the env).
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function shouldPrintNoAuthWarning(env = process.env) {
  if (env.ACCESS_GATE_DISABLED !== 'true') return false;
  return env[GENERAPTOR_NO_AUTH_WARNING_SHOWN] !== 'true';
}

/* ------------------------------------------------------------------ */
/*  SEC-05: the bind host is a security boundary                        */
/* ------------------------------------------------------------------ */

/**
 * The default bind host — loopback only.
 *
 * The launcher, the API server and the banner all read the host through
 * `resolveBindHost`, so "where do we listen?" has exactly one answer.
 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * The host the server really binds to.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolveBindHost(env = process.env) {
  return (env.GENERAPTOR_HOST || '').trim() || DEFAULT_BIND_HOST;
}

/**
 * Is the server reachable from the network with this bind host?
 *
 * Only loopback binds are private; a wildcard ('0.0.0.0' / '::') or any
 * routable address exposes the app to the LAN.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isNetworkExposedHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return false;
  if (value.startsWith('127.')) return false;
  return true;
}

/**
 * Format a host for use inside a URL (IPv6 literals need brackets).
 *
 * @param {string} host
 * @returns {string}
 */
export function formatHostForUrl(host) {
  const value = String(host || '').trim();
  if (!value) return DEFAULT_BIND_HOST;
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

/**
 * Loud warning for a network-reachable bind.
 *
 * SEC-05: a non-loopback bind turns the access token into the ONLY thing
 * between the LAN and the API. The operator has to be told.
 *
 * @param {{ host: string, url?: string }} opts
 * @returns {string}
 */
export function formatNetworkExposureWarning({ host, url = '' } = {}) {
  const target = url ? ` (${url})` : '';
  return [
    '[Net] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    `[Net] !!  WARNING: NETWORK-REACHABLE BIND — ${host}${target}`.padEnd(68, ' '),
    '[Net] !!  Anyone who can reach this machine can reach the app.  !!',
    '[Net] !!  The access token is the ONLY protection left — keep  !!',
    '[Net] !!  it secret, and use --host 127.0.0.1 for a local-only    !!',
    '[Net] !!  install.                                               !!',
    '[Net] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  ].join('\n');
}

/**
 * Env marker: "the network-exposure warning was already printed".
 */
export const GENERAPTOR_NETWORK_WARNING_SHOWN = 'GENERAPTOR_NETWORK_WARNING_SHOWN';

/**
 * Print the network-exposure warning ONCE and mark the env so the spawned
 * server does not repeat it (same de-dup idea as the --no-auth warning).
 *
 * @param {Record<string,string|undefined>} [env] env handed to the server child
 * @param {(message: string) => void} [log] output sink (stdout by default)
 * @returns {string} the printed warning
 */
export function announceNetworkExposure(env = process.env, log = console.log) {
  const host = resolveBindHost(env);
  if (!isNetworkExposedHost(host)) return '';
  const warning = formatNetworkExposureWarning({ host });
  log(warning);
  env[GENERAPTOR_NETWORK_WARNING_SHOWN] = 'true';
  return warning;
}

/**
 * Should THIS process print the network-exposure warning?
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function shouldPrintNetworkWarning(env = process.env) {
  if (!isNetworkExposedHost(resolveBindHost(env))) return false;
  return env[GENERAPTOR_NETWORK_WARNING_SHOWN] !== 'true';
}
