/**
 * FIX-08 / FIX-09: the boot banner must never advertise an address that
 * cannot work.
 *
 * Root cause (both items):
 *   - start.mjs printed "Frontend: disabled (--api-only)" — but the API server
 *     mounts the built SPA from dist/ (server/express-app.mjs), so in a
 *     packaged build the UI IS served at the very same API root;
 *   - server/index.mjs always printed "Paste this token at <api root>" — with
 *     no dist/ build `GET /` there answers 404, so the banner pointed at a
 *     dead address.
 *
 * The suite boots the REAL server twice (once without a build, once with a
 * build) and pins the invariant:
 *
 *   the address the banner advertises MUST be an address where the UI really
 *   is served — otherwise the banner has to say that the UI is missing and
 *   name a way to get it.
 *
 * The server is started from a scratch COPY of the server tree so that both
 * states (with and without dist/) are reproducible without touching the
 * checkout's own dist/. The scratch dir lives under tests/.artifacts/ (already
 * gitignored, outside server/ so the copy is not a self-copy) and is removed
 * in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import net from 'node:net';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SCRATCH = join(ROOT, 'tests', '.artifacts', `ui-banner-test-${process.pid}`);
const SCRATCH_SERVER = join(SCRATCH, 'server');
const SCRATCH_DIST = join(SCRATCH, 'dist');

/** Mask the token value so a failing assertion can never leak it. */
function maskToken(text) {
  return text.replace(/(\[Auth\] token: )[^\s]+/g, '$1***MASKED***');
}

/** Grab a free TCP port (bind :0, read the port, release). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Kill the child and everything it spawned (Windows: taskkill /T). */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/**
 * Boot the (copied) API server and report what the banner said and what the
 * API root really answers.
 *
 * @param {{ withBuild: boolean }} options
 */async function bootServer({ withBuild }) {
  if (withBuild) {
    mkdirSync(SCRATCH_DIST, { recursive: true });
    writeFileSync(
      join(SCRATCH_DIST, 'index.html'),
      '<!doctype html><html><head><title>stub build</title></head><body>stub</body></html>'
    );
  } else {
    rmSync(SCRATCH_DIST, { recursive: true, force: true });
  }

  const port = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [join(SCRATCH_SERVER, 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      GENERAPTOR_API_PORT: String(port),
      PORT: '5173',
      ACCESS_GATE_DISABLED: '',
      ACCESS_GATE_HMAC_KEY: '',
      JWT_SECRET: '',
      GENERAPTOR_TOKEN: 'fixed-dummy-token-not-a-secret',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  try {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (stdout.includes('[GeneRaptor] Server started successfully')) break;
      if (child.exitCode !== null) {
        throw new Error(`server exited early (code ${child.exitCode}):\n${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!stdout.includes('[GeneRaptor] Server started successfully')) {
      throw new Error(`server did not finish booting:\n${maskToken(stdout)}\n${stderr}`);
    }

    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();
    return { banner: maskToken(stdout), status: response.status, body, port };
  } finally {
    killTree(child);
  }
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(ROOT, 'server'), SCRATCH_SERVER, { recursive: true });
}, 60_000);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('FIX-09: the standalone server banner matches what the API root serves', () => {
  it('does not advertise the API root when there is no build (GET / is 404)', async () => {
    const { banner, status, body, port } = await bootServer({ withBuild: false });

    expect(status).toBe(404);
    expect(body).toMatch(/Not found/);
    // The API root cannot unlock the app -> it must not be advertised.
    expect(banner).not.toMatch(
      new RegExp(`\\[Auth\\] Paste this token at http://127\\.0\\.0\\.1:${port} to unlock`)
    );
    // The banner must name a way to get the UI instead.
    expect(banner).toMatch(/npm run dev|npm run build/);
  }, 90_000);

  it('advertises the API root when the build is served there', async () => {
    const { banner, status, body, port } = await bootServer({ withBuild: true });

    expect(status).toBe(200);
    expect(body).toMatch(/stub build/);
    expect(banner).toMatch(
      new RegExp(`\\[Auth\\] Paste this token at http://127\\.0\\.0\\.1:${port} to unlock`)
    );
  }, 90_000);
});
