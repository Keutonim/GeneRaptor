import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * M6 — конфигурация e2e на фейковом API.
 *
 * Отдельный конфиг нужен потому, что основной playwright.config.ts поднимает
 * реальный стек — `node tests/e2e/server-stack.mjs` (настоящий API на
 * одноразовой базе SQLite) и dev-сервер Vite на :5173, — а сквозной путь M6
 * проверяется на подменённом HTTP-слое API (page.route) и требует только
 * dev-сервера Vite.
 *
 * Запуск: npm run test:e2e:mock
 */
export default defineConfig({
  testDir: '.',
  testMatch: /(m6-journey|visual-smoke).spec.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.resolve(process.cwd(), 'tests/report/mock') }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  outputDir: path.resolve(process.cwd(), 'test-results/mock'),

  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173/',
      timeout: 60_000,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
