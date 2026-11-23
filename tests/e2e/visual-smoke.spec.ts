import { test, expect } from '@playwright/test';
import { awaitShell, gotoTab, shoot, expectVisible, setUiLocale } from './helpers';
import { installFakeApi } from './fake-api';

/**
 * M6 — визуальный смоук оболочки (docs/ui-design.md §4, §5).
 *
 * Проверяет форму оболочки: верхняя панель, ровно три вкладки
 * (Генерация / История / Настройки), переключатели языка и темы,
 * отсутствие боковой панели и четыре раздела в настройках
 * (S5 T6: добавлена секция «Генерация обложек» рядом с «Моделями»).
 *
 * Инфраструктура поднимается playwright.config.ts (webServer).
 */

test.describe('M6 — оболочка', () => {
  test.beforeEach(async ({ page }) => {
    // Фейковый API: смоук идёт без Postgres/Redis (см. playwright.mock.config.ts).
    await installFakeApi(page, { authenticated: true });
    await setUiLocale(page, 'ru');
    await awaitShell(page);
  });

  test('верхняя панель: ровно три вкладки, язык и тема', async ({ page }) => {
    await expect(page.locator('.app-topbar')).toBeVisible();
    await expect(page.locator('.app-wordmark')).toContainText('GeneRaptor');

    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toContainText('Генерация');
    await expect(tabs.nth(1)).toContainText('История');
    await expect(tabs.nth(2)).toContainText('Настройки');

    // Переключатель языка (RU|EN) и темы (3 состояния).
    await expect(page.locator('.app-topbar .segmented[role="radiogroup"]')).toHaveCount(2);
    await expect(page.locator('.app-server-line')).toBeVisible();

    // Боковой панели быть не должно (docs/ui-design.md §4 — только верхняя панель).
    await expect(page.locator('aside, .sidebar')).toHaveCount(0);

    await shoot(page, 'm6-01-shell');
  });

  test('вкладка «Генерация» открывает компоновер', async ({ page }) => {
    await gotoTab(page, 'Генерация');
    await expectVisible(page, 'Тема статьи');
    await expect(page.locator('#composer-topic')).toBeVisible();
    // «Язык материала» (D6) — параметр генерации.
    await expectVisible(page, 'Язык материала');
    await shoot(page, 'm6-02-generation');
  });

  test('вкладка «История» открывает список статей', async ({ page }) => {
    await gotoTab(page, 'История');
    await expectVisible(page, 'История');
    await expect(page.locator('#history-filter')).toBeVisible();
    await shoot(page, 'm6-03-history');
  });

  // S5 T6: the cover panel is mounted as its own section next to Models
  // (product canon); the old QA X1 "no cover section" pin is superseded.
  test('вкладка «Настройки»: четыре раздела, включая «Генерацию обложек», без «Общих»', async ({ page }) => {
    await gotoTab(page, 'Настройки');
    await expectVisible(page, 'Провайдеры и ключи');
    await expect(page.locator('section.settings__section')).toHaveCount(4);

    const titles = await page.locator('section.settings__section h2').allInnerTexts();
    expect(titles.map((title) => title.trim())).toEqual([
      'Провайдеры и ключи',
      'Модели',
      'Генерация обложек',
      'Роли',
    ]);

    const body = await page.locator('body').innerText();
    expect(body).toContain('Генерация обложек');
    expect(body).not.toContain('Общие настройки');
    await shoot(page, 'm6-04-settings');
  });
});
