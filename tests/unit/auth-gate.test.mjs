/**
 * Unit tests for the session gate (server/lib/auth.mjs) in its M4 shape:
 * token-exchanged sessions replace the static-password + 30 d cookie.
 *
 * Covers:
 *   - resolveSessionTtlMs: default 24 h, session -> null, 24h/7d/30d values,
 *     invalid -> throw (fail-closed at boot).
 *   - createGateToken / verifyGateToken: format, default 24 h expiry, tamper,
 *     key rotation.
 *   - resolveGateKey: env key honored, JWT_SECRET fallback, placeholder
 *     rejected, unset -> per-process random key (stable within the process).
 *   - requireGate middleware: /api/* without cookie -> 401 JSON; valid cookie
 *     -> next(); expired/malformed -> 401; non-/api GET passes (public SPA
 *     shell - TokenGate is the client-side lock).
 *   - verifyWsConnection: rejects upgrade without cookie; accepts with valid
 *     session cookie (cookie path only - no second auth mechanism).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';

import {
  GATE_COOKIE_NAME,
  createGateToken,
  verifyGateToken,
  requireGate,
  verifyWsConnection,
  resolveGateKey,
  resolveSessionTtlMs,
} from '../../server/lib/auth.mjs';

const TEST_KEY = 'b'.repeat(64);

function buildGateTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(requireGate);
  app.get('/api/articles', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.send('<html>shell</html>'));
  return app;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
    server.on('error', reject);
  });
}

beforeAll(() => {
  process.env.ACCESS_GATE_HMAC_KEY = TEST_KEY;
});

afterAll(() => {
  // Restore the vitest-config defaults so other suites are unaffected.
  process.env.ACCESS_GATE_HMAC_KEY = 'a'.repeat(64);
  process.env.ACCESS_GATE_DISABLED = 'true';
  delete process.env.GENERAPTOR_TOKEN_TTL;
});

beforeEach(() => {
  process.env.ACCESS_GATE_DISABLED = 'false';
  delete process.env.GENERAPTOR_TOKEN_TTL;
});

describe('resolveSessionTtlMs (--token-ttl / GENERAPTOR_TOKEN_TTL)', () => {
  it('defaults to 24 h when unset', () => {
    expect(resolveSessionTtlMs()).toBe(24 * 60 * 60 * 1000);
  });

  it('maps the documented values', () => {
    expect(resolveSessionTtlMs('session')).toBeNull();
    expect(resolveSessionTtlMs('24h')).toBe(24 * 60 * 60 * 1000);
    expect(resolveSessionTtlMs('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(resolveSessionTtlMs('30d')).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('is case-insensitive and trims', () => {
    expect(resolveSessionTtlMs(' 7D ')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('throws on an invalid explicit value (fail-closed)', () => {
    expect(() => resolveSessionTtlMs('forever')).toThrow(/GENERAPTOR_TOKEN_TTL/);
  });
});

describe('createGateToken / verifyGateToken', () => {
  it('produces an exp.signature token with both parts non-empty', () => {
    const token = createGateToken(Date.now() + 60000, TEST_KEY);
    const dot = token.indexOf('.');
    expect(dot).toBeGreaterThan(0);
    expect(dot).toBeLessThan(token.length - 1);
    const exp = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    expect(/^\d+$/.test(exp)).toBe(true);
    expect(sig.length).toBe(64); // hex HMAC-SHA256
  });

  it('defaults the expiry to the session TTL (24 h)', () => {
    const before = Date.now();
    const token = createGateToken(undefined, TEST_KEY);
    const exp = Number(token.split('.')[0]);
    const after = Date.now();
    expect(exp).toBeGreaterThanOrEqual(before + 24 * 3600 * 1000 - 5);
    expect(exp).toBeLessThanOrEqual(after + 24 * 3600 * 1000 + 5);
  });

  it('honours a 7d TTL for the session exp', () => {
    process.env.GENERAPTOR_TOKEN_TTL = '7d';
    const token = createGateToken(undefined, TEST_KEY);
    const exp = Number(token.split('.')[0]);
    expect(exp - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
    delete process.env.GENERAPTOR_TOKEN_TTL;
  });

  it('verifies a freshly created token', () => {
    const token = createGateToken(Date.now() + 60000, TEST_KEY);
    expect(verifyGateToken(token, TEST_KEY)).toBe(true);
  });

  it('rejects an expired token', () => {
    const token = createGateToken(Date.now() - 1000, TEST_KEY);
    expect(verifyGateToken(token, TEST_KEY)).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifyGateToken('garbage', TEST_KEY)).toBe(false);
    expect(verifyGateToken('.abc', TEST_KEY)).toBe(false);
    expect(verifyGateToken('123.', TEST_KEY)).toBe(false);
    expect(verifyGateToken('', TEST_KEY)).toBe(false);
    expect(verifyGateToken('notanumber.abc', TEST_KEY)).toBe(false);
    expect(verifyGateToken(null, TEST_KEY)).toBe(false);
    expect(verifyGateToken(undefined, TEST_KEY)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = createGateToken(Date.now() + 60000, TEST_KEY);
    const flipped = token.endsWith('0')
      ? token.slice(0, -1) + '1'
      : token.slice(0, -1) + '0';
    expect(verifyGateToken(flipped, TEST_KEY)).toBe(false);
  });

  it('rejects a token signed with a different key (rotation)', () => {
    const token = createGateToken(Date.now() + 60000, 'other-key');
    expect(verifyGateToken(token, TEST_KEY)).toBe(false);
  });
});

describe('resolveGateKey (session signing key)', () => {
  it('honours ACCESS_GATE_HMAC_KEY', () => {
    expect(resolveGateKey()).toBe(TEST_KEY);
  });

  it('falls back to JWT_SECRET', () => {
    const saved = process.env.ACCESS_GATE_HMAC_KEY;
    delete process.env.ACCESS_GATE_HMAC_KEY;
    process.env.JWT_SECRET = 'c'.repeat(64);
    try {
      expect(resolveGateKey()).toBe('c'.repeat(64));
    } finally {
      process.env.ACCESS_GATE_HMAC_KEY = saved;
      delete process.env.JWT_SECRET;
    }
  });

  it('throws on a placeholder explicit key (fail-closed)', () => {
    const saved = process.env.ACCESS_GATE_HMAC_KEY;
    process.env.ACCESS_GATE_HMAC_KEY = 'change_me_please';
    try {
      expect(() => resolveGateKey()).toThrow(/placeholder/);
    } finally {
      process.env.ACCESS_GATE_HMAC_KEY = saved;
    }
  });

  it('generates a per-process random key when no env key is set', () => {
    const savedHmac = process.env.ACCESS_GATE_HMAC_KEY;
    delete process.env.ACCESS_GATE_HMAC_KEY;
    delete process.env.JWT_SECRET;
    try {
      const key = resolveGateKey();
      // 64 random bytes as hex.
      expect(key).toMatch(/^[0-9a-f]{128}$/);
      // Stable within the process.
      expect(resolveGateKey()).toBe(key);
    } finally {
      process.env.ACCESS_GATE_HMAC_KEY = savedHmac;
    }
  });
});

describe('requireGate middleware', () => {
  let server, baseUrl;

  beforeEach(async () => {
    ({ server, baseUrl } = await listen(buildGateTestApp()));
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('returns 401 JSON for an API request without a cookie', async () => {
    const res = await fetch(`${baseUrl}/api/articles`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('lets a valid session cookie through', async () => {
    const token = createGateToken(Date.now() + 60000);
    const res = await fetch(`${baseUrl}/api/articles`, {
      headers: {
        Accept: 'application/json',
        Cookie: `${GATE_COOKIE_NAME}=${token}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects an expired cookie with 401', async () => {
    const token = createGateToken(Date.now() - 1000);
    const res = await fetch(`${baseUrl}/api/articles`, {
      headers: { Cookie: `${GATE_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed cookie with 401', async () => {
    const res = await fetch(`${baseUrl}/api/articles`, {
      headers: { Cookie: `${GATE_COOKIE_NAME}=garbage` },
    });
    expect(res.status).toBe(401);
  });

  it('passes a non-/api GET through (public SPA shell, no redirect)', async () => {
    const res = await fetch(`${baseUrl}/`, {
      redirect: 'manual',
      headers: { Accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('verifyWsConnection (WebSocket handshake)', () => {
  it('rejects an upgrade with no cookie', () => {
    const info = { req: { headers: {} } };
    expect(verifyWsConnection(info)).toBe(false);
  });

  it('rejects an upgrade with an invalid cookie', () => {
    const info = {
      req: { headers: { cookie: `${GATE_COOKIE_NAME}=garbage` } },
    };
    expect(verifyWsConnection(info)).toBe(false);
  });

  it('accepts an upgrade with a valid session cookie', () => {
    const token = createGateToken(Date.now() + 60000);
    const info = {
      req: { headers: { cookie: `${GATE_COOKIE_NAME}=${token}` } },
    };
    expect(verifyWsConnection(info)).toBe(true);
  });

  it('parses a cookie header with multiple entries', () => {
    const token = createGateToken(Date.now() + 60000);
    const info = {
      req: {
        headers: {
          cookie: `theme=dark; ${GATE_COOKIE_NAME}=${token}; foo=bar`,
        },
      },
    };
    expect(verifyWsConnection(info)).toBe(true);
  });

  it('accepts any connection when the gate is disabled', () => {
    process.env.ACCESS_GATE_DISABLED = 'true';
    const info = { req: { headers: {} } };
    expect(verifyWsConnection(info)).toBe(true);
  });
});
