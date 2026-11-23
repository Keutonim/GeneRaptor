#!/usr/bin/env node
/**
 * db:studio — open Prisma Studio against the app's own SQLite database.
 *
 * The raw `prisma studio` script was broken for the current architecture:
 * the schema declares `url = env("DATABASE_URL")` and the app resolves its
 * SQLite file from --data-dir / GENERAPTOR_DATA_DIR at boot, so the variable
 * is usually unset when a developer runs the script ("Environment variable
 * not found: DATABASE_URL").
 *
 * This wrapper resolves the data dir exactly like start.mjs does
 * (server/lib/data-dir.mjs), exports the derived URL, bootstraps the schema
 * when the file is missing, and only then starts the Studio.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir, resolveDatabaseUrl, DATABASE_FILE_NAME } from '../server/lib/data-dir.mjs';
import { ensureDatabaseSchema } from '../server/lib/db-bootstrap.mjs';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const dataDir = resolveDataDir();
const env = { ...process.env };
if (!env.DATABASE_URL) {
  env.DATABASE_URL = resolveDatabaseUrl(dataDir);
}

const bootstrap = ensureDatabaseSchema({
  dbFile: join(dataDir, DATABASE_FILE_NAME),
  root: ROOT,
  env,
  logger: console,
});
if (bootstrap.bootstrapped && bootstrap.status !== 0) {
  console.error(bootstrap.stderr || 'prisma db push failed');
  process.exit(bootstrap.status ?? 1);
}

let prismaCli;
try {
  prismaCli = require.resolve('prisma/build/index.js');
} catch {
  console.error('The Prisma CLI is not installed — run `npm install` first.');
  process.exit(1);
}

console.log(`[generaptor] Prisma Studio → ${env.DATABASE_URL}`);
const result = spawnSync(process.execPath, [prismaCli, 'studio'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
process.exit(result.status ?? 0);
