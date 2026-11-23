/**
 * Unit tests for the launcher flags + boot banners.
 *
 *   --no-auth        -> ACCESS_GATE_DISABLED + loud warning
 *   --token <fixed>  -> GENERAPTOR_TOKEN (multi-use)
 *   --token-ttl <v>  -> GENERAPTOR_TOKEN_TTL (session|24h|7d|30d)
 *   --host [addr]    -> GENERAPTOR_HOST (explicit opt-in to expose)
 *
 * Banner formatters are pure strings so the CLI contract (token printed to
 * stdout, parseable `[Auth] token: <value>` line; warning visible) is pinned
 * by tests.
 */
import { describe, expect, it } from 'vitest';

import {
  parseAuthFlags,
  applyAuthFlags,
  formatTokenBanner,
  formatNoAuthWarning,
  announceNoAuth,
  shouldPrintNoAuthWarning,
  GENERAPTOR_NO_AUTH_WARNING_SHOWN,
  LauncherUsageError,
  DEFAULT_BIND_HOST,
  resolveBindHost,
  isNetworkExposedHost,
  formatHostForUrl,
  formatNetworkExposureWarning,
  resolveLauncherPorts,
  resolveDevUiOrigin,
  devUiOriginArgs,
} from '../../server/lib/launcher-args.mjs';

describe('parseAuthFlags', () => {
  it('parses nothing by default', () => {
    expect(parseAuthFlags([])).toEqual({
      token: null,
      tokenTtl: null,
      noAuth: false,
      host: null,
    });
  });

  it('parses --no-auth', () => {
    expect(parseAuthFlags(['--no-auth']).noAuth).toBe(true);
  });

  it('parses --token <value> and --token=<value>', () => {
    expect(parseAuthFlags(['--token', 'abc123']).token).toBe('abc123');
    expect(parseAuthFlags(['--token=abc123']).token).toBe('abc123');
  });

  it('parses --token-ttl <value> and --token-ttl=<value>', () => {
    expect(parseAuthFlags(['--token-ttl', '7d']).tokenTtl).toBe('7d');
    expect(parseAuthFlags(['--token-ttl=session']).tokenTtl).toBe('session');
  });

  it('parses --host with an explicit address', () => {
    expect(parseAuthFlags(['--host', '192.168.1.5']).host).toBe('192.168.1.5');
    expect(parseAuthFlags(['--host=192.168.1.5']).host).toBe('192.168.1.5');
  });

  /**
   * SEC-05: `--host` without a value used to fall back to '0.0.0.0' — a
   * silent switch from loopback-only to network-wide reachability. It must be
   * a usage error instead.
   */
  it('rejects --host without a value instead of widening the bind', () => {
    expect(() => parseAuthFlags(['--host'])).toThrow(LauncherUsageError);
    expect(() => parseAuthFlags(['--host'])).toThrow(/--host/);
    expect(() => parseAuthFlags(['--host', '--no-auth'])).toThrow(LauncherUsageError);
    expect(() => parseAuthFlags(['--host='])).toThrow(LauncherUsageError);
    expect(() => parseAuthFlags(['--host=   '])).toThrow(LauncherUsageError);
  });

  it('ignores unrelated flags (sibling launcher args)', () => {
    const flags = parseAuthFlags(['--data-dir', 'C:/tmp/gr', '--token', 'tok', 'extra']);
    expect(flags.token).toBe('tok');
    expect(flags.noAuth).toBe(false);
    expect(flags.host).toBeNull();
  });
});

describe('applyAuthFlags', () => {
  it('maps flags onto the launcher env consumed by the server', () => {
    const env = {};
    applyAuthFlags(
      { token: 'fixed-tok', tokenTtl: '7d', noAuth: true, host: '0.0.0.0' },
      env
    );
    expect(env).toEqual({
      ACCESS_GATE_DISABLED: 'true',
      GENERAPTOR_TOKEN: 'fixed-tok',
      GENERAPTOR_TOKEN_TTL: '7d',
      GENERAPTOR_HOST: '0.0.0.0',
    });
  });

  it('leaves the env untouched for empty flags', () => {
    const env = { KEEP: '1' };
    applyAuthFlags({ token: null, tokenTtl: null, noAuth: false, host: null }, env);
    expect(env).toEqual({ KEEP: '1' });
  });
});

