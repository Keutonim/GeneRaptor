/**
 * Vitest global setup: provision a fresh SQLite test database.
 *
 * - Creates a per-run temp dir with generaptor-test.db.
 * - Runs `prisma db push --skip-generate` against it (first run creates the DB).
 * - Exports DATABASE_URL via process.env so every test fork inherits it
 *   (vitest config deliberately does NOT set DATABASE_URL in `test.env` —
 *   config env would override this value).
 */
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = joinPath(__dirname, '..');

let tmpDir;

/** Block the thread for `ms` (no dependency needed). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'generaptor-test-'));
  const dbUrl = `file:${tmpDir.split('\\').join('/')}/generaptor-test.db`;
  process.env.DATABASE_URL = dbUrl;

  const result = spawnSync(
    process.execPath,
    [joinPath(ROOT, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `prisma db push failed for the test database:\n${result.stdout}\n${result.stderr}`
    );
  }
}

/**
 * FIX-10: remove the per-run temp dir without failing the whole run.
 *
 * On Windows a file that was just written can still be locked (antivirus
 * scanner, another process). `rmSync` then fails with EPERM/EBUSY. The test
 * run itself is fine — only the teardown output is noisy — so the removal is
 * retried and, as a last resort, the directory is moved aside into the OS
 * temp dir (named, so the OS cleans it up later). Every OTHER error is
 * rethrown: a broken teardown must not be silently swallowed.
 *
 * The filesystem calls are injectable so the EPERM/EBUSY path is testable on
 * every platform.
 *
 * @param {string} dir
 * @param {{ rm?: Function, rename?: Function, tmp?: Function }} [deps]
 * @returns {{ removed: boolean, orphan: string|null }}
 */
export function removeTestTempDir(dir, { rm = rmSync, rename = renameSync, tmp = tmpdir } = {}) {
  if (!dir) return { removed: false, orphan: null };

  try {
    // maxRetries/retryDelay: Node retries EBUSY/EPERM/ENOTEMPTY with a
    // linear backoff — the usual "file just written" race on Windows.
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { removed: true, orphan: null };
  } catch (err) {
    const code = err?.code;
    if (code !== 'EPERM' && code !== 'EBUSY') throw err;

    // Fallback: move the dir aside — the OS removes it later on. The rename
    // can hit the very same lock, so it is retried a few times.
    const orphan = join(tmp(), `generaptor-test-orphan-${process.pid}-${Date.now()}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rename(dir, orphan);
        return { removed: false, orphan };
      } catch (renameErr) {
        const renameCode = renameErr?.code;
        if (renameCode !== 'EPERM' && renameCode !== 'EBUSY') throw renameErr;
        if (attempt < 2) sleepSync(100);
      }
    }
    // The dir stays inside the OS temp dir and is cleaned up by the OS —
    // do not fail the run over it.
    return { removed: false, orphan: null };
  }
}

export function teardown() {
  if (!tmpDir) return;
  const { removed, orphan } = removeTestTempDir(tmpDir);
  if (!removed) {
    console.warn(
      `[test-setup] Temp dir could not be removed${
        orphan ? ` — moved aside to ${orphan}` : ' — left in the OS temp dir'
      }; the OS will clean it up.`
    );
  }
}
