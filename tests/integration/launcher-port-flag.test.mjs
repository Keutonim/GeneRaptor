/**
 * O-1: the launcher's `--port` flag must be honored in BOTH modes.
 *
 * Root cause (fixed in start.mjs): a source checkout has `dist/` AND `vite`,
 * so the launcher takes the DEVELOPMENT branch, where `--port` was assigned
 * to the Vite UI port only. With `--api-only` no Vite server is started — so
 * the requested port was silently dropped and the API kept the default 8787.
 * The operator asked for a port and got a different one.
 *
 * The invariant this suite protects (real processes, no mocks):
 *
 *   - `--api-only --port N` -> the API REALLY listens on N (verified by an
 *     HTTP request to N), and the banner reports N;
 *   - the ordinary mode keeps its documented semantics: `--port N` is the
 *     dev UI port (the Vite server REALLY listens on N);
 *   - the one-time token is printed EXACTLY once, its value is never logged
 *     a second time, and a LAN interface cannot reach the port.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/** The API port the launcher falls back to when `--port` is absent. */
const DEFAULT_API_PORT = 8787;

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

/** Poll until something listens on `port` (or the deadline passes). */
async function waitForListener(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect('127.0.0.1', port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
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
 * Boot the REAL launcher and wait until it reports readiness.
 *
 * The environment is deliberately explicit: no GENERAPTOR_API_PORT, no PORT,
 * the access gate ON — so the port the API ends up on is decided by the
 * launcher's own logic and nothing else.
 */
async function bootLauncher(args) {
  const dataDir = mkdtempSync(join(tmpdir(), 'generaptor-port-'));
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['start.mjs', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GENERAPTOR_DATA_DIR: dataDir,
      GENERAPTOR_API_PORT: '',
      PORT: '',
      ACCESS_GATE_DISABLED: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
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

/** GET /api/health; never throws — a refused connection is `status: null`. */
async function healthStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Wait until the API answers on `port`.
 *
 * The launcher prints "[3/3] Ready." right after it SPAWNS the API child —
 * the child still needs a moment to bind the port. So the port has to be
 * polled, not sampled once.
 */
async function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = await healthStatus(port);
    if (status !== null) return status;
    await new Promise((r) => setTimeout(r, 250));
  }
  return status;
}

describe('O-1: --port is honored by the launcher', () => {
  it(
    'starts the API on the requested port in --api-only mode',
    async () => {
      const port = await freePort();
      // Is the default port busy before we start? If some other process holds
      // it, our launcher cannot be blamed for it.
      const defaultBusyBefore = await canConnect('127.0.0.1', DEFAULT_API_PORT);
      const launcher = await bootLauncher(['--api-only', '--port', String(port)]);
      try {
        // The API REALLY listens on the requested port.
        expect(await waitForHealth(port)).toBe(200);

        // The banner reports the port the app really uses.
        expect(launcher.output()).toMatch(new RegExp(`Bind:\\s+127\\.0\\.0\\.1:${port}\\b`));
        expect(launcher.output()).toContain(`http://127.0.0.1:${port}/api/health`);

        // The default port is NOT used by this launcher any more.
        expect(await canConnect('127.0.0.1', DEFAULT_API_PORT)).toBe(defaultBusyBefore);

        // The operator is warned that the Vite dev server (started by hand)
        // proxies /api to the fixed port from vite.config.ts, so the UI would
        // not reach the API on the custom port.
        expect(launcher.output()).toContain(
          `the Vite dev server proxies /api to 127.0.0.1:${DEFAULT_API_PORT} — the UI will not reach the API on ${port}`
        );
      } finally {
        await launcher.stop();
      }
    },
    180_000
  );

  it(
    'keeps --port as the dev UI port in the ordinary mode',
    async () => {
      const port = await freePort();
      const launcher = await bootLauncher(['--port', String(port)]);
      try {
        // The Vite dev server REALLY listens on the requested port.
        expect(await waitForListener(port)).toBe(true);
      } finally {
        await launcher.stop();
      }
    },
    180_000
  );

  it(
    'prints the one-time token once and refuses LAN access',
    async () => {
      const port = await freePort();
      const launcher = await bootLauncher(['--api-only', '--port', String(port)]);
      try {
        const raw = launcher.raw();
        const tokens = [...raw.matchAll(/^\[Auth\] token: (\S+)$/gm)].map((m) => m[1]);
        // The banner is printed exactly once...
        expect(tokens).toHaveLength(1);
        // ...and the token value is never logged a second time.
        expect(raw.split(tokens[0]).length - 1).toBe(1);

        // Loopback-only bind: a LAN interface cannot reach the port.
        const lan = lanAddress();
        if (lan && lan !== '127.0.0.1') {
          // The API is really up (loopback) ...
          expect(await waitForHealth(port)).toBe(200);
          // ... and not reachable from the LAN interface.
          expect(await canConnect(lan, port)).toBe(false);
        }
      } finally {
        await launcher.stop();
      }
    },
    180_000
  );
});
