/**
 * S1b — словарь поисковых вертикалей и честная подсказка про Serper.
 *
 * Контракт под тестом:
 *   - восемь keyless-вертикалей имеют название и короткое описание в RU и EN
 *     (ключи searchSources.backend.<id> и searchSources.backend.<id>.description);
 *   - подписи вертикального списка («без ключа», «по теме», авто-пояснение)
 *     присутствуют в обеих локалях;
 *   - честная подсказка searchSources.serperHint называет Serper основным движком,
 *     переменную окружения GENERAPTOR_SERPER_API_KEY и бесплатную цепочку
 *     (keyless Tavily → Wikipedia → Wikidata);
 *   - английские строки — только латиницей (кириллица запрещена вне RU-таблицы);
 *   - набор новых ключей RU/EN совпадает 1:1.
 */
import { describe, it, expect } from 'vitest';
import { dictionaries } from '../../src/i18n/dictionary';
import { translate } from '../../src/i18n';

const VERTICAL_IDS = [
  'openalex',
  'crossref',
  'europepmc',
  'gdelt',
  'nominatim',
  'openlibrary',
  'stackexchange',
  'hn',
];

const VERTICAL_NAMES = {
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  europepmc: 'Europe PMC',
  gdelt: 'GDELT',
  nominatim: 'Nominatim (OpenStreetMap)',
  openlibrary: 'OpenLibrary',
  stackexchange: 'Stack Exchange',
  hn: 'Hacker News',
};

const CYRILLIC = /[\u0400-\u04FF\u0500-\u052F]/;

const nameKey = (id) => `searchSources.backend.${id}`;
const descKey = (id) => `searchSources.backend.${id}.description`;

const VERTICAL_UI_KEYS = [
  'searchSources.verticals.title',
  'searchSources.verticals.caption',
  'searchSources.vertical.keyless',
  'searchSources.vertical.byTopic',
  'searchSources.vertical.auto',
];

const newKeys = [
  ...VERTICAL_IDS.map(nameKey),
  ...VERTICAL_IDS.map(descKey),
  ...VERTICAL_UI_KEYS,
  'searchSources.serperHint',
];

describe('S1b — названия и описания восьми вертикалей', () => {
  it('название каждой вертикали есть в RU и EN и совпадает с ожидаемым', () => {
    for (const id of VERTICAL_IDS) {
      expect(dictionaries.ru[nameKey(id)], `ru.${nameKey(id)}`).toBe(VERTICAL_NAMES[id]);
      expect(dictionaries.en[nameKey(id)], `en.${nameKey(id)}`).toBe(VERTICAL_NAMES[id]);
    }
  });

  it('описание каждой вертикали есть в RU и EN, непустое и короткое', () => {
    for (const id of VERTICAL_IDS) {
      for (const locale of ['ru', 'en']) {
        const value = dictionaries[locale][descKey(id)];
        expect(typeof value, `${locale}.${descKey(id)}`).toBe('string');
        expect(value.trim().length, `${locale}.${descKey(id)}`).toBeGreaterThan(0);
        // Коротко, без длинных текстов (ограничение ТЗ).
        expect(value.length, `${locale}.${descKey(id)} length`).toBeLessThanOrEqual(90);
      }
    }
  });

  it('подписи вертикального списка присутствуют в обеих локалях', () => {
    for (const key of VERTICAL_UI_KEYS) {
      expect(typeof dictionaries.ru[key], `ru.${key}`).toBe('string');
      expect(typeof dictionaries.en[key], `en.${key}`).toBe('string');
      expect(dictionaries.ru[key].trim().length).toBeGreaterThan(0);
      expect(dictionaries.en[key].trim().length).toBeGreaterThan(0);
    }
    expect(translate('ru', 'searchSources.vertical.keyless')).toBe('без ключа');
    expect(translate('en', 'searchSources.vertical.keyless')).toBe('keyless');
    expect(translate('ru', 'searchSources.vertical.byTopic')).toBe('по теме');
    expect(translate('en', 'searchSources.vertical.byTopic')).toBe('by topic');
  });
});

describe('S1b — честная подсказка про Serper и бесплатную цепочку', () => {
  it('подсказка есть в RU и EN и называет переменную окружения ключа', () => {
    for (const locale of ['ru', 'en']) {
      const hint = dictionaries[locale]['searchSources.serperHint'];
      expect(typeof hint, `${locale}.serperHint`).toBe('string');
      expect(hint).toContain('GENERAPTOR_SERPER_API_KEY');
      expect(hint).toContain('Serper');
    }
  });

  it('подсказка честно описывает основной движок и бесплатную цепочку', () => {
    const ru = dictionaries.ru['searchSources.serperHint'];
    expect(ru).toContain('Основной движок');
    expect(ru).toContain('Tavily без ключа');
    expect(ru).toContain('Википедия');
    expect(ru).toContain('Викиданные');

    const en = dictionaries.en['searchSources.serperHint'];
    expect(en).toContain('main engine');
    expect(en).toContain('keyless Tavily');
    expect(en).toContain('Wikipedia');
    expect(en).toContain('Wikidata');
  });
});

describe('S1b — локальная чистота и паритет новых ключей', () => {
  it('английские строки новых ключей — только латиницей', () => {
    for (const key of newKeys) {
      const value = dictionaries.en[key];
      expect(typeof value, `en.${key}`).toBe('string');
      expect(CYRILLIC.test(value), `en.${key} has Cyrillic`).toBe(false);
    }
  });

  it('набор новых ключей RU/EN совпадает 1:1', () => {
    for (const key of newKeys) {
      expect(key in dictionaries.ru, `ru missing ${key}`).toBe(true);
      expect(key in dictionaries.en, `en missing ${key}`).toBe(true);
    }
    const ruNew = Object.keys(dictionaries.ru).filter((k) => newKeys.includes(k)).sort();
    const enNew = Object.keys(dictionaries.en).filter((k) => newKeys.includes(k)).sort();
    expect(ruNew).toEqual(enNew);
  });
});