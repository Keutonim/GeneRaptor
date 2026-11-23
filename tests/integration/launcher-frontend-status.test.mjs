/**
 * FIX-08: the launcher's `--api-only` frontend line must be truthful.
 *
 * Root cause: start.mjs printed "Frontend: disabled (--api-only)" in EVERY
 * mode. But the API server mounts the built SPA from dist/
 * (server/express-app.mjs) — so in a packaged build the UI IS served at the
 * very same API root and `--api-only` only skips the Vite dev server.
 *
 * The invariant:
 *
 *   - with a build   -> the launcher must NOT claim that the UI is disabled;
 *                       it must say that the API server serves dist/;
 *   - without a build -> the launcher must say that the API root serves no
 *                       UI, name the Vite dev server (and how to start it),
 *                       and must NOT send the operator to the API root,
 *                       where `GET /` answers 404.
 *
 * The expectations follow the state of the checkout (a source checkout has no
 * dist/); the built state is covered by the live launcher runs.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
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
 * Boot the REAL launcher in --api-only mode and report its output.
 */
async function bootLauncher() {
  const port = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['start.mjs', '--api-only'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GENERAPTOR_API_PORT: String(port),
      PORT: '5173',
      ACCESS_GATE_DISABLED: '',
      GENERAPTOR_STARTUP_TOKEN: '',
      GENERAPTOR_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (stdout.includes('[Auth] ---')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { output: maskToken(stdout + stderr), port };
  } finally {
    killTree(child);
  }
}

describe('FIX-08: the launcher --api-only banner matches what is really served', () => {
  it('never claims the frontend is disabled while the API server serves the build', async () => {
    const { output, port } = await bootLauncher();
    const hasBuild = existsSync(join(ROOT, 'dist'));

    if (hasBuild) {
      // The API server mounts dist/ -> the UI is served at the API root.
      expect(output).not.toMatch(/Frontend: disabled \(--api-only\)/);
      expect(output).toMatch(/Frontend: served from dist\/ by the API server/);
      expect(output).toMatch(/UI:\s+http:\/\/127\.0\.0\.1:\d+/);
      // The token must be pasted where the UI really is: the API root.
      expect(output).toMatch(
        new RegExp(`\\[Auth\\] Paste this token at http://127\\.0\\.0\\.1:${port} to unlock`)
      );
    } else {
      // No build -> the API root serves no UI; the banner must say so and
      // name the dev server instead of advertising a 404 address.
      expect(output).toMatch(/Frontend: disabled \(--api-only\)/);
      expect(output).toMatch(/no dist\//i);
      expect(output).toMatch(/npm run dev/);
      expect(output).not.toMatch(
        new RegExp(`\\[Auth\\] Paste this token at http://127\\.0\\.0\\.1:${port} to unlock`)
      );
    }
  }, 120_000);
});
