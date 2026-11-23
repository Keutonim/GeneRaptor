/**
 * M6 — theme runtime (3 states: light / auto / dark).
 *
 * Contract:
 *   - the mode is persisted in localStorage['generaptor.theme'];
 *   - `data-theme="light|dark"` is set on <html> for explicit modes;
 *   - `auto` omits the attribute — the stylesheet then follows
 *     `prefers-color-scheme` through a media query.
 *
 * SCOPE NOTE: M7 owns the final palette; M6 ships the tokens + the switch
 * so that the top bar behaviour contract exists and is verifiable.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'auto';

export const THEME_STORAGE_KEY = 'generaptor.theme';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'auto', 'dark'];

export interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Effective palette for `auto` — resolved from the OS preference. */
  resolved: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function detectThemeMode(storage: Storage | undefined = safeStorage()): ThemeMode {
  const stored = storage?.getItem(THEME_STORAGE_KEY);
  if (stored && (THEME_MODES as readonly string[]).includes(stored)) return stored as ThemeMode;
  return 'auto';
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Write the mode onto <html>: explicit modes set the attribute, auto removes it. */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (mode === 'auto') {
    delete root.dataset.theme;
    return;
  }
  root.dataset.theme = mode;
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Test/host override — skips localStorage detection. */
  initialMode?: ThemeMode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children, initialMode }) => {
  const [mode, setModeState] = useState<ThemeMode>(() => initialMode ?? detectThemeMode());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    initialMode === 'dark' ? 'dark' : initialMode === 'light' ? 'light' : systemPrefersDark() ? 'dark' : 'light',
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      safeStorage()?.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage disabled — the switch still works for this session.
    }
  }, []);

  useEffect(() => {
    applyThemeMode(mode);
    if (mode !== 'auto') {
      setResolved(mode);
      return;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setResolved(query.matches ? 'dark' : 'light');
    sync();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', sync);
      return () => query.removeEventListener('change', sync);
    }
    return undefined;
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode, resolved }), [mode, setMode, resolved]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return value;
}
