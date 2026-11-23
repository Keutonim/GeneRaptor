/**
 * Unit tests for the one-time startup token gate.
 *
 * Covers:
 *   - generateStartupToken: base64url, 43 chars (256-bit entropy), unique.
 *   - createTokenGate().exchange: happy path, single-use (repeat -> fail),
 *     wrong token does not burn, acceptance window expiry, fixed-token mode
 *     (multi-use, no window).
 *   - Module singleton resolution from env: default self-generated one-time,
 *     GENERAPTOR_TOKEN -> fixed, GENERAPTOR_STARTUP_TOKEN -> launcher-provided
 *     one-time, operator fixed wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOKEN_ACCEPTANCE_WINDOW_MS,
  generateStartupToken,
  createTokenGate,
} from '../../server/lib/startup-token.mjs';

describe('generateStartupToken', () => {
  it('returns a 43-char base64url string (32 bytes, >=128 bits)', () => {
    const token = generateStartupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats across invocations', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(generateStartupToken());
    expect(seen.size).toBe(100);
  });
});

describe('createTokenGate().exchange (one-time mode)', () => {
  it('accepts the correct token', () => {
    const gate = createTokenGate({ token: 'tok'.padEnd(43, 'x') });
    expect(gate.exchange('tok'.padEnd(43, 'x'))).toEqual({ ok: true });
  });

  it('rejects a repeat exchange of the same token (single-use)', () => {
    const token = 'tok'.padEnd(43, 'x');
    const gate = createTokenGate({ token });
    expect(gate.exchange(token).ok).toBe(true);
    expect(gate.exchange(token).ok).toBe(false);
  });

  it('does not burn the token on a wrong candidate', () => {
    const token = 'tok'.padEnd(43, 'x');
    const gate = createTokenGate({ token });
    expect(gate.exchange('wrong').ok).toBe(false);
    expect(gate.exchange(token).ok).toBe(true);
  });

  it('rejects empty / non-string candidates', () => {
    const gate = createTokenGate({ token: 'tok'.padEnd(43, 'x') });
    expect(gate.exchange('').ok).toBe(false);
    expect(gate.exchange(undefined).ok).toBe(false);
    expect(gate.exchange(null).ok).toBe(false);
  });

  it('rejects the token after the acceptance window expires', () => {
    const token = 'tok'.padEnd(43, 'x');
    const windowMs = 15 * 60 * 1000;
    const gate = createTokenGate({ token, issuedAt: 0, windowMs });
    expect(gate.exchange(token, windowMs).ok).toBe(true); // last instant
    const gate2 = createTokenGate({ token, issuedAt: 0, windowMs });
    expect(gate2.exchange(token, windowMs + 1).ok).toBe(false); // one ms late
  });

  it('accepts inside the default window (14 of 15 minutes elapsed)', () => {
    const token = 'tok'.padEnd(43, 'x');
    const issuedAt = Date.now() - 14 * 60 * 1000;
    const gate = createTokenGate({ token, issuedAt });
    expect(gate.exchange(token).ok).toBe(true);
  });

  it('exposes the default window constant as 15 minutes', () => {
    expect(TOKEN_ACCEPTANCE_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe('createTokenGate().exchange (fixed-token mode)', () => {
  it('accepts repeated exchanges of the fixed token', () => {
    const gate = createTokenGate({ token: 'fixed-secret-token-value', fixed: true });
    expect(gate.exchange('fixed-secret-token-value').ok).toBe(true);
    expect(gate.exchange('fixed-secret-token-value').ok).toBe(true);
    expect(gate.exchange('fixed-secret-token-value').ok).toBe(true);
  });

  it('ignores the acceptance window in fixed mode', () => {
    const gate = createTokenGate({
      token: 'fixed-secret-token-value',
      fixed: true,
      issuedAt: 0,
    });
    expect(gate.exchange('fixed-secret-token-value', Date.now()).ok).toBe(true);
  });
});

describe('module singleton resolution from env', () => {
  /** Fresh-import the module so the module-level gate re-reads env. */
  async function freshModule() {
    vi.resetModules();
    return import('../../server/lib/startup-token.mjs');
  }

  beforeEach(() => {
    delete process.env.GENERAPTOR_TOKEN;
    delete process.env.GENERAPTOR_STARTUP_TOKEN;
  });

  it('self-generates a one-time token by default', async () => {
    const mod = await freshModule();
    const gate = mod.getStartupTokenGate();
    expect(gate.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gate.fixed).toBe(false);
  });

  it('uses GENERAPTOR_TOKEN as a fixed multi-use token', async () => {
    process.env.GENERAPTOR_TOKEN = 'operator-fixed-token';
    const mod = await freshModule();
    const gate = mod.getStartupTokenGate();
    expect(gate.token).toBe('operator-fixed-token');
    expect(gate.fixed).toBe(true);
  });

  it('uses GENERAPTOR_STARTUP_TOKEN as a one-time launcher token', async () => {
    process.env.GENERAPTOR_STARTUP_TOKEN = 'launcher-generated-one-time';
    const mod = await freshModule();
    const gate = mod.getStartupTokenGate();
    expect(gate.token).toBe('launcher-generated-one-time');
    expect(gate.fixed).toBe(false);
  });

  it('operator GENERAPTOR_TOKEN wins over launcher STARTUP_TOKEN', async () => {
    process.env.GENERAPTOR_TOKEN = 'operator';
    process.env.GENERAPTOR_STARTUP_TOKEN = 'launcher';
    const mod = await freshModule();
    expect(mod.getStartupTokenGate().token).toBe('operator');
  });

  it('replaces the singleton via the test hook', async () => {
    const mod = await freshModule();
    const custom = createTokenGate({ token: 'injected-for-test' });
    mod._setTokenGateForTests(custom);
    expect(mod.getStartupTokenGate()).toBe(custom);
    mod._setTokenGateForTests();
    expect(mod.getStartupTokenGate().token).not.toBe('injected-for-test');
  });
});
