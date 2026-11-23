/**
 * M7 — i18n runtime for the UI shell.
 *
 * Contract:
 *   - the UI locale is persisted in localStorage['generaptor.locale'];
 *   - the default locale comes from navigator.language;
 *   - switching the locale must not disturb the work in progress (the
 *     provider only re-renders; no data is refetched);
 *   - the article material language is a CONTENT choice (D6) and is never
 *     changed by the UI locale.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  dictionaries,
  LOCALES,
  LOCALE_STORAGE_KEY,
  type Locale,
  type TranslationParams,
} from './dictionary';
import { interpolate, translate } from './translate';
import { setRuntimeLocale } from './runtime';

export type { Locale, TranslationParams };
export { LOCALE_STORAGE_KEY, LOCALES, DEFAULT_LOCALE, dictionaries };
export { interpolate, translate };
export { getRuntimeLocale, setRuntimeLocale, tr } from './runtime';

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** Locale from localStorage, then navigator.language, then the default. */
export function detectLocale(storage: Storage | undefined = safeStorage()): Locale {
  const stored = storage?.getItem(LOCALE_STORAGE_KEY);
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  const browserLocale = typeof navigator !== 'undefined' ? navigator.language : '';
  const base = browserLocale.split('-')[0];
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : DEFAULT_LOCALE;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export interface I18nProviderProps {
  children: React.ReactNode;
  /** Test/host override — skips localStorage + navigator detection. */
  initialLocale?: Locale;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({ children, initialLocale }) => {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? detectLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      safeStorage()?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Private mode / disabled storage — the UI still switches.
    }
  }, []);

  // Keep the non-React modules and the document in sync with the UI locale.
  useEffect(() => {
    setRuntimeLocale(locale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const t = useCallback(
    (key: string, params?: TranslationParams) => translate(locale, key, params),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used inside <I18nProvider>');
  }
  return value;
}
