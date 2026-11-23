import { test, expect } from '@playwright/test';

/**
 * The E2E stack must run on SQLite — no PostgreSQL, no Redis.
 *
 * The stack under test is started by playwright.config.ts →
 * tests/e2e/server-stack.mjs: a throw-away SQLite database with a
 * deterministic fixture (one finished article + four AgentRun rows) and the
 * real API in front of it.
 *
 * Fixture ids — kept in sync with tests/e2e/server-stack.mjs.
 */
const ARTICLE_ID = '11111111-1111-4111-8111-000000000001';
/** Every seeded stage lasts exactly 45 s, stages start one minute apart. */
const STAGE_DURATION_MS = 45_000;

test.describe('E2E stack on SQLite', () => {
  test('health reports a connected SQLite database', async ({ request }) => {
    const res = await request.get('/api/health');

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
  });

  test('the seeded article is served from the SQLite database', async ({ request }) => {
    const res = await request.get('/api/articles');

    expect(res.status()).toBe(200);
    const body = await res.json();
    const articles = Array.isArray(body.data?.articles) ? body.data.articles : body.data;
    expect(Array.isArray(articles)).toBe(true);
    expect(articles.some((article: { id: string }) => article.id === ARTICLE_ID)).toBe(true);
  });

  test('the progress endpoint returns the stage timeline with durations', async ({ request }) => {
    const res = await request.get(`/api/articles/${ARTICLE_ID}/progress`);

    expect(res.status()).toBe(200);
    const body = await res.json();
    const data = body.data;

    expect(data.articleId).toBe(ARTICLE_ID);
    expect(data.stages).toHaveLength(11);
    expect(data.stages[0]).toMatchObject({
      key: 'topic-selector',
      status: 'completed',
      durationMs: STAGE_DURATION_MS,
    });
    expect(data.stages[4].status).toBe('pending');
    expect(data.overall.completedStages).toBe(4);
    // First stage starts at the timeline start, the last one finishes 45 s
    // after it started three minutes later.
    expect(data.overall.totalDurationMs).toBe(60_000 * 3 + STAGE_DURATION_MS);
  });

  test('the UI boots against the SQLite stack (no access-gate lock)', async ({ page }) => {
    await page.goto('/');

    // The shell renders (any of the layouts' chrome), i.e. the client is not
    // stuck on the token screen.
    await expect(
      page.locator('nav, [role="navigation"], main, .app-shell__frame').first(),
    ).toBeVisible({ timeout: 20_000 });

    // The browser reaches the API through the Vite proxy → SQLite stack.
    const status = await page.evaluate(async () => (await fetch('/api/health')).status);
    expect(status).toBe(200);
  });
});
