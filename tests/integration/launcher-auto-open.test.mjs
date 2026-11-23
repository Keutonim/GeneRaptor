/**
 * The REAL launcher must never open a browser in a
 * headless/CI run, and must never print the token a second time.
 *
 * Real processes, no mocks: `node start.mjs --api-only --port <free>` is
 * spawned with a piped stdout (so the process is not a TTY) and with the
 * guard under test set explicitly. The suite pins:
 *
 *   - `--no-browser` is a documented flag (CLI help);
 *   - with CI=true there is NO auto-open line, the one-time token banner
 *     appears EXACTLY once, and the API really answers /api/health;
 *   - with --no-browser (and no CI) the same holds — the operator flag is a
 *     soft rollback to the manual scenario;
 *   - no printed line ever carries the token in a URL fragment.
 *
 * The positive auto-open path cannot be observed from a test process (stdout
 * is piped, never a TTY) — it is pinned by the unit decision matrix in
 * tests/unit/open-browser.test.mjs and by the live probe P1.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

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
 * Boot the real launcher. The auth env is deliberately cleared so the
 * launcher generates its own one-time token; NODE_ENV is cleared too, so the
 * guard under test (CI / --no-browser) is the one that decides.
 */
async function bootLauncher(args, envPatch = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'generaptor-autoopen-'));
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['start.mjs', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: '',
      CI: '',
      GENERAPTOR_DATA_DIR: dataDir,
      GENERAPTOR_API_PORT: '',
      PORT: '',
      ACCESS_GATE_DISABLED: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
      ...envPatch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (stdout.includes('[3/3] Ready.')) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    child,
    raw: () => stdout + stderr,
    output: () => maskToken(stdout + stderr),
    stop: async () => {
      killTree(child);
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}

/** Poll until the API answers on `port` (the child binds after "Ready."). */
async function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.status;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return null;
}

/** Run a short-lived launcher command (--help) and collect its output. */
function runToExit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['start.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: '', CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('Browser auto-open is guarded in headless runs', () => {
  it('documents --no-browser in the CLI help', async () => {
    const { code, out } = await runToExit(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('--no-browser');
  });

  it(
    'CI=true: no auto-open, the token banner once, the API alive',
    async () => {
      const port = await freePort();
      const launcher = await bootLauncher(['--api-only', '--port', String(port)], { CI: 'true' });
      try {
        expect(await waitForHealth(port)).toBe(200);
        const raw = launcher.raw();
        // No auto-open announcement at all.
        expect(raw).not.toContain('Opening the app');
        expect(raw).not.toContain('Browser did not open');
        // The one-time token is printed exactly once, on the banner line.
        const tokens = [...raw.matchAll(/^\[Auth\] token: (\S+)$/gm)].map((m) => m[1]);
        expect(tokens).toHaveLength(1);
        expect(raw.split(tokens[0]).length - 1).toBe(1);
        // No printed URL carries the token fragment.
        expect(raw).not.toContain('#token=');
        // The launcher survived the skipped auto-open.
        expect(launcher.child.exitCode).toBe(null);
      } finally {
        await launcher.stop();
      }
    },
    180_000,
  );

  it(
    '--no-browser: no auto-open, the token banner once, the API alive',
    async () => {
      const port = await freePort();
      const launcher = await bootLauncher(['--api-only', '--port', String(port), '--no-browser']);
      try {
        expect(await waitForHealth(port)).toBe(200);
        const raw = launcher.raw();
        expect(raw).not.toContain('Opening the app');
        expect(raw).not.toContain('Browser did not open');
        const tokens = [...raw.matchAll(/^\[Auth\] token: (\S+)$/gm)].map((m) => m[1]);
        expect(tokens).toHaveLength(1);
        expect(raw.split(tokens[0]).length - 1).toBe(1);
        expect(raw).not.toContain('#token=');
        expect(launcher.child.exitCode).toBe(null);
      } finally {
        await launcher.stop();
      }
    },
    180_000,
  );
});