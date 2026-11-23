/**
 * M7 — dictionary contract (docs/ui-design.md §11).
 *
 * The UI locale is data, not code: every visible string must exist in BOTH
 * language tables with the same key set, and the runtime must resolve
 * placeholders and RU plural forms.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, dictionaries } from '../../src/i18n/dictionary';
import { interpolate, translate } from '../../src/i18n';

const keySet = (locale) => Object.keys(dictionaries[locale]).sort();
const isPlural = (value) => typeof value === 'object' && value !== null;

describe('M7 — dictionary parity', () => {
  it('ships both locales', () => {
    expect([...LOCALES].sort()).toEqual(['en', 'ru']);
    expect(DEFAULT_LOCALE).toBe('ru');
  });

  it('has identical key sets in RU and EN', () => {
    const ru = keySet('ru');
    const en = keySet('en');
    expect(en.filter((key) => !ru.includes(key))).toEqual([]);
    expect(ru.filter((key) => !en.includes(key))).toEqual([]);
    expect(ru.length).toBe(en.length);
  });

  it('has at least 40 strings per language', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(dictionaries[locale]).length).toBeGreaterThanOrEqual(40);
    }
  });

  it('has no empty values', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        if (isPlural(value)) {
          expect(typeof value.other, `${locale}.${key}.other`).toBe('string');
          expect(value.other.trim().length, `${locale}.${key}.other`).toBeGreaterThan(0);
        } else {
          expect(typeof value, `${locale}.${key}`).toBe('string');
          expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps the RU and EN plural entries in sync', () => {
    const pluralKeys = (locale) =>
      Object.keys(dictionaries[locale]).filter((key) => isPlural(dictionaries[locale][key]));
    expect(pluralKeys('ru')).toEqual(pluralKeys('en'));
  });
});

describe('M7 — translate()', () => {
  it('resolves a key in the requested locale', () => {
    expect(translate('en', 'nav.generation')).toBe('Generation');
    expect(translate('ru', 'nav.generation')).toBe('Генерация');
  });

  it('falls back to the default locale, then to the key itself', () => {
    expect(translate('en', 'definitely.missing.key')).toBe('definitely.missing.key');
  });

  it('interpolates {placeholders}', () => {
    expect(translate('en', 'run.stage', { current: 2, total: 4 })).toBe('Stage 2 of 4');
    expect(translate('ru', 'run.stage', { current: 2, total: 4 })).toBe('Этап 2 из 4');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolate('a {known} b {unknown}', { known: 'X' })).toBe('a X b {unknown}');
  });

  it('selects the RU plural form via Intl.PluralRules', () => {
    expect(translate('ru', 'article.words', { count: 1 })).toBe('1 слово');
    expect(translate('ru', 'article.words', { count: 2 })).toBe('2 слова');
    expect(translate('ru', 'article.words', { count: 5 })).toBe('5 слов');
    expect(translate('ru', 'article.words', { count: 11 })).toBe('11 слов');
    expect(translate('ru', 'article.stages', { count: 3 })).toBe('3 этапа');
    expect(translate('ru', 'article.stages', { count: 7 })).toBe('7 этапов');
  });

  it('selects the EN plural form via Intl.PluralRules', () => {
    expect(translate('en', 'article.words', { count: 1 })).toBe('1 word');
    expect(translate('en', 'article.words', { count: 5 })).toBe('5 words');
  });

  it('falls back to the "other" form when no count is given', () => {
    // No count -> the "other" template; the {count} placeholder stays untouched
    // (same contract as interpolate() with an unknown placeholder).
    expect(translate('en', 'article.words', {})).toBe('{count} words');
    expect(translate('ru', 'article.words', {})).toBe('{count} слова');
    expect(translate('en', 'article.stages', {})).toBe('{count} stages');
  });
});
