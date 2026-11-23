// T-13 UX: after the 429 auto-retry cap the hint must be STATIC — a frozen
// countdown («через 0 с» / «через N с» that never ticks) is nonsense.
// DOM-free unit test over the real module (repo idiom: no testing-library).
//
// Contract:
//   - below the cap the rate-limited hint uses the countdown key;
//   - at/above the cap it uses a dedicated static key (no {countdown});
//   - the static key exists in BOTH locales and points at manual Refresh.
import { describe, it, expect } from 'vitest';
import { rateLimitedHintKey, MAX_AUTO_RETRIES } from '../../src/components/SessionGate';
import { dictionaries, LOCALES } from '../../src/i18n/dictionary';

const COUNTDOWN_KEY = 'session.hint.rateLimited';
const CAP_KEY = 'session.hint.rateLimitedCap';

describe('SessionGate — rate-limited hint selection (T-13)', () => {
  it('exposes the auto-retry cap as a positive number', () => {
    expect(typeof MAX_AUTO_RETRIES).toBe('number');
    expect(MAX_AUTO_RETRIES).toBeGreaterThan(0);
  });

  it('below the cap → the countdown hint key', () => {
    for (let n = 0; n < MAX_AUTO_RETRIES; n += 1) {
      expect(rateLimitedHintKey(n)).toBe(COUNTDOWN_KEY);
    }
  });

  it('at the cap and above → the static hint key (no countdown)', () => {
    expect(rateLimitedHintKey(MAX_AUTO_RETRIES)).toBe(CAP_KEY);
    expect(rateLimitedHintKey(MAX_AUTO_RETRIES + 5)).toBe(CAP_KEY);
  });
});

describe('session.hint.rateLimitedCap — dictionary contract', () => {
  it('exists in BOTH locales as a plain string', () => {
    for (const locale of LOCALES) {
      expect(typeof dictionaries[locale][CAP_KEY]).toBe('string');
      expect(dictionaries[locale][CAP_KEY].length).toBeGreaterThan(0);
    }
  });

  it('carries no {countdown} placeholder (the hint is static)', () => {
    for (const locale of LOCALES) {
      expect(dictionaries[locale][CAP_KEY]).not.toContain('{countdown}');
    }
  });

  it('points the user at the manual Refresh button', () => {
    expect(dictionaries.ru[CAP_KEY]).toContain('Обновить');
    expect(dictionaries.en[CAP_KEY]).toContain('Refresh');
  });

  it('the countdown key keeps its {countdown} placeholder in both locales', () => {
    for (const locale of LOCALES) {
      expect(dictionaries[locale][COUNTDOWN_KEY]).toContain('{countdown}');
    }
  });
});