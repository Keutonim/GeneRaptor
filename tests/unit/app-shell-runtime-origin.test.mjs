// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:8806/" }
/**
 * FIX-02 — строка сервера в верхней панели показывает РЕАЛЬНЫЙ origin.
 *
 * Панель раньше рендерила зашитый `сервер 127.0.0.1:8787` даже когда
 * приложение реально работало на другом порту (QA-1 видел :8806/:8807, а в
 * панели было :8787). Показывать неверный адрес хуже, чем не показывать
 * никакого: браузер знает, откуда отдан UI, — панель читает origin из
 * `window.location` (тот же источник, что и URL WebSocket).
 *
 * Тест поднимает jsdom на НЕСТАНДАРТНОМ origin (127.0.0.1:8806) — так видно,
 * что в панели попадает адрес, на котором реально открыт UI, а не константа.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { AppShell } from '../../src/app/AppShell';
import { I18nProvider } from '../../src/i18n';
import { ThemeProvider } from '../../src/theme';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: 'ru' },
        React.createElement(
          ThemeProvider,
          { initialMode: 'light' },
          React.createElement(
            AppShell,
            {
              activeTab: 'generation',
              onTabChange: () => {},
              children: React.createElement('div', null, 'content'),
            },
          ),
        ),
      ),
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('AppShell — реальный origin вместо зашитого адреса', () => {
  let harness;

  beforeEach(() => {
    harness = mount();
  });

  afterEach(() => {
    harness.unmount();
  });

  it('показывает host:port, на котором реально открыт UI', () => {
    const server = harness.container.querySelector('.app-server-line');
    expect(server.textContent).toContain('127.0.0.1:8806');
    expect(server.textContent).not.toContain('127.0.0.1:8787');
  });

  it('берёт адрес из window.location.host', () => {
    const server = harness.container.querySelector('.app-server-line');
    expect(server.textContent).toContain(window.location.host);
  });

  it('не оставляет плейсхолдер origin в строке', () => {
    const server = harness.container.querySelector('.app-server-line');
    expect(server.textContent).not.toContain('{origin}');
  });
});
