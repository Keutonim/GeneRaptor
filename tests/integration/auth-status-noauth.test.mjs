/**
 * GET /api/auth/status must tell the truth the middleware
 * enforces. With the access gate disabled (--no-auth) every caller IS
 * authorized, so the client boot probe has to see `authenticated: true`
 * without a cookie — otherwise the passwordless shell would show a hint
 * screen in a mode where the gate is off.
 *
 * The response shape stays `{authenticated: boolean}`; only the semantics of
 * the disabled-gate case are clarified (plan D5).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { authRouter } from '../../server/routes/auth.mjs';
import { requireGate, GATE_COOKIE_NAME, createGateToken } from '../../server/lib/auth.mjs';

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use(requireGate);
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

let handle;
afterEach(async () => {
  if (handle) await new Promise((r) => handle.server.close(r));
  handle = undefined;
});
afterAll(() => {
  process.env.ACCESS_GATE_DISABLED = 'true'; // vitest default (vitest.config.ts)
});

async function status(baseUrl, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetch(`${baseUrl}/api/auth/status`, { headers });
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/auth/status vs ACCESS_GATE_DISABLED', () => {
  it('reports authenticated:true with no cookie when the gate is disabled', async () => {
    process.env.ACCESS_GATE_DISABLED = 'true';
    handle = await listen(buildApp());
    expect(await status(handle.baseUrl)).toEqual({ authenticated: true });
  });

  it('reports authenticated:false with no cookie when the gate is enabled', async () => {
    process.env.ACCESS_GATE_DISABLED = 'false';
    handle = await listen(buildApp());
    expect(await status(handle.baseUrl)).toEqual({ authenticated: false });
  });

  it('reports authenticated:true with a valid cookie when the gate is enabled', async () => {
    process.env.ACCESS_GATE_DISABLED = 'false';
    handle = await listen(buildApp());
    const cookie = `${GATE_COOKIE_NAME}=${createGateToken()}`;
    expect(await status(handle.baseUrl, cookie)).toEqual({ authenticated: true });
  });
});