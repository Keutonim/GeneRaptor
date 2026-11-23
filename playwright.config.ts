import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for GeneRaptor E2E tests.
 *
 * The stack runs on SQLite — no PostgreSQL, no Redis. The
 * previous config started the API against
 * `postgresql://user:pass@localhost:5432/db` + `redis://localhost:6379`;
 * neither service exists on a developer machine and the server itself never
 * read REDIS_URL (the in-process runner replaced BullMQ in M1).
 *
 * Infrastructure (auto-started by the webServer block):
 *   - tests/e2e/server-stack.mjs → the real API on a throw-away SQLite
 *     database (schema bootstrap + deterministic fixture);
 *   - Vite dev server (npm run dev) on :5173, proxying /api → :8787.
 *
 * The API port defaults to 8787: vite.config.ts proxies /api to the same
 * port. Note: the API process embeds the article-generation worker inline
 * (express-app.mjs), so we do NOT start `npm run worker` separately — that
 * would race on the queue.
 *
 * GENERAPTOR_E2E_API_PORT /
 * GENERAPTOR_E2E_UI_PORT parameterize the TEST STACK ONLY (not product env
 * vars, absent from .env.example and product docs) so the gate can run on
 * free ports while a foreign app holds the defaults. With the UI port env
 * set, the Vite webServer is NOT reused (an existing server on that port
 * would be somebody else's app) and vite.config.ts enables strictPort.
 * Without the env vars every value and flag stays exactly as before.
 */
const API_PORT = Number(process.env.GENERAPTOR_E2E_API_PORT || 8787);
const UI_PORT_ENV = process.env.GENERAPTOR_E2E_UI_PORT;
const UI_PORT = Number(UI_PORT_ENV || 5173);
const API_HOST = '127.0.0.1';
const API_URL = `http://${API_HOST}:${API_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // sequential: single browser context, shared dev stack
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // The report is a GENERATED artifact — it must land
  // in an ignored directory, never in a tracked one (the old 'tests/report/'
  // rewrote a tracked index.html on every run and dirtied the tree).
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/.artifacts/report' }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: 'node tests/e2e/server-stack.mjs',
      url: `${API_URL}/api/health`,
      env: {
        GENERAPTOR_API_PORT: String(API_PORT),
        GENERAPTOR_HOST: API_HOST,
        ACCESS_GATE_DISABLED: 'true',
      },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${UI_PORT}/`,
      timeout: 60_000,
      // Isolated mode (explicit UI port env): never reuse an existing server —
      // it could be a foreign application. Default mode keeps reuse as before.
      reuseExistingServer: !UI_PORT_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
