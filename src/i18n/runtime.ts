/**
 * M7 — runtime locale for non-React modules.
 *
 * The API layer and the helpers run outside the React tree, but their error
 * messages are still user-visible copy. They read the active locale from this
 * module-level registry, which `<I18nProvider>` keeps in sync.
 */
import { DEFAULT_LOCALE, type Locale, type TranslationParams } from './dictionary';
import { translate } from './translate';

let runtimeLocale: Locale = DEFAULT_LOCALE;

/** Called by `<I18nProvider>` whenever the UI locale changes. */
export function setRuntimeLocale(locale: Locale): void {
  runtimeLocale = locale;
}

export function getRuntimeLocale(): Locale {
  return runtimeLocale;
}

/** Translate a key with the active UI locale. */
export function tr(key: string, params?: TranslationParams): string {
  return translate(runtimeLocale, key, params);
}
