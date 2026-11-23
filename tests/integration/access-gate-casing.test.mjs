/**
 * SEC-01 regression: the access gate must decide case-INSENSITIVELY.
 *
 * Root cause (AppSec SEC-01): the gate middleware decided "is this a
 * protected API request?" with the case-SENSITIVE check
 * `req.path.startsWith('/api/')`, while Express matches mount paths
 * case-insensitively (`app.use('/api', articlesRouter)`). A request for
 * `/API/articles` therefore skipped the gate (HTTP 200) even though the very
 * same resource under `/api/articles` returned 401.
 *
 * This suite boots the REAL server (`node server/index.mjs` — the real
 * Express app, the real `requireGate`, a real listen on 127.0.0.1) and
 * asserts the gate over the wire. No mocked Express, no in-process stub.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
 * Start the REAL server with the access gate ARMED (no cookie -> 401).
 * `extraEnv` overrides the inherited vitest environment.
 */
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
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2500).unref();
      setTimeout(done, 4000).unref();
    });
  }

  return { child, port, baseUrl, getStdout: () => stdout, getStderr: () => stderr, waitReady, stop };
}

/** Extract the one-time token from the boot banner (value never printed). */
function tokenFromStdout(stdout) {
  const match = stdout.match(/^\[Auth\] token: (\S+)$/m);
  if (!match) throw new Error(`no token banner in stdout:\n${stdout}`);
  return match[1];
}

describe('SEC-01: the access gate protects the API case-insensitively', () => {
  it(
    'rejects non-canonical casing of protected API paths and keeps the public ones open',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();

        // Protected surface — every casing variant must be gated (401).
        const protectedPaths = [
          '/api/articles',
          '/API/articles',
          '/Api/articles',
          '/api/ARTICLES',
          '/API/settings/providers',
          '/api/SETTINGS/providers',
          '/API/settings/api-keys',
        ];
        for (const path of protectedPaths) {
          const res = await fetch(`${srv.baseUrl}${path}`);
          expect(res.status, `${path} must be gated`).toBe(401);
        }

        // Public surface — the health check stays reachable in any casing.
        for (const path of ['/api/health', '/API/health']) {
          const res = await fetch(`${srv.baseUrl}${path}`);
          expect(res.status, `${path} must stay public`).toBe(200);
          const body = await res.json();
          expect(body.status).toBe('ok');
        }
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'lets a valid session cookie through on a non-canonical casing and keeps the replay/rate-limit rules',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();
        const token = tokenFromStdout(srv.getStdout());

        // token -> session cookie (the cookie VALUE is never printed).
        const ex = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(ex.status).toBe(200);
        const cookie = ex.headers.get('set-cookie').split(';')[0];

        // The session cookie opens the gate for the cased path too.
        const authed = await fetch(`${srv.baseUrl}/API/articles`, { headers: { Cookie: cookie } });
        expect(authed.status).toBe(200);
        const authedLower = await fetch(`${srv.baseUrl}/api/articles`, { headers: { Cookie: cookie } });
        expect(authedLower.status).toBe(200);

        // Replay of the one-time token is still rejected.
        const replay = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(replay.status).toBe(401);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'rate-limits repeated wrong exchange attempts with 429',
    async () => {
      const srv = await startServer();
      try {
        await srv.waitReady();
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
            method: 'POST',
            headers: { Authorization: 'Bearer wrong-token-attempt' },
          });
          expect(res.status).toBe(401);
        }
        const sixth = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: 'Bearer wrong-token-attempt' },
        });
        expect(sixth.status).toBe(429);
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
