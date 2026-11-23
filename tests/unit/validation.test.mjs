import { describe, it, expect } from 'vitest';
import {
  isValidUUID,
  validateSourceSiteId,
  ValidationError,
} from '../../server/lib/validation.mjs';

describe('isValidUUID', () => {
  it('returns true for a valid UUID v4', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('returns true for another valid UUID v4', () => {
    expect(isValidUUID('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
  });

  it('returns false for a non-uuid string', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidUUID('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isValidUUID(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidUUID(undefined)).toBe(false);
  });

  it('returns false for a number (not a string)', () => {
    expect(isValidUUID(123)).toBe(false);
  });

  it('returns false for UUID v1 (wrong version digit)', () => {
    // 4th group starts with "1" — not "4"
    expect(isValidUUID('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('returns false for UUID with wrong variant digit', () => {
    // 5th group starts with "c" — not [89ab]
    expect(isValidUUID('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
  });
});

describe('validateSourceSiteId', () => {
  it('returns null when value is null', () => {
    expect(validateSourceSiteId(null)).toBeNull();
  });

  it('returns null when value is undefined', () => {
    expect(validateSourceSiteId(undefined)).toBeNull();
  });

  it('returns null when value is empty string', () => {
    expect(validateSourceSiteId('')).toBeNull();
  });

  it('returns the same valid UUID string when valid', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateSourceSiteId(uuid)).toBe(uuid);
  });

  it('throws ValidationError for garbage string', () => {
    expect(() => validateSourceSiteId('garbage')).toThrow(ValidationError);
    expect(() => validateSourceSiteId('garbage')).toThrow(/sourceSiteId/i);
  });

  it('throws ValidationError for non-string type (number)', () => {
    expect(() => validateSourceSiteId(123)).toThrow(ValidationError);
  });
});

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    const err = new ValidationError('test message');
    expect(err).toBeInstanceOf(Error);
  });

  it('has status property defaulting to 400', () => {
    const err = new ValidationError('bad request');
    expect(err.status).toBe(400);
  });

  it('exposes statusCode alias matching status', () => {
    const err = new ValidationError('bad request');
    expect(err.statusCode).toBe(400);
  });

  it('preserves the message', () => {
    const err = new ValidationError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('has name "ValidationError"', () => {
    const err = new ValidationError('test');
    expect(err.name).toBe('ValidationError');
  });
});
