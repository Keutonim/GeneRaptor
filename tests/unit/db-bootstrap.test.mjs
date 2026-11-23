/**
 * M5 — zero-length database file is NOT a database (base defect).
 *
 * `prisma db push` skips when the SQLite file already exists, so a leftover
 * 0-byte generaptor.db survived the bootstrap and the app died at boot with
 * P2021 («table does not exist»). The bootstrap must treat a zero-length file
 * as a missing database: remove it and let `prisma db push` recreate it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inspectDatabaseFile,
  needsDatabaseBootstrap,
  prepareDatabaseFile,
} from '../../server/lib/db-bootstrap.mjs';

let dataDir;
let dbFile;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gr-db-bootstrap-'));
  dbFile = join(dataDir, 'generaptor.db');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('db bootstrap: inspection', () => {
  it('reports a missing file as "needs bootstrap"', () => {
    const info = inspectDatabaseFile(dbFile);
    expect(info.exists).toBe(false);
    expect(info.empty).toBe(true);
    expect(info.healthy).toBe(false);
    expect(needsDatabaseBootstrap(dbFile)).toBe(true);
  });

  it('treats a ZERO-LENGTH file as "not a database" (base defect)', () => {
    writeFileSync(dbFile, '');
    const info = inspectDatabaseFile(dbFile);
    expect(info.exists).toBe(true);
    expect(info.size).toBe(0);
    expect(info.empty).toBe(true);
    expect(info.healthy).toBe(false);
    expect(needsDatabaseBootstrap(dbFile)).toBe(true);
  });

  it('leaves a real database alone', () => {
    writeFileSync(dbFile, 'SQLite format 3\u0000-not really-');
    const info = inspectDatabaseFile(dbFile);
    expect(info.empty).toBe(false);
    expect(info.healthy).toBe(true);
    expect(needsDatabaseBootstrap(dbFile)).toBe(false);
  });
});

describe('db bootstrap: preparation', () => {
  it('removes a zero-length leftover so prisma can recreate the file', () => {
    writeFileSync(dbFile, '');

    const result = prepareDatabaseFile(dbFile);

    expect(result.removed).toBe(true);
    expect(result.reason).toBe('empty');
    expect(existsSync(dbFile)).toBe(false);
  });

  it('never removes a healthy database', () => {
    writeFileSync(dbFile, 'SQLite format 3\u0000-not really-');

    const result = prepareDatabaseFile(dbFile);

    expect(result.removed).toBe(false);
    expect(result.reason).toBe('healthy');
    expect(existsSync(dbFile)).toBe(true);
    expect(statSync(dbFile).size).toBeGreaterThan(0);
  });

  it('is a no-op for a missing file', () => {
    const result = prepareDatabaseFile(dbFile);
    expect(result.removed).toBe(false);
    expect(result.reason).toBe('missing');
    expect(existsSync(dbFile)).toBe(false);
  });
});
