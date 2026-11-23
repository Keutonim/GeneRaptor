/**
 * SEC-05 regression: the launcher must never widen the bind silently and the
 * boot banner must show the REALLY bound host.
 *
 * Root cause (AppSec SEC-05):
 *   - `parseAuthFlags` mapped a bare `--host` (no value) to '0.0.0.0', so a
 *     typo silently turned a loopback-only install into a network-wide one;
 *   - the boot banner hardcoded `http://127.0.0.1:<port>` although the server
 *     may be bound to 0.0.0.0 — the banner hid the real attack surface and
 *     never warned that the access token is the only protection left.
 *
 * This suite boots the REAL launcher (`node start.mjs`) and the REAL API
 * server (`node server/index.mjs`) — no mocked CLI, no in-process stub.
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
 * Run the launcher to completion (it must fail fast on a usage error).
 *
 * @param {string[]} args
 * @returns {Promise<{code: number|null, output: string, exited: boolean}>}
 */
function runLauncher(args, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['start.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));

    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: null, output, exited: false });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output, exited: true });
    });
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
 * Wait until the captured output satisfies `predicate`.
 *
 * The boot output of the server arrives in TWO waves: the socket is bound
 * first (`[Express] Server listening on …`, printed from the listen callback
 * in server/express-app.mjs) and only THEN does the process print the auth
 * banner (`[Auth] Paste this token at …`, printed by server/index.mjs after
 * createExpressApp() resolved). A wait that stops at the FIRST of those lines
 * is a race: the second line may still be in flight when the assertion runs.
 * QA-1 saw exactly that under load — "1 failed | 1999 passed (2000)".
 *
 * So every assertion waits for the line(s) it actually needs. The predicate
 * runs against the WHOLE accumulated output (a line may be split across
 * chunks) and the port is matched tolerantly (`:\d+`).
 *
 * @param {() => string} read
 * @param {(output: string) => boolean} predicate
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<string>} the captured output
 */
function waitForOutput(read, predicate, { timeoutMs = 30_000, label = 'expected output' } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const out = read();
      if (predicate(out)) {
        clearInterval(timer);
        resolve(out);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${label}. Captured output:\n${out}`,
          ),
        );
      }
    }, 25);

    // The output may already be there — do not wait for the first tick.
    const out = read();
    if (predicate(out)) {
      clearInterval(timer);
      resolve(out);
    }
  });
}

/** The auth banner for a wildcard bind (the port is dynamic). */
const AUTH_BANNER_WILDCARD = /\[Auth\] Paste this token at http:\/\/0\.0\.0\.0:\d+/;
/** The auth banner for the default loopback bind (the port is dynamic). */
const AUTH_BANNER_LOOPBACK = /\[Auth\] Paste this token at http:\/\/127\.0\.0\.1:\d+/;
/** The last line of a successful boot (server/index.mjs). */
const BOOT_FINISHED = /\[GeneRaptor\] Server started successfully/;

/**
 * Start the REAL API server and capture its boot output.
 *
 * The helper does NOT wait: the caller waits for the lines its assertions
 * need (see `waitFor`), because "the server is up" and "the banner is
 * printed" are two different moments.
 *
 * @param {Record<string,string>} extraEnv
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
      ACCESS_GATE_DISABLED: '',
      ACCESS_GATE_HMAC_KEY: '',
      JWT_SECRET: '',
      GENERAPTOR_TOKEN: 'fixed-dummy-token-not-a-secret',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  return {
    port,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    /**
     * Wait for a specific piece of the boot output.
     *
     * @param {(output: string) => boolean} predicate
     * @param {{ timeoutMs?: number, label?: string }} [options]
     */
    waitFor: (predicate, options) => waitForOutput(() => stdout, predicate, options),
    stop: () => killTree(child),
  };
}

afterAll(() => {
  /* nothing global to clean */
});

describe('SEC-05 launcher --host usage error', () => {
  it('exits non-zero with a clear message when --host has no value', async () => {
    const result = await runLauncher(['--host']);

    expect(result.exited).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/--host/);
  }, 40_000);

  it('exits non-zero when --host is given an empty value', async () => {
    const result = await runLauncher(['--host=']);

    expect(result.exited).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/--host/);
  }, 40_000);
});

describe('SEC-05 boot banner shows the really bound host', () => {
  it('prints the network-reachable host and a loud warning for a 0.0.0.0 bind', async () => {
    const server = await startServer({ GENERAPTOR_HOST: '0.0.0.0' });
    try {
      // Wait for the EXACT lines the assertions below need — the auth banner
      // and the network warning are printed after the socket is bound, so
      // stopping at "[Express] Server listening on" is a race (QA-1 flake).
      await server.waitFor(
        (out) => AUTH_BANNER_WILDCARD.test(out) && /NETWORK-REACHABLE/.test(out),
        { label: 'the [Auth] banner and the NETWORK-REACHABLE warning' },
      );
      // The banner must carry the REAL bound host, not a hardcoded 127.0.0.1.
      expect(server.stdout).toMatch(AUTH_BANNER_WILDCARD);
      // ... and the operator must be told that the token is the only shield.
      expect(server.stdout).toMatch(/NETWORK-REACHABLE/);
      expect(server.stdout).toMatch(/0\.0\.0\.0/);
    } finally {
      server.stop();
    }
  }, 40_000);

  it('prints the loopback host and no network warning for the default bind', async () => {
    const server = await startServer();
    try {
      // The negative assertion ("no network warning") is only meaningful once
      // the boot output is complete: the warning is printed AFTER the auth
      // banner, so waiting for the banner alone could pass on a half-read
      // stream. BOOT_FINISHED is the last line of a successful boot.
      await server.waitFor((out) => AUTH_BANNER_LOOPBACK.test(out) && BOOT_FINISHED.test(out), {
        label: 'the [Auth] banner and the end of the boot output',
      });
      expect(server.stdout).toMatch(AUTH_BANNER_LOOPBACK);
      expect(server.stdout).not.toMatch(/NETWORK-REACHABLE/);
    } finally {
      server.stop();
    }
  }, 40_000);
});
