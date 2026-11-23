import prismaClientPkg from '@prisma/client';
const { PrismaClient } = prismaClientPkg;

import { resolveDataDir, resolveDatabaseUrl, hardenDataPermissions, databaseFilePathFromUrl } from './lib/data-dir.mjs';
import { dirname } from 'path';

// M1: SQLite under the data dir. The launcher (start.mjs)
// normally sets DATABASE_URL explicitly; running `node server/index.mjs`
// without it falls back to <data-dir>/generaptor.db (default ~/.generaptor).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = resolveDatabaseUrl(resolveDataDir());
  console.log(`[DB] DATABASE_URL not set — using ${process.env.DATABASE_URL}`);
}

const globalForPrisma = globalThis;

export const prisma = globalForPrisma.__prisma ?? new PrismaClient({
  log:
    process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error', 'warn'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

/**
 * Connect to the database.
 * Safe to call multiple times; Prisma handles connection pooling internally.
 */
export async function connectDB() {
  try {
    await prisma.$connect();
    // SEC-04: the data dir (0700) and the SQLite file (0600) hold the
    // encrypted provider keys — tighten the modes on every connect.
    const dbFile = databaseFilePathFromUrl(process.env.DATABASE_URL);
    hardenDataPermissions({
      dataDir: dbFile ? dirname(dbFile) : undefined,
      databaseUrl: process.env.DATABASE_URL,
    });
    // Defence in depth: freed pages must not keep the old (plaintext) bytes
    // of a migrated row around.
    await prisma.$queryRawUnsafe('PRAGMA secure_delete = ON').catch(() => {});
    console.log('[DB] Connected to SQLite');
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    throw err;
  }
}

/**
 * Gracefully disconnect from the database.
 * Call this during shutdown (SIGTERM / SIGINT).
 */
export async function disconnectDB() {
  try {
    await prisma.$disconnect();
    console.log('[DB] Disconnected from SQLite');
  } catch (err) {
    console.error('[DB] Disconnect error:', err.message);
    throw err;
  }
}
