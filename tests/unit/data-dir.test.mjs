/**
 * Unit tests for GeneRaptor data-dir resolution.
 *
 * Contract (M1):
 *   resolveDataDir() precedence:
 *     1. --data-dir <path> CLI flag (argv)
 *     2. GENERAPTOR_DATA_DIR env var
 *     3. default ~/.generaptor
 *   - returns an ABSOLUTE path
 *   - creates the directory (recursive) if missing
 *   - resolveDatabaseUrl() returns `file:`-scheme Prisma SQLite URL
 *     pointing at <dataDir>/generaptor.db with forward slashes (Windows-safe)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import os from 'os';

import {
  resolveDataDir,
  resolveDatabaseUrl,
  resolveDevUiOrigin,
  DEFAULT_DATA_DIR_NAME,
} from '../../server/lib/data-dir.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'generaptor-datadir-'));
}

describe('resolveDataDir', () => {
  const dirsToClean = [];
  afterEach(() => {
    for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('prefers --data-dir flag over env and default', () => {
    const root = tmpRoot();
    dirsToClean.push(root);
    const flagDir = join(root, 'from-flag');
    const dir = resolveDataDir({
      argv: ['node', 'start.mjs', '--data-dir', flagDir],
      env: { GENERAPTOR_DATA_DIR: join(root, 'from-env') },
      home: root,
    });
    expect(dir).toBe(resolve(flagDir));
    expect(existsSync(dir)).toBe(true);
  });

  it('uses GENERAPTOR_DATA_DIR env when no flag given', () => {
    const root = tmpRoot();
    dirsToClean.push(root);
    const envDir = join(root, 'from-env');
    const dir = resolveDataDir({ argv: ['node', 'start.mjs'], env: { GENERAPTOR_DATA_DIR: envDir }, home: root });
    expect(dir).toBe(resolve(envDir));
    expect(existsSync(dir)).toBe(true);
  });

  it('falls back to <home>/.generaptor by default', () => {
    const root = tmpRoot();
    dirsToClean.push(root);
    const dir = resolveDataDir({ argv: ['node', 'start.mjs'], env: {}, home: root });
    expect(dir).toBe(join(root, DEFAULT_DATA_DIR_NAME));
    expect(existsSync(dir)).toBe(true);
  });

  it('supports --data-dir=path form', () => {
    const root = tmpRoot();
    dirsToClean.push(root);
    const flagDir = join(root, 'eq-form');
    const dir = resolveDataDir({
      argv: ['node', 'start.mjs', `--data-dir=${flagDir}`],
      env: {},
      home: root,
    });
    expect(dir).toBe(resolve(flagDir));
  });

  it('expands ~ prefix to home directory', () => {
    const root = tmpRoot();
    dirsToClean.push(root);
    const dir = resolveDataDir({
      argv: ['node', 'start.mjs', '--data-dir', '~/generaptor-test-expand'],
      env: {},
      home: root,
    });
    expect(dir).toBe(join(root, 'generaptor-test-expand'));
  });
});

describe('resolveDatabaseUrl', () => {
  it('returns a file: URL for generaptor.db under the data dir', () => {
    const url = resolveDatabaseUrl('/some/dir');
    expect(url).toBe('file:/some/dir/generaptor.db');
  });

  // Windows-only behavior: resolveDatabaseUrl normalizes path.sep, which is
  // '\' ONLY on win32. On POSIX the product uses posix paths and legitimately
  // leaves backslashes alone — asserting the Windows shape there is wrong.
  it.skipIf(process.platform !== 'win32')('normalizes Windows backslashes to forward slashes', () => {
    const url = resolveDatabaseUrl('C:\\Users\\test\\generaptor');
    expect(url).toBe('file:C:/Users/test/generaptor/generaptor.db');
  });
});

/**
 * S5 T1 (round 2) — the server side of the launcher marker.
 *
 * The marker arrives as an argv FLAG, parsed here next to --data-dir. There is
 * no env variable for it: nothing can be inherited from the operator's
 * environment, and NODE_ENV takes no part. The VALUE is still untrusted at
 * this point — request-origin.mjs → devUiOrigins accepts it fail-closed.
 */
