/**
 * FIX-10: the vitest global teardown must not blow up on Windows.
 *
 * Root cause: `rmSync(tmpDir, { recursive: true, force: true })` fails with
 * EPERM when Windows still holds a transient lock on a file that was just
 * written (parallel runs, antivirus, Prisma's own file handles). The run
 * itself is fine — the exit code is 0 — but the teardown prints a scary
 * stack trace, which is noise in CI.
 *
 * The removal must therefore:
 *   1. retry with a small pause (rmSync maxRetries/retryDelay);
 *   2. fall back to moving the directory aside into the OS temp dir (named,
 *      so the OS cleans it) instead of failing the run;
 *   3. never swallow an error other than EPERM/EBUSY.
 *
 * The filesystem calls are injectable so the EPERM/EBUSY path is testable on
 * every platform (Windows cannot be made to fail on demand).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTestTempDir } from '../global-setup.mjs';

/** A filesystem error with a given code (Node-style). */
function fsError(code) {
  const err = new Error(`mock fs error: ${code}`);
  err.code = code;
  return err;
}

describe('removeTestTempDir', () => {
  it('removes the temp dir and its content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-teardown-test-'));
    writeFileSync(join(dir, 'generaptor-test.db'), 'x');

    const result = removeTestTempDir(dir);

    expect(result.removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('moves the dir aside when the removal hits EPERM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-teardown-test-'));
    writeFileSync(join(dir, 'generaptor-test.db'), 'x');

    const result = removeTestTempDir(dir, {
      rm: () => {
        throw fsError('EPERM');
      },
    });

    expect(result.removed).toBe(false);
    expect(result.orphan).toBeTruthy();
    expect(result.orphan.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(result.orphan)).toBe(true);

    rmSync(result.orphan, { recursive: true, force: true });
  });

  it('moves the dir aside when the removal hits EBUSY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-teardown-test-'));

    const result = removeTestTempDir(dir, {
      rm: () => {
        throw fsError('EBUSY');
      },
    });

    expect(result.removed).toBe(false);
    expect(result.orphan).toBeTruthy();
    expect(existsSync(dir)).toBe(false);

    rmSync(result.orphan, { recursive: true, force: true });
  });

  it('does not swallow errors other than EPERM/EBUSY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-teardown-test-'));

    expect(() =>
      removeTestTempDir(dir, {
        rm: () => {
          throw fsError('EACCES');
        },
      })
    ).toThrow(/EACCES/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op for a missing dir', () => {
    const dir = join(tmpdir(), `generaptor-teardown-missing-${process.pid}`);
    const result = removeTestTempDir(dir);
    expect(result.removed).toBe(true);
  });

  it('keeps working when the fallback rename also hits EPERM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-teardown-test-'));

    const result = removeTestTempDir(dir, {
      rm: () => {
        throw fsError('EPERM');
      },
      rename: () => {
        throw fsError('EPERM');
      },
    });

    // The dir stays where it is (inside the OS temp dir) -> the OS cleans it.
    expect(result.removed).toBe(false);
    expect(result.orphan).toBeNull();
    expect(existsSync(dir)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
