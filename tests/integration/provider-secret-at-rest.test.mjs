/**
 * SEC-04 — provider key material at rest (AES-256-GCM) + data-dir file modes.
 *
 * Contract under test:
 *   - a stored provider key is NEVER written to the SQLite file as plaintext;
 *   - the public (API) shape still masks the key (D10);
 *   - a pre-existing PLAINTEXT row is migrated to ciphertext on read and the
 *     migration is idempotent;
 *   - the environment-key path is unchanged (env key wins, nothing written);
 *   - the per-install key file lives next to the DB, 0600 on POSIX;
 *   - the data dir is 0700 and the DB file 0600 on POSIX.
 *
 * The tests read the RAW SQLite bytes — that is the only honest way to prove
 * "the key is not on disk in the clear".
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';

const prisma = new PrismaClient({ log: ['error'] });

const providers = await import('../../server/lib/providers.mjs');

const ENV_KEYS = [
  'ROUTERAI_API_KEY',
  'ROUTERAI_ENDPOINT',
  'OPENROUTER_API_KEY',
  'OLLAMA_API_KEY',
  'CUSTOM_API_KEY',
];

const isPosix = process.platform !== 'win32';

function databaseFilePath() {
  const url = String(process.env.DATABASE_URL || '');
  if (!url.startsWith('file:')) return null;
  const raw = url.slice('file:'.length).split('?')[0];
  return raw.split('/').join(sep);
}

function rawDatabaseBytes() {
  const file = databaseFilePath();
  if (!file || !existsSync(file)) return Buffer.alloc(0);
  return readFileSync(file);
}

/** The SQLite write-ahead log may still hold the old page images. */
function rawWalBytes() {
  const file = databaseFilePath();
  if (!file) return Buffer.alloc(0);
  const wal = `${file}-wal`;
  if (!existsSync(wal)) return Buffer.alloc(0);
  return readFileSync(wal);
}

function leaksPlaintext(secret) {
  const needle = Buffer.from(secret, 'utf8');
  return rawDatabaseBytes().includes(needle) || rawWalBytes().includes(needle);
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    if (process.env[key] === undefined) process.env[key] = '';
  }
  await prisma.providerConfig.deleteMany();
});

afterEach(async () => {
  await prisma.providerConfig.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  const { prisma: sharedPrisma } = await import('../../server/db.mjs');
  await sharedPrisma.$disconnect();
});

describe('SEC-04 — stored provider keys are encrypted at rest', () => {
  it('never writes the key to the SQLite file as plaintext', async () => {
    const secret = 'sk-plaintext-must-not-hit-disk';

    const saved = await providers.saveProviderConfig('custom', {
      baseUrl: 'https://example.com/v1',
      apiKey: secret,
    });

    // The public shape stays masked (D10).
    expect(saved.keyConfigured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(secret);

    const row = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    expect(row.apiKey).not.toBe(secret);
    expect(row.apiKey.startsWith('genr:v1:')).toBe(true);

    // The decisive check: the raw database bytes must not contain the secret.
    expect(leaksPlaintext(secret)).toBe(false);
  });

  it('decrypts the stored key back for server-side use', async () => {
    await providers.saveProviderConfig('custom', {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-round-trip-secret',
    });

    const internal = await providers.getProviderDescriptor('custom');
    expect(internal.apiKey).toBe('sk-round-trip-secret');
    expect(internal.keySource).toBe('local');
  });

  it('migrates a pre-existing PLAINTEXT row on read (and stays idempotent)', async () => {
    const legacy = 'sk-legacy-plaintext-row';
    await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: 'https://example.com/v1', apiKey: legacy, enabled: true },
    });

    const list = await providers.listProviderDescriptors();
    const custom = list.find((p) => p.kind === 'custom');
    expect(custom.keyConfigured).toBe(true);

    // The value still works for the server…
    const internal = await providers.getProviderDescriptor('custom');
    expect(internal.apiKey).toBe(legacy);

    // …but the row was rewritten as ciphertext.
    const row = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    expect(row.apiKey.startsWith('genr:v1:')).toBe(true);
    expect(leaksPlaintext(legacy)).toBe(false);

    // Idempotent: a second read keeps the ciphertext and the same plaintext.
    await providers.listProviderDescriptors();
    const row2 = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    expect(row2.apiKey).toBe(row.apiKey);
    expect((await providers.getProviderDescriptor('custom')).apiKey).toBe(legacy);
  });

  it('leaves the environment-key path untouched (no row, no ciphertext)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-openrouter-env-secret';

    const internal = await providers.getProviderDescriptor('openrouter');
    expect(internal.apiKey).toBe('sk-openrouter-env-secret');
    expect(internal.keySource).toBe('env');

    const rows = await prisma.providerConfig.findMany();
    expect(rows.filter((r) => r.apiKey)).toHaveLength(0);
  });
});

describe('SEC-04 — per-install key file and file modes', () => {
  it('stores the key file next to the database', async () => {
    const secretStore = await import('../../server/lib/secret-store.mjs');
    const keyPath = secretStore.resolveSecretKeyPath();
    expect(existsSync(keyPath)).toBe(true);
    expect(dirname(keyPath)).toBe(dirname(databaseFilePath()));
  });

  it('creates the key file with 0600 on POSIX', async () => {
    const secretStore = await import('../../server/lib/secret-store.mjs');
    const keyPath = secretStore.resolveSecretKeyPath();
    if (!isPosix) return;
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('hardens the data dir (0700) and the database file (0600) on POSIX', async () => {
    const dataDir = await import('../../server/lib/data-dir.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-modes-'));
    const dbFile = join(dir, 'generaptor.db');
    writeFileSync(dbFile, 'sqlite-placeholder');

    dataDir.hardenDataPermissions({ dataDir: dir, databaseUrl: dbFile });

    if (!isPosix) return;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(dbFile).mode & 0o777).toBe(0o600);
  });

  it('hardens the live database file when the server connects', async () => {
    const { connectDB } = await import('../../server/db.mjs');
    await connectDB();
    if (!isPosix) return;
    expect(statSync(databaseFilePath()).mode & 0o777).toBe(0o600);
  });
});
