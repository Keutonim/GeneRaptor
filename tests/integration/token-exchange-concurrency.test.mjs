/**
 * Concurrency edge cases for POST /api/auth/exchange
 * (server/routes/auth.mjs — one-time token + in-memory sliding-window limit).
 *
 * The brief asks for the concurrent-exchange case explicitly. Two properties
 * are pinned here, because both are easy to break with a refactor:
 *
 *   1. The startup token is SINGLE USE. When N requests exchange the SAME
 *      valid token at once, exactly ONE of them may succeed; the others must
 *      not receive a session cookie.
 *   2. The rate limiter counts EVERY attempt (success or failure). Six
 *      concurrent wrong attempts trip the limit (5 per 15 s per IP) — the
 *      overflow request answers 429 and no request ever gets a session.
 *
 * Strategy: the real auth router on an ephemeral port + node fetch, the real
 * startup-token gate and the real rate limiter.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { authRouter, _resetLoginRateLimit } from '../../server/routes/auth.mjs';
import { requireGate, GATE_COOKIE_NAME } from '../../server/lib/auth.mjs';
import { createTokenGate, _setTokenGateForTests } from '../../server/lib/startup-token.mjs';

const TEST_TOKEN = 'concurrency-one-time-token-value';
const WRONG_TOKEN = 'definitely-not-the-token';

function buildAuthApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use(requireGate);
  app.get('/api/protected', (req, res) => res.json({ ok: true }));
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
  return fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

beforeAll(() => {
  process.env.ACCESS_GATE_DISABLED = 'false';
});

afterAll(() => {
  process.env.ACCESS_GATE_DISABLED = 'true';
  _setTokenGateForTests();
});

beforeEach(() => {
  _resetLoginRateLimit();
  _setTokenGateForTests(createTokenGate({ token: TEST_TOKEN }));
});

describe('POST /api/auth/exchange — concurrent attempts', () => {
  let server, baseUrl;

  beforeEach(async () => {
    ({ server, baseUrl } = await listen(buildAuthApp()));
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('lets exactly ONE of five concurrent exchanges of the same token succeed', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => exchange(baseUrl, TEST_TOKEN)),
    );
    const statuses = responses.map((r) => r.status).sort();

    // Exactly one session — the token is single use.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(statuses).not.toContain(429);

    // Only the winner carries a session cookie.
    const withCookie = responses.filter((r) => r.headers.get('set-cookie'));
    expect(withCookie).toHaveLength(1);
    expect(withCookie[0].headers.get('set-cookie')).toContain(GATE_COOKIE_NAME);
  });

  it('rate-limits (429) the overflow of six concurrent wrong attempts', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => exchange(baseUrl, WRONG_TOKEN)),
    );
    const statuses = responses.map((r) => r.status).sort();

    // 5 attempts fit in the window; the 6th one is rejected with 429.
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    // A wrong token never yields a session.
    expect(statuses).not.toContain(200);
    for (const res of responses) {
      expect(res.headers.get('set-cookie')).toBeNull();
    }

    const limited = responses.find((r) => r.status === 429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
