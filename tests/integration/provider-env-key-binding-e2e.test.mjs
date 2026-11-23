/**
 * SEC-02 end-to-end: an ENVIRONMENT key is NEVER sent to a USER-SUPPLIED URL.
 *
 * Why this suite exists (AppSec SEC-02, CWE-918 / CWE-522):
 *   the provider `baseUrl` stored in the local DB is USER-SUPPLIED, while a
 *   provider key may come from the server environment. Before the fix, a
 *   stored baseUrl silently overrode the canonical endpoint of a fixed kind
 *   and the environment key still won the key resolution — the server then
 *   sent the operator's secret to an attacker-controlled host.
 *
 * The unit/route-level suite (`tests/integration/provider-url-policy.test.mjs`)
 * proves the policy with a STUBBED outbound HTTP client. That is not enough:
 * a helper-only check cannot prove what the process actually puts on the wire.
 * This suite therefore uses REAL sockets on both sides:
 *
 *   - a local "sink" HTTP server stands for the user-supplied provider host
 *     and records every request it receives (method, URL, headers, body);
 *   - the REAL API server (`node server/index.mjs` — real Express app, real
 *     storage, real `fetch`) runs with `CUSTOM_API_KEY` set in the
 *     environment and with a stored `baseUrl` pointing at the sink;
 *   - the operator opt-in `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` is set on
 *     purpose, so the sink IS reachable — the request is NOT blocked by the
 *     private-network policy, and the assertion is about the KEY, not about
 *     the URL being rejected.
 *
 * Contract asserted:
 *   1. the stored (user-supplied) URL is really used — the sink receives the
 *      request, so the test cannot pass vacuously;
 *   2. the environment key never appears in ANY sink request (header or body);
 *   3. the settings card reports the custom kind as key-less while
 *      `CUSTOM_API_KEY` is set in the environment (the env key is not bound
 *      to a user-supplied endpoint);
 *   4. a key STORED for that URL is sent to that URL — and it is still not
 *      the environment key (a stored key stays bound to its own URL).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import net from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const ENV_SECRET = 'env-secret-DO-NOT-LEAK-9f3a';
const STORED_SECRET = 'stored-secret-bound-to-this-url-4b7c';

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

/** The user-supplied provider host: records every request it receives. */
function startSink() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'sink-model-1' }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

/** Isolated SQLite database — the test must not fight other suites for rows. */
function createIsolatedDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'generaptor-envkey-'));
  const dbUrl = `file:${dir.split('\\').join('/')}/generaptor-test.db`;
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`prisma db push failed:\n${result.stdout}\n${result.stderr}`);
  }
  return { dir, dbUrl };
}

/** Start the REAL server with the access gate armed. */
async function startServer({ port, dbUrl }) {
  let stdout = '';
  let stderr = '';

  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      DATABASE_URL: dbUrl,
      GENERAPTOR_API_PORT: String(port),
      ACCESS_GATE_DISABLED: '',
      ACCESS_GATE_HMAC_KEY: '',
      JWT_SECRET: '',
      GENERAPTOR_TOKEN: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
      // The operator opt-in: the sink is a loopback address, so without it the
      // URL would be rejected by the private-network policy and the key
      // binding would never be exercised.
      GENERAPTOR_ALLOW_PRIVATE_NETWORK: 'true',
      CUSTOM_API_KEY: ENV_SECRET,
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

  return { child, baseUrl, getStdout: () => stdout, getStderr: () => stderr, waitReady, stop };
}

/** The one-time startup token (its value is never printed). */
function tokenFromStdout(stdout) {
  const match = stdout.match(/^\[Auth\] token: (\S+)$/m);
  if (!match) throw new Error(`no token banner in stdout:\n${stdout}`);
  return match[1];
}

describe('SEC-02 e2e: the environment key never reaches a user-supplied provider URL', () => {
  let sink;
  let srv;
  let db;
  let cookie;

  beforeAll(async () => {
    sink = await startSink();
    db = createIsolatedDatabase();
    const port = await freePort();
    srv = await startServer({ port, dbUrl: db.dbUrl });
    await srv.waitReady();

    const token = tokenFromStdout(srv.getStdout());
    const ex = await fetch(`${srv.baseUrl}/api/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ex.status).toBe(200);
    cookie = ex.headers.get('set-cookie').split(';')[0];
  }, 90_000);

  afterAll(async () => {
    if (srv) await srv.stop();
    if (sink) await new Promise((resolve) => sink.server.close(resolve));
    if (db?.dir) rmSync(db.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('calls the user-supplied URL but sends no environment key to it', async () => {
    const baseUrl = `http://127.0.0.1:${sink.port}/v1`;

    const saved = await fetch(`${srv.baseUrl}/api/settings/providers/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ baseUrl, enabled: true }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.text();
    expect(savedBody).not.toContain(ENV_SECRET);

    const before = sink.requests.length;
    const catalog = await fetch(`${srv.baseUrl}/api/providers/custom/models`, { headers: { Cookie: cookie } });
    expect(catalog.status).toBe(200);
    const catalogBody = await catalog.text();
    expect(catalogBody).toContain('sink-model-1');
    expect(catalogBody).not.toContain(ENV_SECRET);

    // The sink really received the request — the assertions below are not vacuous.
    const seen = sink.requests.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((r) => String(r.url).includes('/v1/models'))).toBe(true);

    for (const request of seen) {
      const wire = JSON.stringify(request);
      expect(wire, 'the environment key must never be sent to a user-supplied URL').not.toContain(
        ENV_SECRET,
      );
      expect(String(request.headers.authorization || '')).not.toContain(ENV_SECRET);
    }

    // The settings card reports the custom kind as key-less even though
    // CUSTOM_API_KEY is set in the environment.
    const cards = await fetch(`${srv.baseUrl}/api/settings/providers`, { headers: { Cookie: cookie } });
    expect(cards.status).toBe(200);
    const cardBody = await cards.text();
    expect(cardBody).not.toContain(ENV_SECRET);
    const custom = JSON.parse(cardBody).data.providers.find((p) => p.kind === 'custom');
    expect(custom).toBeTruthy();
    expect(custom.keyConfigured).toBe(false);
    expect(custom.keySource).toBe('none');
  }, 60_000);

  it('sends the key STORED for that URL — and it is still not the environment key', async () => {
    const baseUrl = `http://127.0.0.1:${sink.port}/v1`;

    const saved = await fetch(`${srv.baseUrl}/api/settings/providers/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ baseUrl, apiKey: STORED_SECRET, enabled: true }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(STORED_SECRET);

    const before = sink.requests.length;
    const catalog = await fetch(`${srv.baseUrl}/api/providers/custom/models`, { headers: { Cookie: cookie } });
    expect(catalog.status).toBe(200);

    const seen = sink.requests.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    const withAuth = seen.filter((r) => String(r.headers.authorization || '').length > 0);
    expect(withAuth.length).toBeGreaterThan(0);
    for (const request of seen) {
      const auth = String(request.headers.authorization || '');
      expect(auth).not.toContain(ENV_SECRET);
      expect(auth).toContain(STORED_SECRET);
    }
  }, 60_000);
});
