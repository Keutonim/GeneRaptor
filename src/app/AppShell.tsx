/**
 * M6 — оболочка приложения.
 *
 * Контракт:
 *   - ровно три вкладки: Генерация / История / Настройки (без боковой панели);
 *   - верхняя панель: слово-знак слева, вкладки рядом, язык RU|EN и тема
 *     (светлая / как в системе / тёмная) справа, моноширинная строка сервера;
 *   - переключение языка и темы не сбрасывает работу: провайдеры только
 *     перерисовывают дерево, данные не перезапрашиваются.
 */
import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n, type Locale } from '../i18n';
import { useTheme, type ThemeMode } from '../theme';

export type AppTab = 'generation' | 'history' | 'settings';

const TABS: ReadonlyArray<{ id: AppTab; labelKey: string }> = [
  { id: 'generation', labelKey: 'nav.generation' },
  { id: 'history', labelKey: 'nav.history' },
  { id: 'settings', labelKey: 'nav.settings' },
];

const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: 'ru', label: 'RU' },
  { id: 'en', label: 'EN' },
];

const THEME_MODES: ReadonlyArray<{ id: ThemeMode; labelKey: string; Icon: typeof Sun }> = [
  { id: 'light', labelKey: 'topbar.theme.light', Icon: Sun },
  { id: 'auto', labelKey: 'topbar.theme.auto', Icon: Monitor },
  { id: 'dark', labelKey: 'topbar.theme.dark', Icon: Moon },
];

export interface AppShellProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  children: React.ReactNode;
}

/**
 * The address of the server that REALLY serves this UI (`host:port`).
 *
 * The top bar used to render a hardcoded `127.0.0.1:8787` — a lie whenever the
 * app ran on another port (dev: the Vite port; prod: the API port). QA-1 saw
 * the bar claim :8787 while the app was served from :8806/:8807. A wrong
 * address is worse than none, so the bar reads the origin the browser is
 * actually on — the same source the WebSocket URL uses
 * (src/hooks/useWebSocketProgress.ts).
 *
 * @returns {string} `host:port`, or '' when there is no browser location.
 */
export function getRuntimeOrigin(): string {
  if (typeof window === 'undefined' || !window.location) return '';
  return String(window.location.host || '').trim();
}

export const AppShell: React.FC<AppShellProps> = ({ activeTab, onTabChange, children }) => {
  const { locale, setLocale, t } = useI18n();
  const { mode, setMode } = useTheme();
  // Outside a browser there is no origin to show — the label stays, the
  // (possibly wrong) address disappears instead of being hardcoded.
  const serverLabel = t('topbar.server', { origin: getRuntimeOrigin() }).trim();

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <button
          type="button"
          className="app-wordmark"
          onClick={() => onTabChange('generation')}
          aria-label="GeneRaptor"
        >
          <span className="app-wordmark__glyph" aria-hidden="true" />
          GeneRaptor
        </button>

        <nav className="app-tabs" role="tablist" aria-label={t('nav.label')}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="app-tab"
              aria-selected={activeTab === tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </nav>

        <div className="app-topbar__tools">
          <div className="segmented" role="radiogroup" aria-label={t('topbar.language.label')}>
            {LOCALES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                className="segmented__option"
                aria-checked={locale === item.id}
                onClick={() => setLocale(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="segmented" role="radiogroup" aria-label={t('topbar.theme.label')}>
            {THEME_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                className="segmented__option"
                aria-label={t(item.labelKey)}
                aria-checked={mode === item.id}
                onClick={() => setMode(item.id)}
              >
                <item.Icon size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
            ))}
          </div>

          <span className="app-server-line">{serverLabel}</span>
        </div>
      </header>

      <main className="app-page" role="main">
        <div className="app-page__inner">{children}</div>
      </main>
    </div>
  );
};