describe('formatTokenBanner', () => {
  it('prints the token on a parseable [Auth] token: line with the URL', () => {
    const text = formatTokenBanner({
      token: 'abc_123-XYZ',
      url: 'http://127.0.0.1:5173',
    });
    expect(text).toMatch(/\[Auth\] token: abc_123-XYZ/);
    expect(text).toContain('http://127.0.0.1:5173');
    expect(text).toMatch(/single use/i);
    expect(text).toMatch(/15 min/i);
  });

  it('never claims one-time semantics for a fixed token', () => {
    const text = formatTokenBanner({
      token: 'fixed-op',
      url: 'http://127.0.0.1:8787',
      fixed: true,
    });
    expect(text).toMatch(/\[Auth\] token: fixed-op/);
    expect(text).not.toMatch(/single use/i);
  });

  /**
   * FIX-07: in --api-only mode the URL handed to the banner is the API root,
   * and `GET /` there answers 404 (no UI is served there). The banner must
   * not send the operator to an address that cannot work — it says where the
   * token really goes: the app's unlock screen.
   */
  it('does not advertise a UI address when no UI is served there', () => {
    const text = formatTokenBanner({
      token: 'abc_123-XYZ',
      url: 'http://127.0.0.1:8787',
      uiServed: false,
    });
    expect(text).toMatch(/\[Auth\] token: abc_123-XYZ/);
    expect(text).not.toMatch(/Paste this token at http/);
    expect(text).toMatch(/unlock screen/i);
  });

  it('advertises the URL when the UI really is served there', () => {
    const text = formatTokenBanner({
      token: 'abc_123-XYZ',
      url: 'http://127.0.0.1:5173',
    });
    expect(text).toMatch(/\[Auth\] Paste this token at http:\/\/127\.0\.0\.1:5173/);
  });
});

describe('formatNoAuthWarning', () => {
  it('is loud and names the flag', () => {
    const text = formatNoAuthWarning();
    expect(text).toMatch(/WARNING: AUTH IS DISABLED/);
    expect(text).toContain('--no-auth');
  });
});

/**
 * D8 (hardening): the --no-auth warning used to be printed twice — once by
 * the launcher and once by the API server it spawns. The launcher now owns
 * the warning and marks the child env so the server does not repeat it.
 */
describe('no-auth warning ownership', () => {
  it('announceNoAuth prints the warning once and marks the child env', () => {
    const env = {};
    const lines = [];
    announceNoAuth(env, (line) => lines.push(line));

    expect(lines.join('\n')).toMatch(/WARNING: AUTH IS DISABLED/);
    expect(env[GENERAPTOR_NO_AUTH_WARNING_SHOWN]).toBe('true');
  });

  it('shouldPrintNoAuthWarning is true only when the gate is off and nobody warned yet', () => {
    expect(shouldPrintNoAuthWarning({})).toBe(false);
    expect(shouldPrintNoAuthWarning({ ACCESS_GATE_DISABLED: 'false' })).toBe(false);
    expect(shouldPrintNoAuthWarning({ ACCESS_GATE_DISABLED: 'true' })).toBe(true);
    expect(
      shouldPrintNoAuthWarning({
        ACCESS_GATE_DISABLED: 'true',
        [GENERAPTOR_NO_AUTH_WARNING_SHOWN]: 'true',
      })
    ).toBe(false);
  });

  it('pins the marker name used by the integration suite', () => {
    expect(GENERAPTOR_NO_AUTH_WARNING_SHOWN).toBe('GENERAPTOR_NO_AUTH_WARNING_SHOWN');
  });
});

/**
 * SEC-05: the bind host is a security boundary — the banner must report the
 * REALLY bound host and a non-loopback bind must be announced loudly.
 */
