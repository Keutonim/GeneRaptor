/**
 * M7 — translation primitives.
 *
 * Kept separate from the React provider so that plain modules (API layer,
 * hooks, helpers) can translate a message without pulling React in.
 */
import {
  DEFAULT_LOCALE,
  dictionaries,
  type DictionaryValue,
  type Locale,
  type PluralCategory,
  type PluralForms,
  type TranslationParams,
} from './dictionary';

export type { TranslationParams };

/** Substitute `{name}` placeholders; unknown placeholders stay untouched. */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function rulesFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

/** Plural category of `count` for the given locale (RU: one / few / many). */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return rulesFor(locale).select(count) as PluralCategory;
}

/**
 * Translate `key` for `locale`.
 *
 * Fallback chain: requested locale → default locale → the key itself.
 * Plural entries resolve the category of `params.count`; without a count the
 * `other` form is used.
 */
export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  const value: DictionaryValue | undefined =
    dictionaries[locale]?.[key] ?? dictionaries[DEFAULT_LOCALE]?.[key];
  if (value === undefined) return key;
  if (typeof value === 'string') return interpolate(value, params);

  const forms = value as PluralForms;
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const category: PluralCategory = count === undefined ? 'other' : pluralCategory(locale, count);
  const template = forms[category] ?? forms.other;
  return interpolate(template, params);
}
