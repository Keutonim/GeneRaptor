/**
 * Test helpers for GeneRaptor integration tests (M2: SQLite + trimmed API).
 *
 * - testPrisma:    PrismaClient bound to the test database (DATABASE_URL from env,
 *                  provisioned by tests/global-setup.mjs via `prisma db push`).
 * - truncateAll(): wipe all rows (SQLite has no TRUNCATE — deleteMany per table).
 * - seedFixture(): minimal dataset (1 standalone CompanyProfile row — the
 *                  optional author profile).
 * - createTestApp(): Express app with the real routers mounted, WITHOUT listen/worker.
 *                    Mirrors production middleware order: cookie-parser + gate.
 * - loginAsAuthed(app): returns the `Cookie` header value to authenticate a
 *                    request against the gate (R-20).
 *
 * Used by tests/integration/** only. Not imported by worker suites.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';

import { articlesRouter } from '../server/routes/articles.mjs';
// Cover wave (2026-10-24): mirrors the express-app.mjs mount order.
import coverSettingsRoutes from '../server/routes/cover-settings.mjs';
// API key status + real probe.
import apiKeysRoutes from '../server/routes/api-keys.mjs';
// Правки systemPrompt агентских ролей.
import agentRolesRoutes from '../server/routes/agent-roles.mjs';
import { healthRouter } from '../server/routes/health.mjs';
import { authRouter } from '../server/routes/auth.mjs';
import {
  requireGate,
  createGateToken,
  resolveGateKey,
  GATE_COOKIE_NAME,
} from '../server/lib/auth.mjs';

/** Prisma client pointed at the test DB (DATABASE_URL injected by vitest config). */
export const testPrisma = new PrismaClient({ log: ['error', 'warn'] });

/** Tables of the 8-model GeneRaptor schema, FK-safe delete order. */
const TABLES = [
  'agent_run',
  'article_version',
  'research_source',
  'article',
  'cover_settings',
  'agent_role_settings',
  'company_profile',
  'provider_config',
];

/**
 * Wipe all rows from the test DB. Safe to call before each test for isolation.
 * SQLite has no TRUNCATE — deleteMany per table in FK-safe order.
 */
export async function truncateAll() {
  for (const table of TABLES) {
    await testPrisma.$executeRawUnsafe(`DELETE FROM "${table}";`);
  }
}

/**
 * Seed a minimal dataset into the test DB (M2: crawled-source entities are
 * gone; creation is topic-only). Creates one standalone CompanyProfile row —
 * the optional author profile that feeds the author-signature prompt block.
 *
 * @returns {{ companyProfile }}
 */
export async function seedFixture() {
  const companyProfile = await testPrisma.companyProfile.create({
    data: {
      name: 'GeneRaptor Test Profile',
      activeText: 'Test author profile text.',
    },
  });
  return { companyProfile };
}

/**
 * Build an Express application with the real routers mounted, but WITHOUT
 * calling createExpressApp() (which would listen, start the worker, and attach
 * a WebSocket server). Tests do their own app.listen(0) on a random port.
 *
 * Mirrors the route + middleware mounting order from server/express-app.mjs:
 * cookie-parser → health (public) → auth (public) → gate → everything else.
 *
 * The gate is active by default. Legacy integration suites that call protected
 * routes must either (a) pass the auth cookie returned by loginAsAuthed(), or
 * (b) set ACCESS_GATE_DISABLED=true in the test env to bypass it (R-20).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withGate=true] - mount the access gate middleware.
 * @returns {import('express').Express}
 */
export function createTestApp(opts = {}) {
  const { withGate = true } = opts;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // Public routes — before the gate. Same order as server/express-app.mjs.
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);

  if (withGate) {
    app.use(requireGate);
  }

  app.use('/api', articlesRouter);
  // Cover wave (2026-10-24): mirrors the express-app.mjs mount order.
  app.use('/api/settings/cover', coverSettingsRoutes);
  // Mirrors the express-app.mjs mount order.
  app.use('/api/settings/api-keys', apiKeysRoutes);
  // Mirrors the express-app.mjs mount order.
  app.use('/api/settings/agent-roles', agentRolesRoutes);

  // 404 — matches the production handler shape.
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // Global error handler — mirrors server/express-app.mjs.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const message =
      status === 500 ? 'Internal server error' : err.message || 'Internal server error';
    res.status(status).json({ success: false, error: message });
  });

  return app;
}

/**
 * Returns the `Cookie` header value a test request must send to authenticate
 * against the gate. Uses the real signing key so the cookie is
 * indistinguishable from a production-issued one.
 *
 * Requires ACCESS_GATE_HMAC_KEY (or JWT_SECRET, or neither — the per-process
 * key) in env; injected by the test bootstrap (see vitest.config.ts).
 */
export function loginAsAuthed() {
  // Touch the key resolution so a misconfiguration surfaces here, not deeper.
  resolveGateKey();
  const token = createGateToken();
  return `${GATE_COOKIE_NAME}=${token}`;
}

/**
 * Start the test app on an ephemeral port and resolve { server, baseUrl }.
 * Caller must `server.close()` in afterAll.
 */
export function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
    server.on('error', reject);
  });
}
