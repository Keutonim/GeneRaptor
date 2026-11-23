/**
 * S5 T1 (round 2) — the dev-UI-origin marker on the REAL server (SEC-03).
 *
 * Root cause of the owner's bug (results/s5-security-verify.md §3.1): the mode
 * was derived from NODE_ENV. The owner's .env sets NODE_ENV=production, so the
 * alias was never enabled in the dev topology and `Origin: http://localhost:<ui>`
 * kept answering 403 «Запрещённый Origin» on every state-changing request
 * (DELETE /api/articles/:id included) while reads kept working.
 *
 * Contract under test:
 *   - the marker is the argv flag `--dev-ui-origin <origin>` the launcher passes
 *     to the API child WHEN IT STARTS VITE ITSELF. NODE_ENV takes no part in the
 *     decision: production + marker => the synonym is accepted (the owner's
 *     case); development WITHOUT a marker => nothing is widened (--api-only and
 *     packaged semantics);
 *   - the alias lives in the GUARD set only. The CORS preflight never echoes the
 *     synonym: Access-Control-Allow-Origin stays the configured CORS_ORIGIN, so
 *     the reading surface with cookies is not widened (I10);
 *   - the WS upgrade obeys the same set (401 without a cookie, never 403);
 *   - a foreign Origin / another port / a subdomain / 'null' is ALWAYS refused;
 *   - every refusal is logged through sanitizeLogText (CWE-778 / CWE-117), and
 *     the effective origin set + the active alias are logged at startup.
 *
 * The REAL server (`node server/index.mjs`) is booted — no mocked Express.
 * I1-I12 of results/s5-security-pre.md §3.5.
 */
import { describe, expect, it } from 'vitest';
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

/**
 * Start the REAL server (loopback bind, real auth).
 * `extraArgs` is the launcher-shaped argv tail — the marker travels as a flag,
 * never as an environment variable.
 */
async function startServer(extraEnv = {}, extraArgs = []) {
  let stdout = '';
  let stderr = '';

  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs', ...extraArgs], {
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
      CORS_ORIGIN: '',
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

  return {
    child,
    port,
    baseUrl,
    getStdout: () => stdout,
    getStderr: () => stderr,
    // Operational logs: console.log goes to stdout, console.warn to stderr —
    // the [Origin] lines must be assertable regardless of the stream.
    getOutput: () => stdout + stderr,
    waitReady,
    stop,
  };
}

/** Raw HTTP request so Origin/Host headers can be set freely. */
function rawRequest({ port, method = 'POST', path = '/api/auth/exchange', headers = {}, body = '{}' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Write request bytes straight onto a socket. Needed for header values the
 * Node HTTP client refuses to send (a TAB inside Origin) — the server parser
 * DOES accept a TAB, so it is a real log-injection vector (CWE-117).
 */
function socketRequest(port, requestText) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(requestText));
    let buf = '';
    const finish = () => {
      const head = buf.split('\r\n\r\n')[0] || '';
      resolve({ statusLine: head.split('\r\n')[0] || '', head });
    };
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.destroy();
        finish();
      }
    });
    sock.on('close', finish);
    sock.on('error', finish);
    setTimeout(() => {
      sock.destroy();
      finish();
    }, 5000).unref();
  });
}

/** A state-changing POST with the given Origin (Host = the real API origin). */
function postWithOrigin(srv, origin) {
  return rawRequest({
    port: srv.port,
    headers: {
      Host: `127.0.0.1:${srv.port}`,
      Origin: origin,
      'Content-Type': 'application/json',
    },
  });
}

/** An OPTIONS preflight for a DELETE, with the given Origin. */
function preflight(srv, origin) {
  return rawRequest({
    port: srv.port,
    method: 'OPTIONS',
    path: '/api/articles/11111111-1111-4111-8111-000000000001',
    headers: {
      Host: `127.0.0.1:${srv.port}`,
      Origin: origin,
      'Access-Control-Request-Method': 'DELETE',
    },
    body: '',
  });
}

