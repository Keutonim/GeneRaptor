/**
 * FIX-08 / FIX-09: the UI truth table behind every boot banner.
 *
 * The API server mounts the built SPA from dist/ (server/express-app.mjs), so
 * the API root serves the UI exactly when the build output exists — even in
 * --api-only mode. Without dist/ the API root answers 404 on GET / and the
 * UI lives in the Vite dev server instead.
 *
 * Both the launcher (start.mjs) and the standalone server (server/index.mjs)
 * must read that truth from ONE helper, otherwise the two banners drift apart
 * again (they did: the launcher said "Frontend: disabled" while the server
 * happily served the SPA at the very same address).
 *
 * The modes (the brief asks for them to be explicit):
 *
 *   api-root                — dist/ exists, the API server serves the SPA at
 *                             the API root (packaged build, --api-only too)
 *   dev-server              — the Vite dev server is running, the UI is there
 *   dev-server-not-started  — no dist/, Vite available: the UI will be at the
 *                             dev server address once it is started
 *   none                    — no dist/ and no Vite: there is no UI at all
 */
import { describe, expect, it } from 'vitest';

import {
  resolveUiAvailability,
  formatTokenBanner,
} from '../../server/lib/launcher-args.mjs';

const API_URL = 'http://127.0.0.1:8787';
const DEV_URL = 'http://127.0.0.1:5173';

describe('resolveUiAvailability', () => {
  it('serves the UI from the API root when dist/ exists (packaged build)', () => {
    const ui = resolveUiAvailability({
      hasDist: true,
      viteAvailable: true,
      apiUrl: API_URL,
      devUiUrl: DEV_URL,
    });
    expect(ui.mode).toBe('api-root');
    expect(ui.uiUrl).toBe(API_URL);
    expect(ui.pasteUrl).toBe(API_URL);
    expect(ui.uiServed).toBe(true);
    expect(ui.note).toMatch(/dist\//);
  });

  it('keeps the API root as the UI address even when the dev server is available', () => {
    // A packaged install may still ship node_modules; the presence of Vite
    // must not move the UI away from the address the API really serves.
    const ui = resolveUiAvailability({
      hasDist: true,
      viteAvailable: true,
      devServerRunning: false,
      apiUrl: API_URL,
      devUiUrl: DEV_URL,
    });
    expect(ui.mode).toBe('api-root');
    expect(ui.pasteUrl).toBe(API_URL);
  });

  it('never advertises the API root when there is no dist/ build', () => {
    const ui = resolveUiAvailability({
      hasDist: false,
      viteAvailable: true,
      apiUrl: API_URL,
      devUiUrl: DEV_URL,
    });
    expect(ui.mode).toBe('dev-server-not-started');
    expect(ui.pasteUrl).not.toBe(API_URL);
    expect(ui.pasteUrl).toBe(DEV_URL);
    expect(ui.uiServed).toBe(true);
    expect(ui.note).toMatch(/npm run dev/);
    expect(ui.note).toMatch(/not built|no dist\//i);
  });

  it('uses the dev server address when the dev server is already running', () => {
    const ui = resolveUiAvailability({
      hasDist: false,
      viteAvailable: true,
      devServerRunning: true,
      apiUrl: API_URL,
      devUiUrl: DEV_URL,
    });
    expect(ui.mode).toBe('dev-server');
    expect(ui.pasteUrl).toBe(DEV_URL);
    expect(ui.uiServed).toBe(true);
  });

  it('has no UI address at all when neither dist/ nor Vite is available', () => {
    const ui = resolveUiAvailability({
      hasDist: false,
      viteAvailable: false,
      apiUrl: API_URL,
    });
    expect(ui.mode).toBe('none');
    expect(ui.pasteUrl).toBeNull();
    expect(ui.uiServed).toBe(false);
    expect(ui.note).toMatch(/npm run build/);
  });

  it('degrades to "none" when the dev server address is unknown', () => {
    const ui = resolveUiAvailability({
      hasDist: false,
      viteAvailable: true,
      apiUrl: API_URL,
      devUiUrl: '',
    });
    expect(ui.mode).toBe('none');
    expect(ui.pasteUrl).toBeNull();
  });
});

describe('the token banner never points at an address that cannot work', () => {
  it('advertises the API root when the API root serves the SPA', () => {
    const ui = resolveUiAvailability({
      hasDist: true,
      viteAvailable: true,
      apiUrl: API_URL,
      devUiUrl: DEV_URL,
    });
    const banner = formatTokenBanner({
      token: 'dummy',
      url: ui.pasteUrl,
      uiServed: ui.uiServed,
      note: ui.note,
    });
    expect(banner).toMatch(
      /\[Auth\] Paste this token at http:\/\/127\.0\.0\.1:8787 to unlock the app\./
    );
  });

  it('names the dev server instead of the 404 API root when nothing is built', () => {
    const ui = resolveUiAvailability({
      hasDist: false,
      viteAvailable: true,
      apiUrl: API_URL,
      devUiUrl: DEV_URL,
    });
    const banner = formatTokenBanner({
      token: 'dummy',
      url: ui.pasteUrl,
      uiServed: ui.uiServed,
      note: ui.note,
    });
    expect(banner).not.toMatch(/Paste this token at http:\/\/127\.0\.0\.1:8787/);
    expect(banner).toMatch(/Paste this token at http:\/\/127\.0\.0\.1:5173/);
    expect(banner).toMatch(/npm run dev/);
  });

  it('says that no UI is served when the package has no build and no Vite', () => {
    const ui = resolveUiAvailability({
      hasDist: false,
      viteAvailable: false,
      apiUrl: API_URL,
    });
    const banner = formatTokenBanner({
      token: 'dummy',
      url: API_URL,
      uiServed: ui.uiServed,
      note: ui.note,
    });
    expect(banner).not.toMatch(/Paste this token at http/);
    expect(banner).toMatch(/unlock screen/i);
    expect(banner).toMatch(/npm run build/);
  });
});
