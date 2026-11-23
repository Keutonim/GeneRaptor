/**
 * Defect D8 (hardening round): the --no-auth warning was printed TWICE.
 *
 * Symptom: `npm start -- --no-auth` showed the loud "WARNING: AUTH IS
 * DISABLED" banner twice — the launcher (start.mjs) printed it, then the API
 * server it spawns printed it again, because the launcher maps --no-auth onto
 * ACCESS_GATE_DISABLED=true and the child inherits that env.
 *
 * Contract pinned here (real processes, real output):
 *   1. `node server/index.mjs` with ACCESS_GATE_DISABLED=true owns the
 *      warning and prints it EXACTLY once.
 *   2. `node server/index.mjs` stays SILENT when the launcher already warned
 *      (the child is marked with GENERAPTOR_NO_AUTH_WARNING_SHOWN).
 *   3. `node start.mjs --no-auth --api-only` therefore shows the warning
 *      EXACTLY once across the combined launcher + API output.
 *
 * The marker name is pinned by tests/unit/launcher-args.test.mjs against the
 * exported constant, so the literal here cannot drift silently.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const WARNING = 'WARNING: AUTH IS DISABLED';
/** Env marker set by the launcher once it printed the warning itself. */
const NO_AUTH_WARNING_SHOWN = 'GENERAPTOR_NO_AUTH_WARNING_SHOWN';
const SERVER_READY = '[GeneRaptor] Server started successfully';

/** Every process this file spawned (cleaned up in afterAll). */
const spawned = [];

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

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Spawn a node process in the repo root with a deterministic auth env.
 * stdout+stderr are merged into one buffer: the launcher prints the warning on
 * stdout, the server prints it on stderr — the user sees both.
 */
function spawnNode(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      ACCESS_GATE_HMAC_KEY: '',
      JWT_SECRET: '',
      GENERAPTOR_TOKEN: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
      [NO_AUTH_WARNING_SHOWN]: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: own process group so the whole tree can be signalled at once.
    detached: process.platform !== 'win32',
  });
  spawned.push(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));
  return { child, output: () => out };
}

/** Wait until `needle` shows up in the captured output. */
async function waitForOutput(getOutput, needle, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getOutput().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for "${needle}".\n--- output ---\n${getOutput()}`);
}

/** Kill the spawned process and every child it started; resolves when dead. */
function stopTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    // /T kills the whole tree (the launcher owns the API server child).
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  // Never hang the suite: resolve anyway after the grace period.
  return Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

afterAll(async () => {
  // Belt and braces: every spawned server must be gone before the shared
  // test database temp dir is removed (Windows keeps the SQLite file locked).
  for (const child of spawned) await stopTree(child);
}, 30_000);

describe('D8: the --no-auth warning is shown exactly once', () => {
  it(
    'server/index.mjs prints the warning once when the access gate is disabled',
    async () => {
      const port = await freePort();
      const { child, output } = spawnNode(['server/index.mjs'], {
        ACCESS_GATE_DISABLED: 'true',
        GENERAPTOR_API_PORT: String(port),
      });
      try {
        await waitForOutput(output, SERVER_READY);
        expect(countOccurrences(output(), WARNING)).toBe(1);
      } finally {
        await stopTree(child);
      }
    },
    60_000
  );

  it(
    'server/index.mjs stays silent when the launcher already printed the warning',
    async () => {
      const port = await freePort();
      const { child, output } = spawnNode(['server/index.mjs'], {
        ACCESS_GATE_DISABLED: 'true',
        [NO_AUTH_WARNING_SHOWN]: 'true',
        GENERAPTOR_API_PORT: String(port),
      });
      try {
        await waitForOutput(output, SERVER_READY);
        expect(countOccurrences(output(), WARNING)).toBe(0);
      } finally {
        await stopTree(child);
      }
    },
    60_000
  );

  it(
    'start.mjs --no-auth warns once for the user (launcher + API server)',
    async () => {
      const port = await freePort();
      const dataDir = mkdtempSync(join(os.tmpdir(), 'generaptor-noauth-'));
      const { child, output } = spawnNode(
        ['start.mjs', '--no-auth', '--api-only', '--data-dir', dataDir],
        {
          // The launcher owns --no-auth; the env must not pre-enable the gate.
          ACCESS_GATE_DISABLED: '',
          GENERAPTOR_API_PORT: String(port),
        }
      );
      try {
        await waitForOutput(output, SERVER_READY);
        expect(countOccurrences(output(), WARNING)).toBe(1);
      } finally {
        await stopTree(child);
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
