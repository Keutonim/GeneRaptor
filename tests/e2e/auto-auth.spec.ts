import { test, expect } from '@playwright/test';
import { setUiLocale } from './helpers';
import { installFakeApi } from './fake-api';

/**
 * Вход без ввода токена: одноразовый токен доставляется во фрагменте адреса.
 *
 * Четыре сценария на фейковом API, приведённом к РЕАЛЬНОму контракту сервера
 * (200 {authenticated} на статус, single-use обмен):
 *
 *   1. фрагмент с токеном → оболочка без единого инпута, адрес очищен,
 *      обмен ровно один, дальше запросы идут БЕЗ заголовка Authorization;
 *   2. мёртвый токен → подсказка без инпута, фрагмент удалён;
 *   3. вторичный ручной фоллбэк → инпут → обмен → оболочка;
 *   4. без фрагмента и без сессии → подсказка «перезапустите студию».
 *
 * ВАЖНО: e2e-стек поднимает сервер с ACCESS_GATE_DISABLED=true,
 * поэтому зелёный e2e НЕ доказывает серверный гейт — его доказывают
 * integration-наборы (token-exchange, host-origin-guard, access-gate-casing)
 * и живые пробы на реальном сервере с включённым гейтом.
 */

test.describe('Автосессия без ввода токена', () => {
  test('фрагмент с токеном открывает приложение без ввода и чистит адрес', async ({ page }) => {
    const state = await installFakeApi(page);
    await setUiLocale(page, 'ru');

    await page.goto('/#token=startup-token');

    // Оболочка видна, поля ввода токена на основном пути нет.
    await expect(page.locator('.app-topbar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[role="tab"]')).toHaveCount(3);
    await expect(page.getByLabel('Токен')).toHaveCount(0);

    // Токен исчез из адреса и из записи истории.
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    expect(await page.evaluate(() => window.location.search)).toBe('');
    await expect(page).toHaveURL(/\/$/);

    // Обмен действительно состоялся (не «оболочка сама показалась»).
    expect(state.exchanged).toBe(true);
    expect(state.tokenConsumed).toBe(true);
    const exchanges = state.requests.filter((r) => r.path === '/api/auth/exchange');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].method).toBe('POST');
    expect(exchanges[0].authorization).toBe('Bearer startup-token');

    // The dev/StrictMode double mount must not fire a second exchange
    // once the first flow has settled.
    await page.waitForTimeout(1500);
    expect(state.requests.filter((r) => r.path === '/api/auth/exchange')).toHaveLength(1);

    // После обмена клиент не прикрепляет токен к data-запросам.
    await expect
      .poll(() => state.requests.filter((r) => !r.path.startsWith('/api/auth/')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const dataRequests = state.requests.filter((r) => !r.path.startsWith('/api/auth/'));
    expect(dataRequests.every((r) => r.authorization === null)).toBe(true);

    // Токен не оседает в клиентском хранилище.
    const storage = await page.evaluate(() => ({
      local: Object.entries(window.localStorage),
      session: Object.entries(window.sessionStorage),
    }));
    for (const [, value] of [...storage.local, ...storage.session]) {
      expect(value).not.toContain('startup-token');
    }
  });

  test('мёртвый токен даёт подсказку без инпута и убирает фрагмент', async ({ page }) => {
    const state = await installFakeApi(page);
    await setUiLocale(page, 'ru');

    await page.goto('/#token=already-used-token');

    await expect(page.locator('[data-testid="session-hint"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="session-hint"]')).toContainText('устарела');
    await expect(page.getByLabel('Токен')).toHaveCount(0);
    await expect(page.locator('.app-topbar')).toHaveCount(0);
    // Мёртвый токен в адресе не держим.
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    expect(state.exchanged).toBe(false);
  });

  test('вторичный ручной фоллбэк: ссылка → инпут → обмен → оболочка', async ({ page }) => {
    const state = await installFakeApi(page);
    await setUiLocale(page, 'ru');

    await page.goto('/');
    await expect(page.locator('[data-testid="session-hint"]')).toBeVisible({ timeout: 15_000 });
    // До клика по вторичной ссылке инпута нет.
    await expect(page.getByLabel('Токен')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ввести токен вручную' }).click();
    const tokenInput = page.getByLabel('Токен');
    await expect(tokenInput).toHaveCount(1);
    await expect(tokenInput).toBeVisible();

    await tokenInput.fill('startup-token');
    await page.getByRole('button', { name: 'Открыть' }).click();

    await expect(page.locator('.app-topbar')).toBeVisible({ timeout: 15_000 });
    expect(state.exchanged).toBe(true);
  });

  test('без фрагмента и без сессии — подсказка «перезапустите студию»', async ({ page }) => {
    const state = await installFakeApi(page);
    await setUiLocale(page, 'ru');

    await page.goto('/');
    await expect(page.locator('[data-testid="session-hint"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="session-hint"]')).toContainText('Перезапустите студию');
    await expect(page.getByLabel('Токен')).toHaveCount(0);

    // «Обновить» перепроверяет статус и не выдумывает сессию.
    await page.getByRole('button', { name: 'Обновить' }).click();
    await expect(page.locator('[data-testid="session-hint"]')).toBeVisible();
    expect(state.exchanged).toBe(false);
    expect(state.requests.some((r) => r.path === '/api/auth/exchange')).toBe(false);
  });
});