describe('resolveDevUiOrigin — argv extraction of the launcher marker', () => {
  it('reads the spaced form', () => {
    expect(
      resolveDevUiOrigin({ argv: ['node', 'server/index.mjs', '--dev-ui-origin', 'http://127.0.0.1:5173'] }),
    ).toBe('http://127.0.0.1:5173');
  });

  it('reads the --dev-ui-origin=<value> form', () => {
    expect(
      resolveDevUiOrigin({ argv: ['node', 'server/index.mjs', '--dev-ui-origin=http://localhost:5173'] }),
    ).toBe('http://localhost:5173');
  });

  it('returns null when the flag is absent (packaged / --api-only / direct start)', () => {
    expect(resolveDevUiOrigin({ argv: ['node', 'server/index.mjs'] })).toBeNull();
    expect(resolveDevUiOrigin({ argv: [] })).toBeNull();
    expect(resolveDevUiOrigin({ argv: null })).toBeNull();
  });

  it('returns null for a value-less flag instead of swallowing the next flag', () => {
    expect(
      resolveDevUiOrigin({ argv: ['node', 'server/index.mjs', '--dev-ui-origin', '--data-dir', '/tmp/x'] }),
    ).toBeNull();
    expect(resolveDevUiOrigin({ argv: ['node', 'server/index.mjs', '--dev-ui-origin'] })).toBeNull();
    expect(resolveDevUiOrigin({ argv: ['node', 'server/index.mjs', '--dev-ui-origin='] })).toBeNull();
  });

  it('coexists with --data-dir in the same argv (the launcher child carries both)', () => {
    const argv = [
      'node',
      'server/index.mjs',
      '--data-dir',
      '/tmp/instance',
      '--dev-ui-origin',
      'http://127.0.0.1:5199',
    ];
    expect(resolveDevUiOrigin({ argv })).toBe('http://127.0.0.1:5199');
    expect(resolveDataDir({ argv, env: {}, home: '/home/test' })).toBe('/tmp/instance');
  });

  it('never reads an environment variable or NODE_ENV', () => {
    const argv = ['node', 'server/index.mjs'];
    const env = {
      NODE_ENV: 'development',
      GENERAPTOR_DEV_UI_ORIGIN: 'http://127.0.0.1:5173',
      DEV_UI_ORIGIN: 'http://127.0.0.1:5173',
      CORS_ORIGIN: 'http://127.0.0.1:5173',
    };
    expect(resolveDevUiOrigin({ argv, env })).toBeNull();
    expect(
      resolveDevUiOrigin({ argv: [...argv, '--dev-ui-origin', 'http://localhost:5199'], env }),
    ).toBe('http://localhost:5199');
  });

  it('hands the raw value over unchanged — acceptance belongs to devUiOrigins', () => {
    // Extraction does not validate: a non-loopback value is still extracted,
    // and the guard ignores it later (fail-closed in ONE place).
    expect(
      resolveDevUiOrigin({ argv: ['node', 'x', '--dev-ui-origin', 'http://evil.example'] }),
    ).toBe('http://evil.example');
  });
});

/**
 * S5 T3 — D1 mechanism: the launcher exports an ABSOLUTE dir, so a relative
 * --data-dir cannot diverge between the launcher (cwd = ROOT) and the child.
 * The end-to-end proof is tests/integration/launcher-data-dir.test.mjs (D6).
 */
describe('resolveDataDir — always absolute (D1)', () => {
  const dirsToClean = [];
  afterEach(() => {
    for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('resolves a relative flag value to an absolute path', () => {
    const root = tmpRoot();
    dirsToClean.push(root);
    const expected = resolve('./relative-instance');
    dirsToClean.push(expected); // created by resolveDataDir — clean even on failure
    const dir = resolveDataDir({
      argv: ['node', 'start.mjs', '--data-dir', './relative-instance'],
      env: {},
      home: root,
    });
    expect(dir).toBe(expected);
    expect(dir.startsWith(root)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('resolves a relative env value to an absolute path too', () => {
    const expected = resolve('./relative-env-instance');
    dirsToClean.push(expected);
    const dir = resolveDataDir({
      argv: ['node', 'start.mjs'],
      env: { GENERAPTOR_DATA_DIR: './relative-env-instance' },
    });
    expect(dir).toBe(expected);
    expect(existsSync(dir)).toBe(true);
  });
});
