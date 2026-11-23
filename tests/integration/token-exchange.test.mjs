/**
 * Integration tests for the token-exchange auth flow.
 *
 * Covers over real HTTP (+ real WS handshake):
 *   - POST /api/auth/exchange: no Bearer -> 401; wrong -> 401 (token not
 *     burned); correct -> 200 + session cookie; repeat -> 401 (single-use).
 *   - Session cookie authorizes protected API + WS handshake; absent cookie
 *     -> 401 JSON on API and rejected WS upgrade.
 *   - Wrong x6 within 15 s -> 429 + Retry-After; the rate-limited attempt
 *     spends nothing (docs/ui-design.md §6).
 *   - Acceptance-window expiry -> 401.
 *   - Session TTL variants (default 24 h cookie, session cookie without
 *     Max-Age, 7 d).
 *   - Non-/api GET passes the gate (SPA shell is public; TokenGate is the
 *     client-side lock).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocket } from 'ws';

import { authRouter, _resetLoginRateLimit } from '../../server/routes/auth.mjs';
import {
  requireGate,
  verifyWsConnection,
  GATE_COOKIE_NAME,
} from '../../server/lib/auth.mjs';
import {
  createTokenGate,
  _setTokenGateForTests,
} from '../../server/lib/startup-token.mjs';
import { createWebSocketServer } from '../../server/websocket.mjs';

const TEST_TOKEN = 'integration-test-one-time-token-value';

function buildAuthApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use(requireGate);
  app.get('/api/protected', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.send('<html>spa-shell</html>'));
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

function exchange(baseUrl, bearer) {
  const headers = {};
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  return fetch(`${baseUrl}/api/auth/exchange`, { method: 'POST', headers });
}

async function exchangeAndGetCookie(baseUrl, token = TEST_TOKEN) {
  const res = await exchange(baseUrl, token);
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie').split(';')[0];
}

beforeAll(() => {
  process.env.ACCESS_GATE_DISABLED = 'false';
  delete process.env.GENERAPTOR_TOKEN_TTL;
});

afterAll(() => {
  process.env.ACCESS_GATE_DISABLED = 'true';
  delete process.env.GENERAPTOR_TOKEN_TTL;
  _setTokenGateForTests();
});

beforeEach(() => {
  _resetLoginRateLimit();
  _setTokenGateForTests(createTokenGate({ token: TEST_TOKEN }));
});

describe('POST /api/auth/exchange', () => {
  let server, baseUrl;

  beforeEach(async () => {
    ({ server, baseUrl } = await listen(buildAuthApp()));
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await exchange(baseUrl, undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 401 on a wrong token and does not burn the real one', async () => {
    const wrong = await exchange(baseUrl, 'totally-wrong');
    expect(wrong.status).toBe(401);
    const good = await exchange(baseUrl, TEST_TOKEN);
    expect(good.status).toBe(200);
  });

  it('returns 200 + session cookie on the correct token', async () => {
    const res = await exchange(baseUrl, TEST_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${GATE_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie.toLowerCase()).toContain('path=/');
    // Default session TTL is 24 h (--token-ttl default).
    expect(setCookie.toLowerCase()).toContain('max-age=86400');
  });

  it('returns 401 on a repeat exchange of the consumed token (single-use)', async () => {
    const first = await exchange(baseUrl, TEST_TOKEN);
    expect(first.status).toBe(200);
    const second = await exchange(baseUrl, TEST_TOKEN);
    expect(second.status).toBe(401);
  });

  it('rejects the token after the acceptance window (injected expired gate)', async () => {
    _setTokenGateForTests(
      createTokenGate({
        token: TEST_TOKEN,
        issuedAt: Date.now() - 16 * 60 * 1000, // window is 15 min
      })
    );
    const res = await exchange(baseUrl, TEST_TOKEN);
    expect(res.status).toBe(401);
  });

  it('rate-limits the 6th attempt in the window (429 + Retry-After)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await exchange(baseUrl, 'wrong-attempt');
      expect(res.status).toBe(401);
    }
    const sixth = await exchange(baseUrl, 'wrong-attempt');
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).not.toBeNull();
  });

  it('a rate-limited attempt spends nothing (429 does not burn the token)', async () => {
    for (let i = 0; i < 5; i++) {
      await exchange(baseUrl, 'wrong-attempt');
    }
    // 6th attempt carries the CORRECT token but is rate-limited before exchange.
    const blocked = await exchange(baseUrl, TEST_TOKEN);
    expect(blocked.status).toBe(429);
    // Simulate the window sliding open, then the token still works.
    _resetLoginRateLimit();
    const res = await exchange(baseUrl, TEST_TOKEN);
    expect(res.status).toBe(200);
  });
});

describe('session cookie vs protected surface', () => {
  let server, baseUrl;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(buildAuthApp()));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('returns 401 JSON on /api/* without a cookie', async () => {
    const res = await fetch(`${baseUrl}/api/protected`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('authorizes /api/* with the exchanged session cookie', async () => {
    const cookie = await exchangeAndGetCookie(baseUrl);
    const res = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('lets a non-/api GET through without a cookie (SPA shell is public)', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa-shell');
  });

  it('GET /api/auth/status reflects the session cookie', async () => {
    const anonymous = await fetch(`${baseUrl}/api/auth/status`);
    expect(await anonymous.json()).toEqual({ authenticated: false });
    const cookie = await exchangeAndGetCookie(baseUrl);
    const authed = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Cookie: cookie },
    });
    expect(await authed.json()).toEqual({ authenticated: true });
  });
});

describe('session cookie TTL variants (GENERAPTOR_TOKEN_TTL)', () => {
  let server, baseUrl;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(buildAuthApp()));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    delete process.env.GENERAPTOR_TOKEN_TTL;
  });

  it('session -> cookie without Max-Age (dies with the browser)', async () => {
    process.env.GENERAPTOR_TOKEN_TTL = 'session';
    const res = await exchange(baseUrl, TEST_TOKEN);
    expect(res.status).toBe(200);
    const setCookie = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(setCookie).not.toContain('max-age');
    expect(setCookie).not.toContain('expires');
  });

  it('7d -> Max-Age of 7 days', async () => {
    process.env.GENERAPTOR_TOKEN_TTL = '7d';
    const res = await exchange(baseUrl, TEST_TOKEN);
    expect(res.status).toBe(200);
    expect((res.headers.get('set-cookie') ?? '').toLowerCase()).toContain(
      'max-age=604800'
    );
  });
});

describe('WebSocket handshake with the session cookie', () => {
  let server, baseUrl;

  beforeAll(async () => {
    const app = buildAuthApp();
    ({ server, baseUrl } = await listen(app));
    // Mirror production wiring from server/express-app.mjs.
    createWebSocketServer(server, {
      verifyClient: (info, cb) => {
        const ok = verifyWsConnection(info);
        return ok ? cb(true) : cb(false, 401, 'Unauthorized');
      },
    });
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('rejects the upgrade without a cookie (401 handshake)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const outcome = await new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve('opened'));
      ws.on('error', () => resolve('error'));
    });
    expect(outcome).toBe(401);
    ws.close();
  });

  it('accepts the upgrade with the exchanged session cookie and delivers the welcome event', async () => {
    const cookie = await exchangeAndGetCookie(baseUrl);
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, {
      headers: { Cookie: cookie },
    });
    const firstMessage = await new Promise((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws.on('unexpected-response', (_req, res) =>
        reject(new Error(`handshake rejected: ${res.statusCode}`))
      );
      ws.on('error', reject);
    });
    expect(firstMessage.type).toBe('connected');
    ws.close();
  });
});
