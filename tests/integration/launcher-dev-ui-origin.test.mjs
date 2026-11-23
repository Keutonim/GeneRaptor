/**
 * S5 T1 (round 2) — L2: the marker REALLY reaches the API child.
 *
 * The launcher decides the topology (does it start Vite itself?) and hands the
 * dev UI origin to the API child as an argv flag. This suite boots the REAL
 * launcher (`node start.mjs`) and checks the consequence on the REAL server:
 *
 *   - dev topology (the launcher starts Vite): both loopback spellings of the
 *     UI origin pass the Origin guard, and the child prints the alias line;
 *   - `--api-only`: NO marker is emitted, so the other spelling is refused even
 *     though the operator's environment says NODE_ENV=development.
 *
 * Every port here is a free port chosen by the test — never 8787/5173, which
 * belong to another application on this machine. No paid provider call is made
 * (all key env vars are blanked, only /api/auth/exchange is probed).
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

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

/** Boot the REAL launcher with an explicit, key-free environment. */
async function bootLauncher(args, extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'generaptor-s5r2-marker-'));
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['start.mjs', '--no-browser', '--no-auth', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GENERAPTOR_DATA_DIR: dataDir,
      DATABASE_URL: '',
      PORT: '',
      ACCESS_GATE_DISABLED: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN: '',
      GENERAPTOR_TOKEN_TTL: '',
      GENERAPTOR_HOST: '',
      CORS_ORIGIN: '',
      ROUTERAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      OLLAMA_API_KEY: '',
      CUSTOM_API_KEY: '',
      GENERAPTOR_SERPER_API_KEY: '',
      TAVILY_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  async function stop() {
    killTree(child);
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  return { child, dataDir, output: () => stdout + stderr, stop };
}

/** Wait until the API answers /api/health on `port`. */
async function waitReady(port, launcher, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (launcher.child.exitCode !== null) {
      throw new Error(`launcher exited early\n${launcher.output()}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`API not ready on ${port}\n${launcher.output()}`);
}

/**
 * Wait for a substring in the launcher output. The API child inherits the
 * launcher's stdio, so its log lines arrive through a pipe — they can lag
 * behind the HTTP response that triggered them.
 */
async function waitForOutput(launcher, substring, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launcher.output().includes(substring)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** A state-changing POST with a freely chosen Origin. */
function postWithOrigin(port, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/exchange',
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: origin,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

describe('S5 T1 L2: the launcher marker reaches the server child', () => {
  it(
    'dev topology: the launcher starts Vite and BOTH spellings of the UI origin pass the guard',
    async () => {
      const uiPort = await freePort();
      const apiPort = await freePort();
      const launcher = await bootLauncher(
        ['--port', String(uiPort)],
        { GENERAPTOR_API_PORT: String(apiPort), NODE_ENV: 'development' },
      );
      try {
        await waitReady(apiPort, launcher);

        // The child really received the marker: it announces the alias.
        expect(
          await waitForOutput(
            launcher,
            `[Origin] dev UI origin: http://127.0.0.1:${uiPort} (loopback alias enabled: http://localhost:${uiPort})`,
          ),
        ).toBe(true);

        // The configured spelling and the synonym both pass (the owner's bug).
        expect(await postWithOrigin(apiPort, `http://127.0.0.1:${uiPort}`)).not.toBe(403);
        expect(await postWithOrigin(apiPort, `http://localhost:${uiPort}`)).not.toBe(403);
        // A foreign origin is still refused.
        expect(await postWithOrigin(apiPort, 'http://evil.example')).toBe(403);
      } finally {
        await launcher.stop();
      }
    },
    180_000,
  );

  it(
    '--api-only: NO marker is emitted, so the other spelling stays refused even with NODE_ENV=development',
    async () => {
      const apiPort = await freePort();
      const uiPort = await freePort();
      const launcher = await bootLauncher(
        ['--api-only', '--port', String(apiPort)],
        { NODE_ENV: 'development', CORS_ORIGIN: `http://localhost:${uiPort}` },
      );
      try {
        await waitReady(apiPort, launcher);

        // Wait for the child's boot log so the negative assertion is not a race.
        expect(await waitForOutput(launcher, '[Origin] allowed origins:')).toBe(true);
        expect(launcher.output()).not.toContain('loopback alias enabled');
        expect(await postWithOrigin(apiPort, `http://localhost:${uiPort}`)).not.toBe(403);
        expect(await postWithOrigin(apiPort, `http://127.0.0.1:${uiPort}`)).toBe(403);
        expect(await postWithOrigin(apiPort, 'http://evil.example')).toBe(403);
      } finally {
        await launcher.stop();
      }
    },
    180_000,
  );
});
