/**
 * S5 T3 — `--data-dir` must reach the SERVER child process.
 *
 * Root cause (results/s5-analysis.md §5.3): the launcher resolved the data
 * dir and derived DATABASE_URL, but never exported GENERAPTOR_DATA_DIR. The
 * API child (server/index.mjs) has no --data-dir in its argv, so its
 * resolveDataDir() fell back to ~/.generaptor: cover binaries and the secret
 * key file were written OUTSIDE the instance dir, and the delete cascade
 * (removeArticleCovers) looked into the wrong covers dir — the file survived
 * the article delete.
 *
 * Contract under test (REAL launcher + REAL server, no mocks):
 *   - `--data-dir <tmp>`: the cover file is created INSIDE <tmp>/covers and
 *     DISAPPEARS after DELETE /api/articles/:id; the db lives in <tmp>;
 *   - default (no flag, no env): the data dir stays <home>/.generaptor and
 *     the same cover cleanup works there (behaviour unchanged).
 *
 * No paid calls: every provider key env is blanked, no generation endpoint
 * is touched — the article is seeded straight into SQLite.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { saveCoverBinary } from '../../server/lib/cover-store.mjs';
import { resolveDatabaseUrl } from '../../server/lib/data-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const ARTICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Kill the child and everything it spawned (Windows: taskkill /T). */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/** Boot the REAL launcher with an explicit, key-free environment. */
async function bootLauncher(args, extraEnv = {}) {
  const port = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(
    process.execPath,
    ['start.mjs', '--api-only', '--no-browser', '--no-auth', '--port', String(port), ...args],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        GENERAPTOR_DATA_DIR: '',
        DATABASE_URL: '',
        GENERAPTOR_API_PORT: '',
        PORT: '',
        CORS_ORIGIN: '',
        ACCESS_GATE_DISABLED: '',
        GENERAPTOR_STARTUP_TOKEN: '',
        GENERAPTOR_TOKEN: '',
        GENERAPTOR_TOKEN_TTL: '',
        ROUTERAI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        OLLAMA_API_KEY: '',
        CUSTOM_API_KEY: '',
        GENERAPTOR_SERPER_API_KEY: '',
        TAVILY_API_KEY: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) {
      throw new Error(`launcher exited early (code ${child.exitCode})\n${stdout}\n${stderr}`);
    }
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error(`launcher not ready in 90s\n${stdout}\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  async function stop() {
    killTree(child);
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
  }

  return { port, baseUrl, getStdout: () => stdout, stop };
}

/** Seed one article straight into the instance SQLite (no generation API). */
async function seedArticle(dataDir) {
  const db = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl(dataDir) } } });
  try {
    await db.article.create({
      data: { id: ARTICLE_ID, topic: 'S5 T3: обложка в каталоге инстанса', targetLength: 50000, language: 'ru', status: 'ready' },
    });
  } finally {
    await db.$disconnect();
  }
}

async function articleExists(dataDir) {
  const db = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl(dataDir) } } });
  try {
    return (await db.article.findUnique({ where: { id: ARTICLE_ID } })) !== null;
  } finally {
    await db.$disconnect();
  }
}

/** rmSync with retries — Windows keeps files locked briefly after a kill. */
function rmrf(dir) {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

describe('S5 T3: --data-dir reaches the server child (cover lifecycle)', () => {
  it(
    '--data-dir <tmp>: the cover is created inside tmp and disappears after the article delete',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'generaptor-s5-data-'));
      const srv = await bootLauncher(['--data-dir', dataDir]);
      try {
        // The launcher resolved the instance dir…
        expect(srv.getStdout()).toContain(`Data dir: ${dataDir}`);
        expect(existsSync(join(dataDir, 'generaptor.db'))).toBe(true);

        await seedArticle(dataDir);
        // …and the REAL cover store writes the binary inside it.
        const cover = saveCoverBinary({
          articleId: ARTICLE_ID,
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          dataDir,
        });
        expect(cover.path.startsWith(join(dataDir, 'covers'))).toBe(true);
        expect(existsSync(cover.path)).toBe(true);

        const res = await fetch(`${srv.baseUrl}/api/articles/${ARTICLE_ID}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // The server child must have cleaned the cover in the INSTANCE dir.
        expect(existsSync(cover.path)).toBe(false);
        expect(await articleExists(dataDir)).toBe(false);
      } finally {
        await srv.stop();
        rmrf(dataDir);
      }
    },
    150_000,
  );

  it(
    'default (no flag, no env): the data dir stays <home>/.generaptor and cleanup works there',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'generaptor-s5-home-'));
      const expectedDir = join(home, '.generaptor');
      // os.homedir() reads USERPROFILE on Windows, HOME on POSIX.
      const srv = await bootLauncher([], { USERPROFILE: home, HOME: home });
      try {
        expect(srv.getStdout()).toContain(`Data dir: ${expectedDir}`);
        expect(existsSync(join(expectedDir, 'generaptor.db'))).toBe(true);

        await seedArticle(expectedDir);
        const cover = saveCoverBinary({
          articleId: ARTICLE_ID,
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          dataDir: expectedDir,
        });
        expect(existsSync(cover.path)).toBe(true);

        const res = await fetch(`${srv.baseUrl}/api/articles/${ARTICLE_ID}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(existsSync(cover.path)).toBe(false);
        expect(await articleExists(expectedDir)).toBe(false);
      } finally {
        await srv.stop();
        rmrf(home);
      }
    },
    150_000,
  );
});

/**
 * S5 T3 (round 2) — D1/D2/D3/D5/D6 of results/s5-security-pre.md §4.4.
 *
 * D1: the launcher exports an ABSOLUTE data dir. D6: a RELATIVE --data-dir
 * resolves to the same absolute dir in the launcher AND in the child (the
 * child's cwd is ROOT, so a relative value handed over as-is would diverge).
 * D3: the default ~/.generaptor is NOT created as a side effect. D2: the DB,
 * the provider key file and the covers all live inside the instance dir.
 * D5: the POSIX modes are private (0700 dir / 0600 files).
 */
const isPosix = process.platform !== 'win32';

/** Store a provider key through the REAL API — no probe, so no paid call. */
async function storeProviderKey(baseUrl) {
  const res = await fetch(`${baseUrl}/api/settings/providers/openrouter`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 's5r2-local-only-not-a-real-key' }),
  });
  return res.status;
}

describe('S5 T3: one absolute data dir for the launcher and the child (D1/D2/D3/D5/D6)', () => {
  it(
    'D1/D6/D3: a RELATIVE --data-dir becomes ONE absolute dir, and ~/.generaptor is never created',
    async () => {
      // The launcher's cwd AND the child's cwd are both ROOT, so a relative
      // flag value must be resolved once, by the launcher, and handed over
      // absolute. The name is unique per run and removed afterwards.
      const relName = `tmp-s5r2-rel-${process.pid}-${Date.now()}`;
      const absDir = join(ROOT, relName);
      const home = mkdtempSync(join(tmpdir(), 'generaptor-s5r2-home-'));
      const srv = await bootLauncher(['--data-dir', `./${relName}`], {
        USERPROFILE: home,
        HOME: home,
      });
      try {
        // D1 — the announced path is absolute and is the resolved one.
        const line = srv
          .getStdout()
          .split('\n')
          .find((l) => l.includes('Data dir:'));
        expect(line).toBeDefined();
        const announced = line.split('Data dir:')[1].trim();
        expect(isAbsolute(announced)).toBe(true);
        expect(announced).toBe(absDir);
        expect(existsSync(join(absDir, 'generaptor.db'))).toBe(true);

        // D6 — the child really uses that SAME absolute dir: the cover it
        // deletes on DELETE /api/articles/:id is the one in <abs>/covers.
        await seedArticle(absDir);
        const cover = saveCoverBinary({
          articleId: ARTICLE_ID,
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          dataDir: absDir,
        });
        expect(existsSync(cover.path)).toBe(true);
        const res = await fetch(`${srv.baseUrl}/api/articles/${ARTICLE_ID}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(existsSync(cover.path)).toBe(false);
        expect(await articleExists(absDir)).toBe(false);

        // D3 — no side-effect creation of the default dir in the fake home.
        expect(existsSync(join(home, '.generaptor'))).toBe(false);
      } finally {
        await srv.stop();
        rmrf(absDir);
        rmrf(home);
      }
    },
    150_000,
  );

  it(
    'D2/D5: the DB, the key file and the covers are inside <tmp> and private (0700/0600 on POSIX)',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'generaptor-s5r2-modes-'));
      const srv = await bootLauncher(['--data-dir', dataDir]);
      try {
        // D2 — the database is in the instance dir…
        const dbFile = join(dataDir, 'generaptor.db');
        expect(existsSync(dbFile)).toBe(true);

        // …the provider key file too (created by the REAL child when it
        // encrypts the key we store through the API — no probe, no paid call)…
        expect(await storeProviderKey(srv.baseUrl)).toBe(200);
        const keyFile = join(dataDir, 'provider-secrets.key');
        expect(existsSync(keyFile)).toBe(true);

        // …and the covers.
        const cover = saveCoverBinary({
          articleId: ARTICLE_ID,
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          dataDir,
        });
        const coversDir = join(dataDir, 'covers');
        expect(cover.path.startsWith(coversDir)).toBe(true);
        expect(existsSync(cover.path)).toBe(true);

        // D5 — POSIX modes. On Windows the POSIX bits are not the security
        // boundary (NTFS ACLs are), so the mode assertions are POSIX-only —
        // the same convention as tests/integration/provider-secret-at-rest.test.mjs.
        if (!isPosix) return;
        expect(statSync(dataDir).mode & 0o777).toBe(0o700);
        expect(statSync(dbFile).mode & 0o777).toBe(0o600);
        expect(statSync(keyFile).mode & 0o777).toBe(0o600);
        expect(statSync(coversDir).mode & 0o777).toBe(0o700);
        expect(statSync(cover.path).mode & 0o777).toBe(0o600);
      } finally {
        await srv.stop();
        rmrf(dataDir);
      }
    },
    150_000,
  );
});