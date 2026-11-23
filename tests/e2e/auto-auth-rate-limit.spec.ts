import { test, expect } from '@playwright/test';
import { setUiLocale } from './helpers';

/**
 * A persistent 429 must NOT turn the client into an unbounded
 * background retry loop (that would keep the exchange limiter hot forever —
 * a login DoS against the owner's own studio).
 *
 * Self-contained fake (no shared fake-api): the status probe says "no
 * session", every exchange answers 429 with Retry-After: 1 s. The contract
 * under test:
 *   - exactly ONE initial automatic exchange;
 *   - at most MAX_AUTO_RETRIES (=2) automatic retries after the countdown;
 *   - after the cap the hint is STATIC: no further background exchange;
 *   - the manual «Обновить» button still retries (user-initiated).
 *
 * The journal of exchange requests is the anti-fictive assertion: a green
 * hint screen alone would not prove the loop stopped.
 */

test.describe('Потолок автоповторов при 429', () => {
  test('после двух автоповторов обмен прекращается, ручной «Обновить» работает', async ({ page }) => {
    const exchanges: Array<{ method: string; at: number }> = [];
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/status') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: false }),
        });
      }
      if (path === '/api/auth/exchange') {
        exchanges.push({ method: route.request().method(), at: Date.now() });
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1' },
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Слишком много попыток' }),
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await setUiLocale(page, 'ru');

    await page.goto('/#token=startup-token');
    await expect(page.locator('[data-testid="session-hint"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="session-hint"]')).toContainText('Слишком много попыток');

    // 1 initial + 2 automatic retries, then the cap.
    await expect.poll(() => exchanges.length, { timeout: 20_000 }).toBe(3);
    expect(exchanges.every((e) => e.method === 'POST')).toBe(true);

    // Static hint: no background exchange while the window stays closed.
    await page.waitForTimeout(4_000);
    expect(exchanges.length).toBe(3);
    await expect(page.locator('[data-testid="session-hint"]')).toBeVisible();
    await expect(page.locator('.app-topbar')).toHaveCount(0);

    // T-13: the capped hint is STATIC — no frozen countdown («через 0 с»),
    // the copy points at the manual Refresh button instead.
    await expect(page.locator('[data-testid="session-hint"]')).toContainText('Автоповторы исчерпаны');
    await expect(page.locator('[data-testid="session-hint"]')).not.toContainText('через');

    // Manual refresh is still allowed and is user-initiated.
    await page.getByRole('button', { name: 'Обновить' }).click();
    await expect.poll(() => exchanges.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  });
});