/**
 * W0 (seo-round, 2026-08-22): юнит-тесты единого источника SEO-порогов.
 * Числа — из server/lib/seo-standards.mjs (единый источник порогов);
 * проверяются якоря объёмов (10k/30k/50k),
 * середины интервалов (кусочная линейность, не ступеньки), clamp вне шкалы
 * и мусорный вход.
 */
import { describe, it, expect } from 'vitest';
import {
  keysTargetByLength,
  mainQueryCountByLength,
  linksByLength,
  mentionsByLength,
  semanticCoreCaps,
  resolveSeoStandards,
  HEADINGS_WITH_KEYS_WINDOW,
  KEY_DENSITY,
  PER_KEY_DENSITY,
  FAQ_KEYS_SHARE_MIN,
  KEYS_IN_TEXT_SHARE_MIN,
  CANONICAL_ZONE_CHARS,
  SEO_MIN_NORM_CHARS,
} from '../../server/lib/seo-standards.mjs';

describe('keysTargetByLength — уникальные ключи SEO-ядра (§1.1)', () => {
  it('якоря объёмов: 10k → 8–12, 30k → 15–20, 50k → 20–30', () => {
    expect(keysTargetByLength(10_000)).toEqual({ min: 8, max: 12 });
    expect(keysTargetByLength(30_000)).toEqual({ min: 15, max: 20 });
    expect(keysTargetByLength(50_000)).toEqual({ min: 20, max: 30 });
  });

  it('формула норматива для min: ceil(8 + (L−10000)×7/20000) в зоне 10–30k', () => {
    // 20k: ceil(8 + 10000×7/20000) = ceil(11.5) = 12
    expect(keysTargetByLength(20_000).min).toBe(12);
    // 15k: ceil(8 + 5000×7/20000) = ceil(9.75) = 10
    expect(keysTargetByLength(15_000).min).toBe(10);
  });

  it('зона 30–50k: ceil(15 + (L−30000)×5/20000)', () => {
    // 40k: ceil(15 + 10000×5/20000) = ceil(17.5) = 18
    expect(keysTargetByLength(40_000).min).toBe(18);
    expect(keysTargetByLength(40_000).max).toBe(25); // ceil(20 + 10000×10/20000)
  });

  it('интерполяция непрерывна между зонами (не ступеньки): 29999 и 30001 рядом', () => {
    const before = keysTargetByLength(29_999);
    const at = keysTargetByLength(30_000);
    const after = keysTargetByLength(30_001);
    expect(Math.abs(after.min - before.min)).toBeLessThanOrEqual(1);
    expect(at.min).toBe(15);
  });

  it('clamp вне шкалы: <10k → якорь 10k, >50k → якорь 50k', () => {
    expect(keysTargetByLength(500)).toEqual({ min: 8, max: 12 });
    expect(keysTargetByLength(1_000_000)).toEqual({ min: 20, max: 30 });
  });

  it('мусорный вход (undefined/NaN/строка/0) → дефолт нижнего якоря 10k', () => {
    expect(keysTargetByLength(undefined)).toEqual({ min: 8, max: 12 });
    expect(keysTargetByLength(NaN)).toEqual({ min: 8, max: 12 });
    expect(keysTargetByLength('не число')).toEqual({ min: 8, max: 12 });
    expect(keysTargetByLength(0)).toEqual({ min: 8, max: 12 });
  });
});

describe('mainQueryCountByLength — вхождения главного запроса (§1.3)', () => {
  it('якоря: 10k → 3–5, 30k → 5–8, 50k → 8–12', () => {
    expect(mainQueryCountByLength(10_000)).toEqual({ min: 3, max: 5 });
    expect(mainQueryCountByLength(30_000)).toEqual({ min: 5, max: 8 });
    expect(mainQueryCountByLength(50_000)).toEqual({ min: 8, max: 12 });
  });

  it('интерполяция середины: 20k → min ceil(4)=4, max ceil(6.5)=7', () => {
    expect(mainQueryCountByLength(20_000)).toEqual({ min: 4, max: 7 });
  });
});

