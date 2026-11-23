/**
 * P1d (2026-09-18): UTM-билдер для internal-ссылок линкера.
 *
 * Чистые функции server/lib/utm-builder.mjs (без БД/воркера):
 *  - isUtmEnabled(env) — GENERAPTOR_UTM_ENABLED truthy-парсер (по умолчанию ВЫКЛ);
 *  - buildUrlWithUtm(url, { enabled, campaign }) — добавляет utm_source=generaptor
 *    и utm_medium=article (+ utm_campaign при непустом campaign), сохраняет
 *    существующий query, идемпотентна (без дублей при повторных прогонах),
 *    битый/не-URL вход → вернуть как есть (безопасная деградация);
 *  - pageUrlsWithUtmVariants(urls, opts) — RAW + UTM-формы для постчек-контекста
 *    специалист-ссылок (правила LINKS-* сравнивают URL точно, без среза query:
 *    подпись автора несёт RAW pageUrl, линкер — UTM-форму; постчек обязан
 *    узнать обе).
 */
import { describe, it, expect } from 'vitest';
import {
  buildUrlWithUtm,
  isUtmEnabled,
  pageUrlsWithUtmVariants,
  UTM_SOURCE_DEFAULT,
  UTM_MEDIUM_DEFAULT,
} from '../../server/lib/utm-builder.mjs';

describe('isUtmEnabled — GENERAPTOR_UTM_ENABLED truthy-парсер', () => {
  it('не задан / undefined / null → false (дефолт ВЫКЛ: безопасный деплой)', () => {
    expect(isUtmEnabled({})).toBe(false);
    expect(isUtmEnabled({ GENERAPTOR_UTM_ENABLED: undefined })).toBe(false);
    expect(isUtmEnabled({ GENERAPTOR_UTM_ENABLED: null })).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'on', 'yes', 'Yes '])('truthy-значение %j → true', (value) => {
    expect(isUtmEnabled({ GENERAPTOR_UTM_ENABLED: value })).toBe(true);
  });

  it.each(['', '  ', '0', 'false', 'FALSE', 'no', 'off'])('falsy-значение %j → false', (value) => {
    expect(isUtmEnabled({ GENERAPTOR_UTM_ENABLED: value })).toBe(false);
  });
});

