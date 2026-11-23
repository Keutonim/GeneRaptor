/**
 * Unit tests for TokenGate (docs/ui-design.md §6) pure logic.
 *
 * The gate is a full-screen lock with exactly four states — empty / wrong /
 * rate-limited / success — one input, one button; only the line under the
 * button changes. These tests pin the state mapping of the exchange response
 * and the rate-limit countdown seed.
 */
import { describe, it, expect } from 'vitest';
// Pure functions from the React component - tested without DOM (vitest
// transforms .tsx via vite, same as the main bundle).
import {
  deriveExchangeStatus,
  parseRetryAfter,
} from '../../src/components/TokenGate';

describe('parseRetryAfter', () => {
  it('parses a positive integer header value', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter('45')).toBe(45);
  });

  it('falls back to 15 s (the server window) when absent', () => {
    expect(parseRetryAfter(null)).toBe(15);
    expect(parseRetryAfter(undefined)).toBe(15);
  });

  it('falls back on garbage or non-positive values', () => {
    expect(parseRetryAfter('soon')).toBe(15);
    expect(parseRetryAfter('0')).toBe(15);
    expect(parseRetryAfter('-5')).toBe(15);
    expect(parseRetryAfter('')).toBe(15);
  });
});

describe('deriveExchangeStatus (docs/ui-design.md §6 state machine)', () => {
  it('200 -> success (gate unmounts, shell takes over)', () => {
    const r = deriveExchangeStatus(200, null);
    expect(r.state).toBe('success');
    expect(r.message).toBeNull();
  });

  it('401 -> wrong with the design line naming the three reasons', () => {
    const r = deriveExchangeStatus(401, null);
    expect(r.state).toBe('wrong');
    expect(r.message).toBe(
      'Токен не принят — неверен, уже использован или окно приёма истёкло'
    );
  });

  it('429 -> rate-limited with the countdown seeded from Retry-After', () => {
    const r = deriveExchangeStatus(429, '12');
    expect(r.state).toBe('rate-limited');
    expect(r.retryAfterSec).toBe(12);
  });

  it('429 without Retry-After seeds the countdown with the 15 s window', () => {
    const r = deriveExchangeStatus(429, null);
    expect(r.state).toBe('rate-limited');
    expect(r.retryAfterSec).toBe(15);
  });

  it('unexpected statuses map to an error state (network/server trouble)', () => {
    const r = deriveExchangeStatus(500, null);
    expect(r.state).toBe('error');
    expect(typeof r.message).toBe('string');
    expect(r.message.length).toBeGreaterThan(0);
  });
});
