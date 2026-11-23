/**
 * M5 — boot regression: a zero-length database file must not survive the
 * bootstrap (base defect).
 *
 * Before the fix: `prisma db push` was skipped whenever the SQLite file
 * existed, so a 0-byte ~/.generaptor/generaptor.db left the schema missing
 * and the app died at boot with P2021 («table does not exist»).
 *
 * After the fix: the launcher removes a zero-length file and lets
 * `prisma db push` recreate the schema — the app boots against a real
 * database. This test proves it end to end: real `prisma db push`, then a
 * real query against the recreated file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

import { ensureDatabaseSchema } from '../../server/lib/db-bootstrap.mjs';
import { resolveDatabaseUrl } from '../../server/lib/data-dir.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

let dataDir;
let dbFile;
let databaseUrl;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gr-db-boot-'));
  dbFile = join(dataDir, 'generaptor.db');
  databaseUrl = resolveDatabaseUrl(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('boot with a zero-length database file', () => {
  it(
    'recreates the schema so the app does not die with P2021',
    { timeout: 180_000 },
    async () => {
      // The defect: a leftover EMPTY file where the database should be.
      writeFileSync(dbFile, '');
      expect(statSync(dbFile).size).toBe(0);

      const result = ensureDatabaseSchema({
        dbFile,
        root: ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        logger: { log: () => {}, error: () => {} },
      });

      expect(result.bootstrapped).toBe(true);
      expect(result.status).toBe(0);
      expect(existsSync(dbFile)).toBe(true);
      expect(statSync(dbFile).size).toBeGreaterThan(0);

      // The real proof: the schema is usable (P2021 «table does not exist»
      // would be thrown here before the fix).
      const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        const count = await client.article.count();
        expect(typeof count).toBe('number');
      } finally {
        await client.$disconnect();
      }
    },
  );

  it(
    'skips the bootstrap when the database is already healthy',
    { timeout: 180_000 },
    async () => {
      const first = ensureDatabaseSchema({
        dbFile,
        root: ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        logger: { log: () => {}, error: () => {} },
      });
      expect(first.bootstrapped).toBe(true);
      const sizeAfter = statSync(dbFile).size;

      const second = ensureDatabaseSchema({
        dbFile,
        root: ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        logger: { log: () => {}, error: () => {} },
      });

      expect(second.bootstrapped).toBe(false);
      expect(statSync(dbFile).size).toBe(sizeAfter);
    },
  );
});