describe('buildUrlWithUtm — чистая сборка URL', () => {
  const ON = { enabled: true, campaign: 'art-123' };

  it('plain path → ?utm_source=generaptor&utm_medium=article&utm_campaign=art-123', () => {
    expect(buildUrlWithUtm('https://acme.example/uslugi/mezoterapiya', ON)).toBe(
      'https://acme.example/uslugi/mezoterapiya?utm_source=generaptor&utm_medium=article&utm_campaign=art-123'
    );
  });

  it('существующий query сохраняется: ?a=1&b=2 → исходные параметры ДО UTM', () => {
    expect(buildUrlWithUtm('https://acme.example/p?a=1&b=2', ON)).toBe(
      'https://acme.example/p?a=1&b=2&utm_source=generaptor&utm_medium=article&utm_campaign=art-123'
    );
  });

  it('фрагмент #hash остаётся в конце, UTM — до него', () => {
    expect(buildUrlWithUtm('https://acme.example/p#section', ON)).toBe(
      'https://acme.example/p?utm_source=generaptor&utm_medium=article&utm_campaign=art-123#section'
    );
  });

  it('дефолты utm_source/utm_medium фиксированы контрактом', () => {
    expect(UTM_SOURCE_DEFAULT).toBe('generaptor');
    expect(UTM_MEDIUM_DEFAULT).toBe('article');
    const url = new URL(buildUrlWithUtm('https://x.example/p', ON));
    expect(url.searchParams.get('utm_source')).toBe('generaptor');
    expect(url.searchParams.get('utm_medium')).toBe('article');
    expect(url.searchParams.get('utm_campaign')).toBe('art-123');
  });

  it('enabled:false → исходная строка возвращается БЕЗ изменений (тот же экземпляр)', () => {
    const url = 'https://acme.example/p?a=1';
    expect(buildUrlWithUtm(url, { enabled: false, campaign: 'art-123' })).toBe(url);
    expect(buildUrlWithUtm(url, {})).toBe(url);
    expect(buildUrlWithUtm(url)).toBe(url);
  });

  it('campaign пустой → utm_campaign НЕ добавляется (source/medium остаются)', () => {
    expect(buildUrlWithUtm('https://acme.example/p', { enabled: true, campaign: '' })).toBe(
      'https://acme.example/p?utm_source=generaptor&utm_medium=article'
    );
    expect(buildUrlWithUtm('https://acme.example/p', { enabled: true })).toBe(
      'https://acme.example/p?utm_source=generaptor&utm_medium=article'
    );
  });

  it('идемпотентность: повторный вызов не дублирует параметры (стабильный результат)', () => {
    const once = buildUrlWithUtm('https://acme.example/p?a=1', ON);
    const twice = buildUrlWithUtm(once, ON);
    expect(twice).toBe(once);
    expect(twice.match(/utm_source/g)).toHaveLength(1);
    expect(twice.match(/utm_medium/g)).toHaveLength(1);
    expect(twice.match(/utm_campaign/g)).toHaveLength(1);
  });

  it('чужие ut_-параметры не трогаем; свои перезаписываем актуальными значениями', () => {
    const stale = 'https://acme.example/p?utm_term=keep&old=1&utm_campaign=obsolete';
    const fresh = buildUrlWithUtm(stale, ON);
    expect(fresh).toContain('utm_term=keep');
    expect(fresh).toContain('old=1');
    expect(fresh).toContain('utm_campaign=art-123');
    expect(fresh.match(/utm_campaign/g)).toHaveLength(1);
  });

  it('битый/не-URL/пустой вход → возвращается как есть (безопасная деградация)', () => {
    expect(buildUrlWithUtm('not a url at all', ON)).toBe('not a url at all');
    expect(buildUrlWithUtm('', ON)).toBe('');
    expect(buildUrlWithUtm(null, ON)).toBe(null);
    expect(buildUrlWithUtm(undefined, ON)).toBe(undefined);
    // Относительная ссылка (без схемы) — URL-API не парсит без base: не меняем.
    expect(buildUrlWithUtm('/relative/path', ON)).toBe('/relative/path');
  });

  it('кириллический путь корректно кодируется и остаётся рабочим URL', () => {
    const out = buildUrlWithUtm('https://acme.example/услуги', ON);
    const parsed = new URL(out);
    expect(parsed.searchParams.get('utm_source')).toBe('generaptor');
    expect(parsed.pathname).toBe(encodeURI('/услуги'));
  });
});

describe('pageUrlsWithUtmVariants — RAW+UTM формы для постчек-контекста', () => {
  const URLS = [
    'https://acme.example/doctors/ivanova',
    'https://acme.example/doctors/petrov',
  ];

  it('enabled:false → тот же список (RAW только, порядок стабилен)', () => {
    expect(pageUrlsWithUtmVariants(URLS, { enabled: false, campaign: 'a1' })).toEqual(URLS);
    expect(pageUrlsWithUtmVariants(URLS, {})).toEqual(URLS);
  });

  it('enabled:true → RAW + UTM-формы, без дублей, RAW первыми', () => {
    const out = pageUrlsWithUtmVariants(URLS, { enabled: true, campaign: 'a1' });
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('https://acme.example/doctors/ivanova');
    expect(out[2]).toBe('https://acme.example/doctors/petrov');
    expect(out).toContain('https://acme.example/doctors/ivanova?utm_source=generaptor&utm_medium=article&utm_campaign=a1');
    expect(out).toContain('https://acme.example/doctors/petrov?utm_source=generaptor&utm_medium=article&utm_campaign=a1');
    // Идемпотентность на уровне списка: повторный прогон по уже dual-списку
    // (RAW + UTM-формы) не добавляет ни одного нового элемента.
    expect(pageUrlsWithUtmVariants(out, { enabled: true, campaign: 'a1' })).toEqual(out);
  });

  it('мусорные входы отфильтровываются молча (паритет с .filter(Boolean) воркера)', () => {
    expect(pageUrlsWithUtmVariants(null, { enabled: true })).toEqual([]);
    expect(pageUrlsWithUtmVariants(undefined, {})).toEqual([]);
    expect(pageUrlsWithUtmVariants(['', '   ', 42, null, URLS[0]], { enabled: false })).toEqual([URLS[0]]);
    // Произвольная непустая строка проходит как есть (GIGO — как раньше).
    expect(pageUrlsWithUtmVariants(['not-a-url'], { enabled: false })).toEqual(['not-a-url']);
  });
});