describe('linksByLength — ссылки на домен компании (§2.1)', () => {
  it('якоря: 10k → 2–4, 30k → 4–6, 50k → 6–8', () => {
    expect(linksByLength(10_000)).toEqual({ min: 2, max: 4 });
    expect(linksByLength(30_000)).toEqual({ min: 4, max: 6 });
    expect(linksByLength(50_000)).toEqual({ min: 6, max: 8 });
  });

  it('интерполяция середины: 20k → 3–5', () => {
    expect(linksByLength(20_000)).toEqual({ min: 3, max: 5 });
  });

  it('clamp: 8k (нижняя граница шкалы) и 100k', () => {
    expect(linksByLength(SEO_MIN_NORM_CHARS)).toEqual({ min: 2, max: 4 });
    expect(linksByLength(100_000)).toEqual({ min: 6, max: 8 });
  });
});

describe('mentionsByLength — упоминания бренда (§3.1)', () => {
  it('формулы min=floor(L/2500), max=round(L/1500) на якорях норматива', () => {
    expect(mentionsByLength(10_000)).toEqual({ min: 4, max: 7 });
    expect(mentionsByLength(30_000)).toEqual({ min: 12, max: 20 });
    expect(mentionsByLength(50_000)).toEqual({ min: 20, max: 33 });
  });

  it('промежуточный объём 17k → min floor(6.8)=6, max round(11.33)=11', () => {
    expect(mentionsByLength(17_000)).toEqual({ min: 6, max: 11 });
  });
});

describe('скалярные пороги (§1.4, §2.2, §4.1)', () => {
  it('окно заголовков с ключами: 20–65%, fail-граница 20%', () => {
    expect(HEADINGS_WITH_KEYS_WINDOW).toEqual({ min: 0.2, fail: 0.2, max: 0.65 });
  });
  it('плотность ядра: warn 3%, fail 4,5%; один ключ ≤1,5% / >2,5%', () => {
    expect(KEY_DENSITY).toEqual({ warn: 0.03, fail: 0.045 });
    expect(PER_KEY_DENSITY).toEqual({ warn: 0.015, fail: 0.025 });
  });
  it('FAQ-вопросы с ключом ≥40%; канон-зона 1200 симв.; доля ключей в тексте ≥60%', () => {
    expect(FAQ_KEYS_SHARE_MIN).toBe(0.4);
    expect(CANONICAL_ZONE_CHARS).toBe(1200);
    expect(KEYS_IN_TEXT_SHARE_MIN).toBe(0.6);
  });
});

describe('semanticCoreCaps — сечки промптов (§6.1; M2: частотный источник убран)', () => {
  it('M2: wordstat-сечки больше нет — semantic-strategist единственный источник ядра', () => {
    const caps = semanticCoreCaps(10_000);
    expect(caps).not.toHaveProperty('wordstat');
  });

  it('кластеры/LSI/FAQ-интенты — плоские SEO-default (объёмной нормы нет)', () => {
    const caps = semanticCoreCaps(30_000);
    expect(caps.clusters).toBe(10);
    expect(caps.lsi).toBe(12);
    expect(caps.faqIntents).toBe(8);
  });
});

describe('resolveSeoStandards — агрегатор', () => {
  it('собирает все нормативы объёма одним объектом', () => {
    const s = resolveSeoStandards(30_000);
    expect(s.chars).toBe(30_000);
    expect(s.keys).toEqual({ min: 15, max: 20 });
    expect(s.mainQuery).toEqual({ min: 5, max: 8 });
    expect(s.links).toEqual({ min: 4, max: 6 });
    expect(s.mentions).toEqual({ min: 12, max: 20 });
    expect(s.faqKeysShare).toBe(0.4);
    expect(s.canonicalZoneChars).toBe(1200);
    expect(s.minNormChars).toBe(8000);
  });

  it('linksHardCap: 8 при ≤40k, 10 при >40k (§2.1)', () => {
    expect(resolveSeoStandards(10_000).linksHardCap).toBe(8);
    expect(resolveSeoStandards(40_000).linksHardCap).toBe(8);
    expect(resolveSeoStandards(40_001).linksHardCap).toBe(10);
    expect(resolveSeoStandards(50_000).linksHardCap).toBe(10);
  });

  it('мусорный объём → дефолт 10k', () => {
    expect(resolveSeoStandards(null).keys).toEqual({ min: 8, max: 12 });
  });
});
