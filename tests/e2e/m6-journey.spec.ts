import { test, expect } from '@playwright/test';
import { setUiLocale } from './helpers';
import { installFakeApi, ARTICLE_ID } from './fake-api';

/**
 * Сквозной путь на фейковом провайдере (docs/ui-design.md §5).
 *
 * Путь: стартовый токен → тема → генерация → статья отрисовалась →
 * обложка (создать / уточнить / заново) → список истории → открыть → удалить.
 *
 * Провайдер — фейковый: HTTP-слой API подменяется (page.route), поэтому
 * тест не требует Postgres/Redis и проверяет клиентский контракт целиком.
 */

test.describe('M6 — сквозной путь', () => {
  test('токен → тема → генерация → статья → обложка → история → удаление', async ({
    page,
  }) => {
    const state = await installFakeApi(page);
    await setUiLocale(page, 'ru');

    // 1. Стартовый токен (docs/ui-design.md §6) доставляется во фрагменте адреса и
    //    обменивается автоматически — ни одного поля ввода на основном пути.
    await page.goto('/#token=startup-token');

    // Оболочка открывается только после разблокировки.
    await expect(page.locator('.app-topbar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[role="tab"]')).toHaveCount(3);
    // Адрес очищен от токена, инпута нет, обмен действительно состоялся.
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    await expect(page.getByLabel('Токен')).toHaveCount(0);
    expect(state.exchanged).toBe(true);
    expect(state.tokenConsumed).toBe(true);

    // 2. Тема → уточнения на главной → генерация (S5 T5: один шаг, канон продукта).
    await page.locator('#composer-topic').fill('Как выбрать провайдера для статей');
    await expect(page.locator('#composer-notes')).toBeVisible();
    await page.locator('#composer-notes').fill('Продавать именно ультраформер');
    await page.getByRole('button', { name: 'Начать генерацию' }).click();

    // 3. Статья отрисовалась.
    await expect(page.locator('.galley__body')).toContainText('Готовый текст статьи', {
      timeout: 15_000,
    });
    expect(state.created[0]).toMatchObject({
      topic: 'Как выбрать провайдера для статей',
      userNotes: 'Продавать именно ультраформер',
    });

    // 4. Обложка: создать → уточнить → заново.
    await page.getByRole('button', { name: 'Сгенерировать обложку' }).click();
    await expect(page.locator('.cover-panel img')).toBeVisible({ timeout: 15_000 });

    await page.locator('#cover-refinement').fill('Темнее фон, спокойнее цвета');
    await page.getByRole('button', { name: 'Перегенерировать по уточнению' }).click();
    await expect
      .poll(() => state.coverBodies.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);

    await page.getByRole('button', { name: 'Сгенерировать заново' }).click();
    await expect.poll(() => state.coverBodies.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

    expect(state.coverBodies).toContainEqual({ refinement: 'Темнее фон, спокойнее цвета' });
    expect(state.coverBodies).toContainEqual({ fresh: true });

    // 5. История: строка есть, «Открыть» возвращает в генерацию.
    await page.click('[role="tab"]:has-text("История")');
    await expect(page.locator('.history__row')).toHaveCount(1);
    await page.locator('.history__menu').click();
    // S5-ui: the row menu is a real ARIA menu now — its items are menuitems.
    await page.getByRole('menuitem', { name: 'Открыть' }).click();
    await expect(page.locator('.galley__body')).toContainText('Готовый текст статьи');

    // 6. Удаление из истории.
    await page.click('[role="tab"]:has-text("История")');
    await page.locator('.history__menu').click();
    // S5-ui: menu items carry role=menuitem; the dialog confirm stays a button.
    await page.getByRole('menuitem', { name: 'Удалить' }).click();
    await page.getByRole('button', { name: 'Удалить безвозвратно' }).click();
    await expect(page.locator('.history__row')).toHaveCount(0);
  });
});
