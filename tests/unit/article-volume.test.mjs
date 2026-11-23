import { describe, it, expect } from 'vitest';
import {
  isValidVolume,
  volumeOptions,
  volumeRangeLabel,
  MIN_VOLUME,
  MAX_VOLUME,
  VOLUME_STEP,
} from '../../server/lib/article-volume.mjs';

describe('volumeOptions', () => {
  it('has exactly 7 valid options from 50000 to 80000', () => {
    expect(volumeOptions).toHaveLength(7);
    expect(volumeOptions[0]).toBe(50000);
    expect(volumeOptions[6]).toBe(80000);
  });

  it('matches the documented MIN/MAX constants', () => {
    expect(MIN_VOLUME).toBe(50000);
    expect(MAX_VOLUME).toBe(80000);
    expect(VOLUME_STEP).toBe(5000);
  });
});

describe('isValidVolume — valid values', () => {
  it.each([50000, 55000, 60000, 65000, 70000, 75000, 80000])(
    'returns true for %i (within range, multiple of step)',
    (value) => {
      expect(isValidVolume(value)).toBe(true);
    }
  );
});

describe('isValidVolume — invalid values', () => {
  it('returns false for value just below MIN (49999)', () => {
    expect(isValidVolume(49999)).toBe(false);
  });

  it('returns false for value just above MAX (80001)', () => {
    expect(isValidVolume(80001)).toBe(false);
  });

  it('returns false for value in range but not a multiple of step (52500)', () => {
    expect(isValidVolume(52500)).toBe(false);
  });

  it('returns false for string coercion ("50000") — strict integer check', () => {
    // Number.isInteger('50000') === false, so strict mode applies
    expect(isValidVolume('50000')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isValidVolume(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidVolume(undefined)).toBe(false);
  });

  it('returns false for NaN', () => {
    expect(isValidVolume(NaN)).toBe(false);
  });

  it('returns false for float (50000.5)', () => {
    expect(isValidVolume(50000.5)).toBe(false);
  });
});

describe('volumeRangeLabel', () => {
  it('returns a non-empty human-readable string', () => {
    const label = volumeRangeLabel();
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('includes the step value in the label (uses ru-RU locale formatting)', () => {
    const label = volumeRangeLabel();
    // ru-RU toLocaleString uses non-breaking space (U+00A0) as thousands sep
    const expectedStep = (5000).toLocaleString('ru-RU');
    expect(label).toContain(expectedStep);
  });
});
