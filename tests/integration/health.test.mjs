// Runs on SQLite with the in-process runner (no external services).
/**
 * Integration test for GET /api/health.
 *
 * Verifies the health endpoint surfaces service-configuration flags
 * (routeraiConfigured, yandexConfigured, models.hard/standard) AND that it
 * never leaks the actual secret material (no 'sk-' prefix, no 'Bearer').
 *
 * Strategy: real Express app on an ephemeral port via createTestApp() —
 * the same production healthRouter that server/express-app.mjs mounts.
 * No DB seeding needed; health only runs `SELECT 1` + redis PING.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, startServer, testPrisma } from '../helpers.mjs';

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testPrisma.$disconnect();
});

describe('GET /api/health — configuration flags', () => {
  it('returns 200 with the expected config block shape', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const body = await res.json();

    // Core connectivity fields (shape only — values depend on test infra).
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('db');
    // M1: redis is gone with BullMQ/ioredis; M2: the frequency-keyword
    // token flag is gone with its tree.
    expect(body).toHaveProperty('timestamp');

    // Required config flags.
    expect(body).toHaveProperty('routeraiConfigured');
    expect(typeof body.routeraiConfigured).toBe('boolean');

    expect(body).toHaveProperty('yandexConfigured');
    expect(typeof body.yandexConfigured).toBe('boolean');

    // models block — 3 tiers (critical/generation/standard) per llm-tier-rebalance.
    expect(body).toHaveProperty('models');
    expect(body.models).toHaveProperty('critical');
    expect(body.models).toHaveProperty('generation');
    expect(body.models).toHaveProperty('standard');
    // Model names are either a non-empty string or null.
    expect(body.models.critical === null || typeof body.models.critical === 'string').toBe(true);
    expect(body.models.generation === null || typeof body.models.generation === 'string').toBe(true);
    expect(body.models.standard === null || typeof body.models.standard === 'string').toBe(true);
  });

  it('reports routeraiConfigured=true under the vitest mock key', async () => {
    // vitest.config.ts sets ROUTERAI_API_KEY='test-mock-key-not-real' — a real-
    // looking value that is NOT one of the .env.example placeholders, so
    // isConfigured() must accept it.
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();

    expect(body.routeraiConfigured).toBe(true);
  });

  it('never leaks the raw secret value into the response body', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();

    // Serialize the entire payload and assert no secret-like substrings.
    const serialized = JSON.stringify(body);

    // The RouterAI key is not a placeholder, so it is 'configured' — but its
    // raw value must never appear in the response.
    expect(serialized).not.toContain('test-mock-key-not-real');

    // Generic guards: no typical API-key prefixes and no auth header leakage.
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('Bearer');
  });
});