/** Open a WS connection and report the handshake outcome. */
function wsHandshake(port, { origin } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (origin) headers.Origin = origin;
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

/** The loopback spelling that is NOT the configured one. */
function otherSpelling(origin) {
  return origin.includes('localhost')
    ? origin.replace('localhost', '127.0.0.1')
    : origin.replace('127.0.0.1', 'localhost');
}

/**
 * Wait for a log substring. The child's stdout/stderr are pipes: a chunk can
 * reach the parent AFTER the HTTP response that triggered it, so asserting on
 * the log immediately after a request is a race.
 */
async function waitForLog(srv, substring, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (srv.getOutput().includes(substring)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('S5 T1: the dev-UI-origin marker (SEC-03 stays strict)', () => {
  it(
    'I1/I2/I9/I10: with the marker both spellings pass the guard and the WS upgrade, and ACAO is NOT widened',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const synonym = `http://localhost:${uiPort}`;
      const srv = await startServer(
        { CORS_ORIGIN: configured },
        ['--dev-ui-origin', configured],
      );
      try {
        await srv.waitReady();

        // I1 — the configured spelling keeps working.
        expect((await postWithOrigin(srv, configured)).status).not.toBe(403);
        // I2 — the synonym the browser may actually open: the S5 deletion bug.
        expect((await postWithOrigin(srv, synonym)).status).not.toBe(403);

        // I10 — the reading surface is NOT widened: ACAO is either absent or
        // exactly the configured CORS_ORIGIN, never the synonym itself.
        for (const origin of [configured, synonym]) {
          const res = await preflight(srv, origin);
          const acao = res.headers['access-control-allow-origin'];
          expect(acao === undefined || acao === configured).toBe(true);
          expect(acao).not.toBe(synonym);
        }

        // I9 — the WS upgrade obeys the same set: origin fine → 401 (no cookie).
        const ws = await wsHandshake(srv.port, { origin: synonym });
        expect(ws.error).toContain('401');
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'OWNER REGRESSION: NODE_ENV=production + the launcher marker still accepts the synonym',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const srv = await startServer(
        // Exactly the owner's .env: NODE_ENV=production while the launcher
        // starts Vite (no dist/ in that checkout) and hands over the marker.
        { NODE_ENV: 'production', CORS_ORIGIN: configured },
        ['--dev-ui-origin', configured],
      );
      try {
        await srv.waitReady();

        expect((await postWithOrigin(srv, configured)).status).not.toBe(403);
        expect((await postWithOrigin(srv, `http://localhost:${uiPort}`)).status).not.toBe(403);

        // The topology/NODE_ENV mismatch is announced, not silently ignored.
        expect(await waitForLog(srv, '[Origin] WARNING: NODE_ENV=production')).toBe(true);

        // Nothing else is widened by the marker.
        expect((await postWithOrigin(srv, 'http://evil.example')).status).toBe(403);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'I3 + MODE REGRESSION: NODE_ENV=development WITHOUT a marker widens nothing (--api-only / packaged)',
    async () => {
      const uiPort = await freePort();
      const configured = `http://localhost:${uiPort}`;
      // No --dev-ui-origin: this is what the launcher emits for --api-only and
      // for the packaged build. An ambient NODE_ENV=development must not help.
      const srv = await startServer({ NODE_ENV: 'development', CORS_ORIGIN: configured });
      try {
        await srv.waitReady();

        expect((await postWithOrigin(srv, configured)).status).not.toBe(403);
        expect((await postWithOrigin(srv, `http://127.0.0.1:${uiPort}`)).status).toBe(403);
        expect((await postWithOrigin(srv, 'http://evil.example')).status).toBe(403);

        // No alias line at startup — the marker is absent. Wait for the boot
        // log first, so the negative assertion cannot pass on a race.
        expect(await waitForLog(srv, '[Origin] allowed origins:')).toBe(true);
        expect(srv.getOutput()).not.toContain('loopback alias enabled');
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'I8: NODE_ENV=production without a marker stays same-origin-only',
    async () => {
      const uiPort = await freePort();
      const srv = await startServer({
        NODE_ENV: 'production',
        CORS_ORIGIN: `http://localhost:${uiPort}`,
      });
      try {
        await srv.waitReady();

        expect((await postWithOrigin(srv, `http://localhost:${uiPort}`)).status).not.toBe(403);
        expect((await postWithOrigin(srv, `http://127.0.0.1:${uiPort}`)).status).toBe(403);
        expect((await postWithOrigin(srv, 'http://evil.example')).status).toBe(403);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'I4/I5/I6/I7: with the marker a foreign Origin, another port, a subdomain and null are refused',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const srv = await startServer({ CORS_ORIGIN: configured }, ['--dev-ui-origin', configured]);
      try {
        await srv.waitReady();

        // I4 — a foreign host.
        expect((await postWithOrigin(srv, 'http://evil.example')).status).toBe(403);
        // I5 — the same loopback name on a WRONG port (never the API's own port).
        const wrongPort = uiPort + 1 === srv.port ? uiPort + 2 : uiPort + 1;
        expect((await postWithOrigin(srv, `http://localhost:${wrongPort}`)).status).toBe(403);
        expect((await postWithOrigin(srv, `http://127.0.0.1:${wrongPort}`)).status).toBe(403);
        // I6 — a subdomain of localhost is not localhost.
        expect((await postWithOrigin(srv, `http://app.localhost:${uiPort}`)).status).toBe(403);
        // I7 — the sandboxed-iframe / file:// origin.
        expect((await postWithOrigin(srv, 'null')).status).toBe(403);
        // A foreign name that merely resolves to loopback is not an alias.
        expect((await postWithOrigin(srv, `http://localtest.me:${uiPort}`)).status).toBe(403);
        // ::1 is NOT aliased (director decision) — only the two IPv4/name spellings.
        expect((await postWithOrigin(srv, `http://[::1]:${uiPort}`)).status).toBe(403);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'I11: a read-only GET with a foreign Origin is not blocked (read regression)',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const srv = await startServer({ CORS_ORIGIN: configured }, ['--dev-ui-origin', configured]);
      try {
        await srv.waitReady();

        const read = await rawRequest({
          port: srv.port,
          method: 'GET',
          path: '/api/health',
          headers: { Host: `127.0.0.1:${srv.port}`, Origin: 'http://evil.example' },
          body: '',
        });
        expect(read.status).toBe(200);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'I12: every refusal is logged, and the logged Origin is sanitized (CWE-778 / CWE-117)',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const srv = await startServer({ CORS_ORIGIN: configured }, ['--dev-ui-origin', configured]);
      try {
        await srv.waitReady();

        // A plain foreign Origin: the refusal is observable (CWE-778).
        expect((await postWithOrigin(srv, 'http://evil.example')).status).toBe(403);
        expect(await waitForLog(srv, '[Origin] rejected origin: http://evil.example')).toBe(true);

        // The WS handshake logs its refusal too.
        const ws = await wsHandshake(srv.port, { origin: 'http://ws-evil.example' });
        expect(ws.error).toContain('403');
        expect(await waitForLog(srv, '[Origin] rejected origin: http://ws-evil.example')).toBe(true);

        // A TAB inside Origin SURVIVES the Node HTTP parser (verified) — it must
        // not reach the log raw. sanitizeLogText flattens it to a space.
        const tabbed = 'http://tab-evil.example/\tinject';
        const tabRes = await socketRequest(
          srv.port,
          `POST /api/auth/exchange HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nOrigin: ${tabbed}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
        );
        expect(tabRes.statusLine).toContain('403');
        expect(await waitForLog(srv, '[Origin] rejected origin: http://tab-evil.example/ inject')).toBe(true);
        expect(srv.getOutput()).not.toContain('\tinject');

        // A long value is bounded by the sanitizer (120 chars + the ellipsis).
        const long = `http://long-evil.example/${'a'.repeat(300)}`;
        expect((await postWithOrigin(srv, long)).status).toBe(403);
        expect(await waitForLog(srv, '[Origin] rejected origin: http://long-evil.example/')).toBe(true);
        const line = srv
          .getOutput()
          .split('\n')
          .find((l) => l.includes('[Origin] rejected origin: http://long-evil.example/'));
        expect(line).toBeDefined();
        expect(line).toContain('…');
        expect(line.length).toBeLessThan('[Origin] rejected origin: '.length + 121 + 2);
        // The injected value cannot forge a second log line.
        expect(line).not.toContain('aaa\n');
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'startup logs the effective origin set and the active alias (CWE-778)',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const srv = await startServer({ CORS_ORIGIN: configured }, ['--dev-ui-origin', configured]);
      try {
        await srv.waitReady();
        expect(await waitForLog(srv, '[Origin] allowed origins:')).toBe(true);

        const out = srv.getOutput();
        const allowedLine = out.split('\n').find((l) => l.startsWith('[Origin] allowed origins:'));
        expect(allowedLine).toBeDefined();
        expect(allowedLine).toContain(`http://127.0.0.1:${srv.port}`);
        expect(allowedLine).toContain(`http://localhost:${srv.port}`);
        expect(allowedLine).toContain(configured);
        expect(allowedLine).toContain(`http://localhost:${uiPort}`);

        expect(out).toContain(
          `[Origin] dev UI origin: ${configured} (loopback alias enabled: http://localhost:${uiPort})`,
        );
        // No secret material in these lines.
        expect(allowedLine).not.toMatch(/token|secret|key/i);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );

  it(
    'an invalid marker is ignored fail-closed (no port, a list, a non-loopback host)',
    async () => {
      const uiPort = await freePort();
      const configured = `http://localhost:${uiPort}`;
      const synonym = `http://127.0.0.1:${uiPort}`;
      for (const marker of [
        'http://127.0.0.1',
        `${configured},${synonym}`,
        `http://192.168.1.10:${uiPort}`,
        'null',
      ]) {
        const srv = await startServer({ CORS_ORIGIN: configured }, ['--dev-ui-origin', marker]);
        try {
          await srv.waitReady();
          expect((await postWithOrigin(srv, configured)).status).not.toBe(403);
          expect((await postWithOrigin(srv, synonym)).status).toBe(403);
          expect(await waitForLog(srv, '[Origin] allowed origins:')).toBe(true);
          expect(srv.getOutput()).not.toContain('loopback alias enabled');
        } finally {
          await srv.stop();
        }
      }
    },
    180_000,
  );

  it(
    'the --dev-ui-origin=<value> form is accepted exactly like the spaced form',
    async () => {
      const uiPort = await freePort();
      const configured = `http://127.0.0.1:${uiPort}`;
      const srv = await startServer(
        { CORS_ORIGIN: configured },
        [`--dev-ui-origin=${configured}`],
      );
      try {
        await srv.waitReady();
        expect((await postWithOrigin(srv, otherSpelling(configured))).status).not.toBe(403);
      } finally {
        await srv.stop();
      }
    },
    60_000,
  );
});
