#!/usr/bin/env node
/**
 * ensure-prisma-client — make sure the generated Prisma client exists.
 *
 * Why this exists (M9): the published package ships `prisma/schema.prisma` but
 * NOT `node_modules/`. Without a generated client the consumer gets a stale
 * client (or none at all), `tsc`/the runtime blow up with ~40 type errors and
 * the app never starts.
 *
 * It runs from two places:
 *   - `postinstall` — right after `npm install` put the dependencies on disk;
 *   - `pretest`     — because npm >= 12 re-links/prunes `node_modules` AFTER
 *                     the root lifecycle scripts, so the client generated
 *                     during the install can be gone again before the tests.
 *
 * The script is idempotent: if the client is already generated it does
 * nothing. `prisma generate` never touches the database, but the schema
 * declares `url = env("DATABASE_URL")`, so the fallback below keeps the CLI
 * happy when no database is configured yet (the real URL is resolved at boot
 * by start.mjs from --data-dir / GENERAPTOR_DATA_DIR).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Is the generated Prisma client usable?
 *
 * In a checkout the client lives in `<root>/node_modules/.prisma/client`; in
 * an installed package Prisma writes it into the hoisted `@prisma/client` of
 * the consumer's node_modules — the probe covers both layouts and also
 * rejects the "client was not generated yet" stub.
 *
 * The probe uses CJS `require` on purpose: ESM caches module-evaluation
 * failures, so a dynamic `import()` that ran before `prisma generate` would
 * keep failing afterwards.
 *
 * @returns {Promise<boolean>}
 */
async function clientGenerated() {
  if (existsSync(join(ROOT, 'node_modules', '.prisma', 'client', 'default.js'))) {
    return true;
  }
  try {
    const mod = require('@prisma/client');
    return typeof mod.PrismaClient === 'function';
  } catch {
    return false;
  }
}

async function main() {
  const schema = join(ROOT, 'prisma', 'schema.prisma');
  if (!existsSync(schema)) {
    console.log('[generaptor] prisma/schema.prisma is missing — skipping prisma generate.');
    return 0;
  }

  if (await clientGenerated()) {
    console.log('[generaptor] Prisma client is already generated.');
    return 0;
  }

  let prismaCli;
  try {
    prismaCli = require.resolve('prisma/build/index.js');
  } catch {
    console.error('[generaptor] The Prisma CLI is not installed — cannot generate the client.');
    return 1;
  }

  const env = { ...process.env };
  if (!env.DATABASE_URL) {
    // Placeholder only: `generate` never opens the database.
    env.DATABASE_URL = 'file:./.prisma-placeholder.db';
  }

  console.log('[generaptor] Generating the Prisma client...');
  const result = spawnSync(process.execPath, [prismaCli, 'generate'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error('[generaptor] prisma generate failed — the app will not start until it succeeds.');
    return result.status ?? 1;
  }

  if (!(await clientGenerated())) {
    console.error('[generaptor] prisma generate finished but the client is still missing.');
    return 1;
  }
  return 0;
}

process.exit(await main());