describe('bind host + network exposure', () => {
  it('defaults to loopback and reads the configured host', () => {
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
    expect(resolveBindHost({})).toBe('127.0.0.1');
    expect(resolveBindHost({ GENERAPTOR_HOST: '   ' })).toBe('127.0.0.1');
    expect(resolveBindHost({ GENERAPTOR_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('treats only loopback binds as non-exposed', () => {
    expect(isNetworkExposedHost('127.0.0.1')).toBe(false);
    expect(isNetworkExposedHost('127.0.0.53')).toBe(false);
    expect(isNetworkExposedHost('localhost')).toBe(false);
    expect(isNetworkExposedHost('::1')).toBe(false);
    expect(isNetworkExposedHost('0.0.0.0')).toBe(true);
    expect(isNetworkExposedHost('::')).toBe(true);
    expect(isNetworkExposedHost('192.168.1.5')).toBe(true);
    expect(isNetworkExposedHost('10.0.0.4')).toBe(true);
  });

  it('formats an IPv6 host for a URL', () => {
    expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1');
    expect(formatHostForUrl('::1')).toBe('[::1]');
    expect(formatHostForUrl('::')).toBe('[::]');
  });

  it('warns loudly about a network-reachable bind', () => {
    const text = formatNetworkExposureWarning({ host: '0.0.0.0', url: 'http://0.0.0.0:8787' });

    expect(text).toMatch(/NETWORK-REACHABLE/);
    expect(text).toMatch(/0\.0\.0\.0/);
    expect(text).toMatch(/token/i);
  });
});

/**
 * O-1: `--port` names the port of the LOCAL APP in every mode.
 *
 * The bug: in a source checkout the launcher takes the development branch,
 * where `--port` was assigned to the Vite UI port only. With `--api-only`
 * no Vite server is started, so the requested port was silently dropped and
 * the API kept 8787.
 */
describe('resolveLauncherPorts', () => {
  it('uses --port as the API port in --api-only mode', () => {
    const { apiPort, uiPort, env } = resolveLauncherPorts({
      port: 8931,
      apiOnly: true,
      useProdBuild: false,
      env: {},
    });

    expect(apiPort).toBe(8931);
    expect(env.GENERAPTOR_API_PORT).toBe('8931');
    // No Vite server runs in --api-only mode: the dev UI port stays default.
    expect(uiPort).toBe(5173);
    // No extra CORS origin is opened in --api-only mode.
    expect(env.CORS_ORIGIN).toBeUndefined();
  });

  it('keeps the default API port in --api-only mode when --port is absent', () => {
    const { apiPort, env } = resolveLauncherPorts({
      port: null,
      apiOnly: true,
      useProdBuild: false,
      env: {},
    });

    expect(apiPort).toBe(8787);
    expect(env.GENERAPTOR_API_PORT).toBe('8787');
    expect(env.CORS_ORIGIN).toBeUndefined();
  });

  it('honors GENERAPTOR_API_PORT in --api-only mode when --port is absent', () => {
    const { apiPort, env } = resolveLauncherPorts({
      port: null,
      apiOnly: true,
      useProdBuild: false,
      env: { GENERAPTOR_API_PORT: '9911' },
    });

    expect(apiPort).toBe(9911);
    expect(env.GENERAPTOR_API_PORT).toBe('9911');
  });

  it('uses --port as the API port in the packaged build', () => {
    const { apiPort, uiPort, env } = resolveLauncherPorts({
      port: 8931,
      apiOnly: false,
      useProdBuild: true,
      env: {},
    });

    expect(apiPort).toBe(8931);
    expect(uiPort).toBe(8931);
    expect(env.GENERAPTOR_API_PORT).toBe('8931');
  });

  it('uses --port as the Vite UI port in the ordinary dev mode', () => {
    const { apiPort, uiPort, env } = resolveLauncherPorts({
      port: 5174,
      apiOnly: false,
      useProdBuild: false,
      env: {},
    });

    expect(uiPort).toBe(5174);
    expect(apiPort).toBe(8787);
    expect(env.PORT).toBe('5174');
    expect(env.CORS_ORIGIN).toBe('http://127.0.0.1:5174');
  });

  it('never overwrites an explicitly configured CORS_ORIGIN', () => {
    const { env } = resolveLauncherPorts({
      port: 5174,
      apiOnly: false,
      useProdBuild: false,
      env: { CORS_ORIGIN: 'http://localhost:5173' },
    });

    expect(env.CORS_ORIGIN).toBeUndefined();
  });

  it('leaves the default Vite port alone when --port is absent', () => {
    const { apiPort, uiPort, env } = resolveLauncherPorts({
      port: null,
      apiOnly: false,
      useProdBuild: false,
      env: {},
    });

    expect(apiPort).toBe(8787);
    expect(uiPort).toBe(5173);
    expect(env.PORT).toBe('5173');
    expect(env.CORS_ORIGIN).toBeUndefined();
  });
});

/**
 * S5 T1 (round 2) — L1/L3: the dev-UI-origin marker is a TOPOLOGY decision.
 *
 * The launcher hands the marker to the API child as an argv flag
 * (`--dev-ui-origin <origin>`), so no new env variable exists and nothing can
 * be inherited from the operator's environment. The marker is emitted ONLY
 * when the launcher itself starts Vite (!useProdBuild && !apiOnly); in every
 * other mode the child argv carries no flag at all — the server then keeps the
 * single-spelling origin set, whatever NODE_ENV says.
 */
describe('resolveDevUiOrigin — the launcher topology marker (S5 T1, L1/L3)', () => {
  const dev = { useProdBuild: false, apiOnly: false, hostForUrl: '127.0.0.1', uiPort: 5173 };

  it('L1: the dev topology (the launcher starts Vite) yields the UI origin', () => {
    expect(resolveDevUiOrigin(dev)).toBe('http://127.0.0.1:5173');
    expect(resolveDevUiOrigin({ ...dev, hostForUrl: 'localhost', uiPort: 5199 })).toBe(
      'http://localhost:5199',
    );
  });

  it('L1: the packaged build yields NO marker', () => {
    expect(resolveDevUiOrigin({ ...dev, useProdBuild: true })).toBeNull();
  });

  it('L1: --api-only yields NO marker (same-origin-only)', () => {
    expect(resolveDevUiOrigin({ ...dev, apiOnly: true })).toBeNull();
    expect(resolveDevUiOrigin({ ...dev, apiOnly: true, useProdBuild: true })).toBeNull();
  });

  it('L1: the decision never reads NODE_ENV (the owner has NODE_ENV=production in .env)', () => {
    for (const NODE_ENV of ['production', 'development', 'test', '']) {
      expect(resolveDevUiOrigin({ ...dev, env: { NODE_ENV } })).toBe('http://127.0.0.1:5173');
      expect(resolveDevUiOrigin({ ...dev, useProdBuild: true, env: { NODE_ENV } })).toBeNull();
      expect(resolveDevUiOrigin({ ...dev, apiOnly: true, env: { NODE_ENV } })).toBeNull();
    }
  });

  it('L1: no marker means no flag in the child argv (nothing is inherited)', () => {
    expect(devUiOriginArgs(null)).toEqual([]);
    expect(devUiOriginArgs(undefined)).toEqual([]);
    expect(devUiOriginArgs('')).toEqual([]);
    expect(devUiOriginArgs(resolveDevUiOrigin({ ...dev, useProdBuild: true }))).toEqual([]);
    expect(devUiOriginArgs(resolveDevUiOrigin({ ...dev, apiOnly: true }))).toEqual([]);
  });

  it('L1: a marker becomes exactly the --dev-ui-origin flag pair', () => {
    expect(devUiOriginArgs('http://127.0.0.1:5173')).toEqual([
      '--dev-ui-origin',
      'http://127.0.0.1:5173',
    ]);
    expect(devUiOriginArgs(resolveDevUiOrigin(dev))).toEqual([
      '--dev-ui-origin',
      'http://127.0.0.1:5173',
    ]);
  });

  it('L3: a non-loopback bind (--host 0.0.0.0 / LAN) yields NO marker', () => {
    expect(resolveDevUiOrigin({ ...dev, hostForUrl: '0.0.0.0' })).toBeNull();
    expect(resolveDevUiOrigin({ ...dev, hostForUrl: '192.168.1.10' })).toBeNull();
    expect(resolveDevUiOrigin({ ...dev, hostForUrl: '[::]' })).toBeNull();
    expect(devUiOriginArgs(resolveDevUiOrigin({ ...dev, hostForUrl: '0.0.0.0' }))).toEqual([]);
  });

  it('L3: an IPv6 loopback bind is a marker, but the server adds no alias for it', () => {
    expect(resolveDevUiOrigin({ ...dev, hostForUrl: '[::1]' })).toBe('http://[::1]:5173');
  });

  it('a broken UI port yields NO marker (fail-closed)', () => {
    expect(resolveDevUiOrigin({ ...dev, uiPort: 0 })).toBeNull();
    expect(resolveDevUiOrigin({ ...dev, uiPort: Number.NaN })).toBeNull();
    expect(resolveDevUiOrigin({ ...dev, uiPort: undefined })).toBeNull();
    expect(resolveDevUiOrigin({ ...dev, uiPort: 70000 })).toBeNull();
  });
});
