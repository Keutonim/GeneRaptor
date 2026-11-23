// @vitest-environment jsdom
/**
 * M7 — theme runtime (docs/ui-design.md §11).
 *
 * Contract:
 *   - three modes (light / auto / dark) persisted in localStorage;
 *   - `data-theme="light|dark"` on <html> for explicit modes, attribute
 *     removed for `auto` (the stylesheet then follows prefers-color-scheme);
 *   - an inline bootstrap in index.html applies the stored mode BEFORE the
 *     first paint — no flash of the wrong theme (no FOUC);
 *   - the UI locale is persisted the same way and mirrored onto <html lang>.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { I18nProvider, useI18n } from '../../src/i18n';
import { ThemeProvider, useTheme } from '../../src/theme';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The repo root is the vitest cwd (same pattern as tests/unit/generaptor-schema.test.mjs).
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

let themeApi = null;
let i18nApi = null;

function ThemeProbe() {
  themeApi = useTheme();
  return null;
}

function LocaleProbe() {
  i18nApi = useI18n();
  return null;
}

function mountTheme(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ThemeProvider, props, React.createElement(ThemeProbe)));
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function mountLocale(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(I18nProvider, props, React.createElement(LocaleProbe)));
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('M7 — theme bootstrap in index.html', () => {
  it('applies the stored theme and locale before the app script runs', () => {
    const inlineScripts = [...INDEX_HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1],
    );
    const bootstrap = inlineScripts.find((code) => code.includes('generaptor.theme'));
    expect(bootstrap, 'inline bootstrap script with the theme key').toBeTruthy();
    expect(bootstrap).toContain('data-theme');
    expect(bootstrap).toContain('generaptor.locale');
    expect(bootstrap).toContain('lang');
  });

  it('runs the bootstrap before the module script (no FOUC)', () => {
    const bootstrapIndex = INDEX_HTML.indexOf('generaptor.theme');
    const moduleIndex = INDEX_HTML.indexOf('/src/main.tsx');
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeLessThan(moduleIndex);
  });
});

describe('M7 — theme persistence', () => {
  let harness = null;

  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    if (harness) harness.unmount();
    harness = null;
    delete document.documentElement.dataset.theme;
    window.localStorage.clear();
  });

  it('persists the selected mode and sets data-theme', () => {
    harness = mountTheme();
    act(() => themeApi.setMode('dark'));
    expect(window.localStorage.getItem('generaptor.theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('removes the attribute for the auto mode', () => {
    harness = mountTheme();
    act(() => themeApi.setMode('dark'));
    act(() => themeApi.setMode('auto'));
    expect(window.localStorage.getItem('generaptor.theme')).toBe('auto');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('restores the persisted mode on the next mount (reload)', () => {
    harness = mountTheme();
    act(() => themeApi.setMode('dark'));
    harness.unmount();
    harness = mountTheme();
    expect(themeApi.mode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('M7 — locale persistence', () => {
  let harness = null;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    if (harness) harness.unmount();
    harness = null;
    window.localStorage.clear();
  });

  it('persists the selected locale and mirrors it onto <html lang>', () => {
    harness = mountLocale();
    act(() => i18nApi.setLocale('en'));
    expect(window.localStorage.getItem('generaptor.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('restores the persisted locale on the next mount (reload)', () => {
    harness = mountLocale();
    act(() => i18nApi.setLocale('en'));
    harness.unmount();
    harness = mountLocale();
    expect(i18nApi.locale).toBe('en');
  });
});
