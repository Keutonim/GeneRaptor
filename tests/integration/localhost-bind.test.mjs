/**
 * Real-process e2e for the network and auth contract:
 *
 *   - server binds to 127.0.0.1 ONLY: health reachable on loopback, a LAN
 *     interface connect is refused;
 *   - the one-time token is printed to CLI stdout (parseable banner);
 *   - token -> session works for REST and the WS handshake;
 *   - repeat exchange with the same token -> 401;
 *   - restart: old session cookie dead (401) and old token dead (401), new
 *     token printed and working;
 *   - --no-auth (ACCESS_GATE_DISABLED) prints the loud warning and the API
 *     works without any token/cookie.
 *
 * Boots `node server/index.mjs` as a real child process against the vitest
 * SQLite database (DATABASE_URL inherited from tests/global-setup.mjs).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
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

/**
 * Start the real server. Resolves { child, port, baseUrl, getStdout, waitReady, stop }.
 * `extraEnv` overrides the inherited vitest environment.
 */
function startServer(extraEnv = {}) {
  const ready = startServer._pending || (startServer._pending = []);
  let stdout = '';
  let stderr = '';

  return (async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        COOKIE_SECURE: 'false',
        GENERAPTOR_API_PORT: String(port),
        // The vitest process runs with the gate off; the child must run REAL auth.
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
        // Escalate if the graceful SIGTERM path stalls, then resolve regardless.
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 2500).unref();
        setTimeout(done, 4000).unref();
      });
    }

    return { child, port, baseUrl, getStdout: () => stdout, getStderr: () => stderr, waitReady, stop };
  })().then((handle) => {
    ready.push(handle.stop);
    return handle;
  });
}

afterAll(async () => {
  // Belt and braces: kill anything this file spawned (idempotent — tests
  // already stopped their own servers; each stop resolves fast when dead).
  for (const stop of startServer._pending ?? []) await stop();
}, 30_000);

/** Extract the one-time token from the boot banner. */
function tokenFromStdout(stdout) {
  const match = stdout.match(/^\[Auth\] token: (\S+)$/m);
  if (!match) throw new Error(`no token banner in stdout:\n${stdout}`);
  return match[1];
}

/** First non-internal IPv4 LAN address of this machine (or null). */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** Try a TCP connect; resolves true iff the connection succeeded. */
function canConnect(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

describe('M4 e2e: real server process', () => {
  it(
    'prints the token, binds loopback-only, exchanges for REST+WS, invalidates on repeat',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();

        // AC: token printed to CLI stdout.
        const token = tokenFromStdout(srv.getStdout());
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // AC: listener on 127.0.0.1 only — loopback reachable…
        expect(await canConnect('127.0.0.1', srv.port)).toBe(true);
        // …and a LAN interface refused.
        const lan = lanAddress();
        if (lan && lan !== '127.0.0.1') {
          expect(await canConnect(lan, srv.port)).toBe(false);
        }

        // AC: no session -> 401 on the API (protected route, no DB needed).
        const anon = await fetch(`${srv.baseUrl}/api/settings/api-keys`);
        expect(anon.status).toBe(401);

        // AC: token from CLI -> session works (REST).
        const ex = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(ex.status).toBe(200);
        const cookie = ex.headers.get('set-cookie').split(';')[0];

        const authed = await fetch(`${srv.baseUrl}/api/settings/api-keys`, {
          headers: { Cookie: cookie },
        });
        expect(authed.status).toBe(200);

        // AC: session works incl. WS (progress channel handshake).
        const wsOk = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, {
            headers: { Cookie: cookie },
          });
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            resolve(msg.type === 'connected');
            ws.close();
          });
          ws.on('unexpected-response', (_req, res) =>
            resolve(`rejected:${res.statusCode}`)
          );
          ws.on('error', (err) => resolve(`error:${err.message}`));
        });
        expect(wsOk).toBe(true);

        // AC: repeat exchange with the same token -> 401.
        const repeat = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(repeat.status).toBe(401);

        // AC: wrong token x6 -> rate-limited (fresh limiter state per boot).
        const other = await startServer();
        try {
          await other.waitReady();
          for (let i = 0; i < 5; i++) {
            const r = await fetch(`${other.baseUrl}/api/auth/exchange`, {
              method: 'POST',
              headers: { Authorization: 'Bearer wrong-token-attempt' },
            });
            expect(r.status).toBe(401);
          }
          const sixth = await fetch(`${other.baseUrl}/api/auth/exchange`, {
            method: 'POST',
            headers: { Authorization: 'Bearer wrong-token-attempt' },
          });
          expect(sixth.status).toBe(429);
        } finally {
          await other.stop();
        }
      } finally {
        await srv.stop();
      }
    },
    120_000
  );

  it(
    'restart kills the old session and the old token; a fresh token is printed',
    async () => {
      const first = await startServer();
      let token;
      let cookie;
      try {
        await first.waitReady();
        token = tokenFromStdout(first.getStdout());
        const ex = await fetch(`${first.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(ex.status).toBe(200);
        cookie = ex.headers.get('set-cookie').split(';')[0];
      } finally {
        await first.stop();
      }

      const second = await startServer();
      try {
        await second.waitReady();
        const newToken = tokenFromStdout(second.getStdout());
        expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(newToken).not.toBe(token);

        // Old session cookie: dead after restart (per-process signing key).
        const oldCookie = await fetch(`${second.baseUrl}/api/settings/api-keys`, {
          headers: { Cookie: cookie },
        });
        expect(oldCookie.status).toBe(401);

        // Old one-time token: dead after restart (new process, new token).
        const oldToken = await fetch(`${second.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(oldToken.status).toBe(401);

        // The new token exchanges fine.
        const fresh = await fetch(`${second.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${newToken}` },
        });
        expect(fresh.status).toBe(200);
      } finally {
        await second.stop();
      }
    },
    120_000
  );

  it(
    '--no-auth prints a loud warning and the API works without a token',
    async () => {
      const srv = await startServer({ ACCESS_GATE_DISABLED: 'true' });
      try {
        await srv.waitReady();
        // Loud warning in the boot output (console.warn -> stderr).
        expect(`${srv.getStdout()}\n${srv.getStderr()}`).toMatch(
          /WARNING: AUTH IS DISABLED/
        );
        // Protected API reachable with no cookie at all.
        const res = await fetch(`${srv.baseUrl}/api/settings/api-keys`);
        expect(res.status).not.toBe(401);
      } finally {
        await srv.stop();
      }
    },
    120_000
  );
});
