import { Page, expect } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join } from 'path';

// The screenshots are GENERATED artifacts — they must
// land in an ignored directory (the old 'tests/screenshots/' rewrote tracked
// PNGs on every run and dirtied the tree).
const SCREENSHOT_DIR = join(process.cwd(), 'tests', '.artifacts', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * Фиксирует язык интерфейса до загрузки приложения.
 *
 * docs/ui-design.md §11: язык интерфейса хранится в localStorage['generaptor.locale']
 * и по умолчанию берётся из navigator.language — без фиксации тест зависит
 * от локали браузера машины.
 */
export async function setUiLocale(page: Page, locale: 'ru' | 'en' = 'ru') {
  await page.addInitScript((value: string) => {
    window.localStorage.setItem('generaptor.locale', value);
  }, locale);
}

/**
 * Navigate to the app and wait for the shell to render.
 *
 * M6 (docs/ui-design.md §4): the shell is the top bar with three tabs. The app may
 * still be behind the session gate (docs/ui-design.md §6) — then the hint screen
 * is the marker that the app booted (the mandatory token input is gone from the main path).
 */
export async function awaitShell(page: Page) {
  await page.goto('/');
  await page
    .waitForSelector('.app-topbar, [data-testid="session-hint"]', { timeout: 15_000 })
    .catch(async () => {
      // Fallback: the shell mounted in some other shape.
      await page.waitForSelector('nav, main', { timeout: 5_000 });
    });
}

/**
 * Navigate to a tab by clicking its top-bar tab.
 * M6: tabs are role="tab" buttons inside the nav[role="tablist"].
 */
export async function gotoTab(page: Page, label: string) {
  await page.click(`[role="tab"]:has-text("${label}")`, { timeout: 8_000 });
}

/**
 * Capture a full-page screenshot into tests/.artifacts/screenshots/.
 */
export async function shoot(page: Page, name: string) {
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

/**
 * Assert a substring is visible on the page.
 */
export async function expectVisible(page: Page, text: string) {
  await expect(page.locator(`body`)).toContainText(text, { timeout: 5_000 });
}
