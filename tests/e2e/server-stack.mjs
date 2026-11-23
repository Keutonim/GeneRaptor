/**
 * E2E server stack (SQLite, in-process server).
 *
 * Boots the REAL GeneRaptor API on a throw-away SQLite database so the
 * Playwright suite needs neither PostgreSQL nor Redis. The previous
 * playwright.config.ts pointed at
 * `postgresql://user:pass@localhost:5432/db` + `redis://localhost:6379`
 * — neither service exists on a developer machine, and the server itself never
 * read REDIS_URL (the in-process runner replaced BullMQ in M1).
 *
 * Steps:
 *   1. pick an isolated data dir (tests/e2e/.data, wiped on every run).
 *      A developer-provided GENERAPTOR_DATA_DIR is respected and never wiped;
 *   2. bootstrap the schema on the SQLite file (prisma db push --skip-generate);
 *   3. seed a deterministic fixture (company profile, one finished article,
 *      four AgentRun rows) so the API and the UI have something to show;
 *   4. start the API — the same createExpressApp() stack as `npm start`.
 *
 * The access gate is disabled for this stack: the browser flow has no startup
 * token to exchange, and a 401 would drop the client back to the token screen
 * (server/lib/auth.mjs requireGate). Override with ACCESS_GATE_DISABLED=false
 * only together with a token exchange in the test itself.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** Fixture ids — kept in sync with tests/e2e/sqlite-stack.spec.ts. */
const ARTICLE_ID = '11111111-1111-4111-8111-000000000001';
const PROFILE_ID = '33333333-3333-4333-8333-000000000001';
const RUN_IDS = [0, 1, 2, 3].map(
  (i) => `22222222-2222-4222-8222-00000000000${i}`,
);

/** How many chain stages of the fixture are already in the AgentRun ledger. */
const COMPLETED_STAGES = 4;
/** Stage duration of every seeded run (ms). */
const STAGE_DURATION_MS = 45_000;
/** Epoch of the seeded timeline (ms) — fixed, so assertions stay deterministic. */
const TIMELINE_START_MS = Date.parse('2026-01-01T10:00:00.000Z');

// ── 1. data dir ────────────────────────────────────────────────────────────
const ownsDataDir = !(process.env.GENERAPTOR_DATA_DIR || '').trim();
if (ownsDataDir) {
  process.env.GENERAPTOR_DATA_DIR = join(ROOT, 'tests', 'e2e', '.data');
  rmSync(process.env.GENERAPTOR_DATA_DIR, { recursive: true, force: true });
}

const { resolveDataDir, resolveDatabaseUrl, DATABASE_FILE_NAME } = await import(
  '../../server/lib/data-dir.mjs'
);
const { ensureDatabaseSchema } = await import('../../server/lib/db-bootstrap.mjs');

const dataDir = resolveDataDir();
process.env.DATABASE_URL = resolveDatabaseUrl(dataDir);
process.env.ACCESS_GATE_DISABLED = process.env.ACCESS_GATE_DISABLED || 'true';
process.env.GENERAPTOR_API_PORT = process.env.GENERAPTOR_API_PORT || '8787';
process.env.GENERAPTOR_HOST = process.env.GENERAPTOR_HOST || '127.0.0.1';

// ── 2. schema bootstrap ────────────────────────────────────────────────────
const dbFile = join(dataDir, DATABASE_FILE_NAME);
const bootstrap = ensureDatabaseSchema({ dbFile, root: ROOT, env: process.env, logger: console });
if (bootstrap.bootstrapped && bootstrap.status !== 0) {
  console.error('[e2e] prisma db push failed:\n' + bootstrap.stderr);
  process.exit(1);
}

// ── 3. deterministic fixture ───────────────────────────────────────────────
const { prisma } = await import('../../server/db.mjs');
const { agentRoleData } = await import('../../server/agent-role-data.mjs');

await prisma.agentRun.deleteMany({ where: { articleId: ARTICLE_ID } });
await prisma.article.deleteMany({ where: { id: ARTICLE_ID } });
await prisma.companyProfile.deleteMany({ where: { id: PROFILE_ID } });

await prisma.companyProfile.create({
  data: {
    id: PROFILE_ID,
    name: 'E2E Company',
    phone: '+7 000 000-00-00',
    email: 'e2e@example.test',
    address: 'E2E test address',
    licenses: 'Лицензия № E2E',
    parsedText: 'Автотестовая карточка компании для e2e-набора.',
    editedText: 'Автотестовая карточка компании для e2e-набора.',
    activeText: 'Автотестовая карточка компании для e2e-набора.',
  },
});

await prisma.article.create({
  data: {
    id: ARTICLE_ID,
    topic: 'E2E: статья на SQLite',
    targetLength: 1200,
    language: 'ru',
    status: 'ready',
  },
});

// The ledger the worker writes: agentName is the role's RU name, exactly like
// server/workers/article-generation.mjs stores it.
for (let i = 0; i < COMPLETED_STAGES; i += 1) {
  const role = agentRoleData[i];
  const startedAt = new Date(TIMELINE_START_MS + i * 60_000);
  await prisma.agentRun.create({
    data: {
      id: RUN_IDS[i],
      articleId: ARTICLE_ID,
      agentName: role.nameRu,
      status: 'completed',
      progress: 100,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + STAGE_DURATION_MS),
    },
  });
}

console.log(
  `[e2e] fixture ready: article ${ARTICLE_ID}, ${COMPLETED_STAGES} AgentRun rows, db ${dbFile}`,
);

// ── 4. API ─────────────────────────────────────────────────────────────────
const { createExpressApp } = await import('../../server/express-app.mjs');
const server = await createExpressApp();

console.log(
  `[e2e] API ready on http://${process.env.GENERAPTOR_HOST}:${process.env.GENERAPTOR_API_PORT} (SQLite)`,
);

async function shutdown() {
  try {
    server.close();
  } catch {
    /* already closed */
  }
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
