/**
 * SEC-03 regression: Host / Origin validation (CWE-346 / CWE-601).
 *
 * Root cause (AppSec SEC-03): the server accepted ANY Host header and ANY
 * Origin on the state-changing API surface. A request forged with
 * `Host: evil.example` or `Origin: http://evil.example` was processed by the
 * server as if it came from the local UI, which is the classic DNS-rebinding
 * / cross-site request vector for a browser-reachable localhost tool.
 *
 * Contract under test:
 *   - the Host header must name one of the server's own hosts AND the actual
 *     port the server listens on (the port from the request, never the one
 *     the Host header claims) — otherwise 403;
 *   - a state-changing request (POST/PUT/PATCH/DELETE under /api/*) with an
 *     Origin (or, when it is absent, a Referer) that is not the server's own
 *     origin is rejected with 403;
 *   - a missing Origin is allowed (non-browser clients keep working);
 *   - the WebSocket upgrade obeys the same origin rule.
 *
 * The REAL server (`node server/index.mjs`) is booted — the real Express app,
 * the real middleware, a real listen on 127.0.0.1. No mocked Express.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/** Grab a free TCP port (bind :0, read the port, release). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Start the REAL server (loopback bind, real auth). */
async function startServer(extraEnv = {}) {
  let stdout = '';
  let stderr = '';

  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      GENERAPTOR_API_PORT: String(port),
      ACCESS_GATE_DISABLED: '',
      ACCESS_GATE_HMAC_KEY: '',
      JWT_SECRET: '',
      GENERAPTOR_TOKEN: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;

  async function waitReady(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (child.exitCode !== null) {
        throw new Error(`server exited early (code ${child.exitCode})\n${stdout}\n${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`server not ready in ${timeoutMs}ms\n${stdout}\n${stderr}`);
  }

  function stop() {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      child.on('exit', done);
      child.kill();
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2500).unref();
      setTimeout(done, 4000).unref();
    });
  }

  return { child, port, baseUrl, getStdout: () => stdout, getStderr: () => stderr, waitReady, stop };
}

/** Raw HTTP request so the Host header can be forged (undici forbids it). */
function rawRequest({ port, method = 'GET', path = '/api/health', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Open a WS connection and report the handshake outcome. */
function wsHandshake(port, { origin, cookie } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    ws.on('open', () => finish({ status: 101 }));
    ws.on('error', (err) => finish({ status: null, error: err.message }));
    setTimeout(() => finish({ status: null, error: 'timeout' }), 8000);
  });
}

describe('SEC-03: Host and Origin are validated', () => {
  it(
    'rejects a foreign Host header and keeps the own host working',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();

        // A foreign Host is refused — the port is taken from the request.
        const foreign = await rawRequest({ port: srv.port, path: '/api/health', headers: { Host: 'evil.example' } });
        expect(foreign.status).toBe(403);

        // The own host with the own port works.
        const own = await rawRequest({
          port: srv.port,
          path: '/api/health',
          headers: { Host: `127.0.0.1:${srv.port}` },
        });
        expect(own.status).toBe(200);

        // The own host with a WRONG port is refused.
        const wrongPort = await rawRequest({
          port: srv.port,
          path: '/api/health',
          headers: { Host: `127.0.0.1:${srv.port + 1}` },
        });
        expect(wrongPort.status).toBe(403);

        // The gate still answers 401 for a protected path with a valid Host.
        const gated = await rawRequest({
          port: srv.port,
          path: '/api/articles',
          headers: { Host: `localhost:${srv.port}` },
        });
        expect(gated.status).toBe(401);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'rejects a foreign Origin on a state-changing request and allows a missing one',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();

        const foreign = await rawRequest({
          port: srv.port,
          method: 'POST',
          path: '/api/auth/exchange',
          headers: {
            Host: `127.0.0.1:${srv.port}`,
            Origin: 'http://evil.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        expect(foreign.status).toBe(403);

        // The own origin (the UI is served by this very server) is allowed.
        const own = await rawRequest({
          port: srv.port,
          method: 'POST',
          path: '/api/auth/exchange',
          headers: {
            Host: `127.0.0.1:${srv.port}`,
            Origin: `http://127.0.0.1:${srv.port}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        expect(own.status).not.toBe(403);

        // A missing Origin is allowed (CLI / non-browser clients).
        const noOrigin = await rawRequest({
          port: srv.port,
          method: 'POST',
          path: '/api/auth/exchange',
          headers: {
            Host: `127.0.0.1:${srv.port}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        expect(noOrigin.status).not.toBe(403);

        // A foreign Referer is used when there is no Origin.
        const foreignReferer = await rawRequest({
          port: srv.port,
          method: 'POST',
          path: '/api/auth/exchange',
          headers: {
            Host: `127.0.0.1:${srv.port}`,
            Referer: 'http://evil.example/page',
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        expect(foreignReferer.status).toBe(403);

        // A read-only request with a foreign Origin is NOT blocked by this rule.
        const read = await rawRequest({
          port: srv.port,
          method: 'GET',
          path: '/api/health',
          headers: { Host: `127.0.0.1:${srv.port}`, Origin: 'http://evil.example' },
        });
        expect(read.status).toBe(200);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'rejects a WebSocket upgrade with a foreign Origin',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();

        const foreign = await wsHandshake(srv.port, { origin: 'http://evil.example' });
        expect(foreign.status).toBeNull();
        expect(foreign.error).toContain('403');

        const own = await wsHandshake(srv.port, { origin: `http://127.0.0.1:${srv.port}` });
        // The origin is fine, but the session cookie is missing -> 401.
        expect(own.error).toContain('401');
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );
});

afterAll(async () => {
  // Nothing global to clean: every test stops its own child.
});
