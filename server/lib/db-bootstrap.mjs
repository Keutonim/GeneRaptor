/**
 * Database bootstrap guard (M5).
 *
 * `prisma db push` skips when the SQLite file already exists. A leftover
 * ZERO-LENGTH ~/.generaptor/generaptor.db therefore survived the bootstrap,
 * the schema was never created, and the app died at boot with
 * P2021 («table does not exist»).
 *
 * Rule: a zero-length file is NOT a database. The bootstrap removes it and
 * lets `prisma db push` recreate the schema.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inspect a SQLite file on disk.
 * @param {string} dbFile
 * @returns {{ path: string, exists: boolean, size: number, empty: boolean, healthy: boolean }}
 */
export function inspectDatabaseFile(dbFile) {
  if (typeof dbFile !== 'string' || !dbFile || !existsSync(dbFile)) {
    return { path: dbFile ?? '', exists: false, size: 0, empty: true, healthy: false };
  }
  let size = 0;
  try {
    size = statSync(dbFile).size;
  } catch {
    size = 0;
  }
  return {
    path: dbFile,
    exists: true,
    size,
    empty: size === 0,
    healthy: size > 0,
  };
}

/**
 * Does the database file need the schema bootstrap?
 * A missing file and a zero-length file both answer YES.
 * @param {string} dbFile
 * @returns {boolean}
 */
export function needsDatabaseBootstrap(dbFile) {
  const info = inspectDatabaseFile(dbFile);
  return !info.exists || info.empty;
}

/**
 * Drop a broken (zero-length) database file so Prisma can recreate it.
 * A healthy database is never touched.
 * @param {string} dbFile
 * @returns {{ removed: boolean, reason: 'missing'|'empty'|'healthy' }}
 */
export function prepareDatabaseFile(dbFile) {
  const info = inspectDatabaseFile(dbFile);
  if (!info.exists) return { removed: false, reason: 'missing' };
  if (!info.empty) return { removed: false, reason: 'healthy' };
  try {
    rmSync(dbFile, { force: true });
  } catch {
    return { removed: false, reason: 'healthy' };
  }
  return { removed: true, reason: 'empty' };
}

/**
 * Make sure the SQLite database exists WITH a schema.
 *
 * @param {object} args
 * @param {string} args.dbFile - path to <data-dir>/generaptor.db
 * @param {string} args.root - project root (where prisma/schema.prisma lives)
 * @param {Record<string, string|undefined>} [args.env] - env for the spawn (default: process.env)
 * @param {{ log: Function, error: Function }} [args.logger] - log sink
 * @returns {{ bootstrapped: boolean, status: number, stdout: string, stderr: string }}
 */
export function ensureDatabaseSchema({ dbFile, root, env = process.env, logger = console } = {}) {
  if (!needsDatabaseBootstrap(dbFile)) {
    return { bootstrapped: false, status: 0, stdout: '', stderr: '' };
  }

  const prepared = prepareDatabaseFile(dbFile);
  if (prepared.removed) {
    logger.log?.(
      `   Empty database file found — removing it so the schema can be recreated (${dbFile}).`,
    );
  }
  logger.log?.(`   Creating the database schema at ${dbFile} (prisma db push)...`);

  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--skip-generate'],
    { cwd: root, env, encoding: 'utf8' },
  );

  return {
    bootstrapped: true,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
