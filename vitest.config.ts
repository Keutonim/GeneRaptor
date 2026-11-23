import { defineConfig } from 'vitest/config';

/**
 * Vitest config for GeneRaptor server-side tests.
 *
 * - Excludes Playwright e2e specs (tests/e2e/**) — those run via `npx playwright test`.
 * - Test database: fresh SQLite file per run, provisioned by
 *   tests/global-setup.mjs (prisma db push into a temp dir). DATABASE_URL is
 *   set there on purpose — defining it in `test.env` would override it.
 * - Sequential run (fileParallelism: false) — single shared test DB.
 * - LLM calls must never leave the machine: ROUTERAI_ENDPOINT points at an
 *   unbound localhost port (mocked-LLM endpoint pattern); tests mock
 *   callRouterAI explicitly.
 *
 * Run: `npm test` (one-shot) or `npm run test:watch` (watch mode).
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.{test,spec}.{mjs,ts,js}', 'tests/integration/**/*.{test,spec}.{mjs,ts,js}', 'tests/worker/**/*.{test,spec}.{mjs,ts,js}'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    globalSetup: ['tests/global-setup.mjs'],
    globals: true,
    fileParallelism: false,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      // Avoid real RouterAI calls in tests; tests mock callRouterAI explicitly.
      ROUTERAI_API_KEY: 'test-mock-key-not-real',
      ROUTERAI_ENDPOINT: 'http://localhost:9999',
      // Access gate: disabled by default so legacy integration suites that hit
      // protected routes without a cookie keep passing (R-20). The dedicated
      // auth-gate + token-exchange suites re-enable it locally per-case.
      ACCESS_GATE_HMAC_KEY: 'a'.repeat(64),
      ACCESS_GATE_DISABLED: 'true',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['server/**/*.mjs'],
      exclude: ['server/test/**', '**/*.d.ts'],
      reportsDirectory: 'tests/coverage',
    },
  },
});
