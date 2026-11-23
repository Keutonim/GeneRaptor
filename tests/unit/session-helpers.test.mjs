// @vitest-environment jsdom
/**
 * The client-side session helpers.
 *
 * Invariants under test:
 *   - the startup token is accepted ONLY from a strict `#token=<base64url>`
 *     fragment of the own address (never from the query, never from a body);
 *   - after the exchange the fragment is removed from the address AND from
 *     the history entry (replaceState, not pushState);
 *   - the exchange request is exactly `POST /api/auth/exchange` with
 *     `Authorization: Bearer <token>` and no body;
 *   - the boot probe reads `body.authenticated === true`, never `response.ok`
 *     (the real server always answers 200 — plan Р-4 / QA A-24).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseTokenFromHash,
  stripTokenFromLocation,
  exchangeStartupToken,
  fetchAuthStatus,
} from '../../src/lib/session';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('parseTokenFromHash', () => {
  it('accepts a 43-character base64url token', () => {
    const token = 'A'.repeat(43);
    expect(parseTokenFromHash(`#token=${token}`)).toBe(token);
  });

  it('accepts the whole base64url alphabet', () => {
    const token = 'abZ09_-';
    expect(parseTokenFromHash(`#token=${token}`)).toBe(token);
  });

  it('accepts the 512-character upper boundary', () => {
    const token = 'B'.repeat(512);
    expect(parseTokenFromHash(`#token=${token}`)).toBe(token);
  });

  it.each([
    ['empty hash', ''],
    ['another fragment', '#other'],
    ['empty value', '#token='],
    ['space in value', '#token=abc def'],
    ['cyrillic value', '#token=привет'],
    ['513 characters', `#token=${'A'.repeat(513)}`],
    ['plus sign', '#token=abc+def'],
    ['slash', '#token=abc/def'],
    ['padding', '#token=abc='],
    ['second fragment', '#token=abc#def'],
    ['no leading hash', 'token=abc'],
    ['query lookalike', '?token=abc'],
    ['wrong key', '#accessToken=abc'],
  ])('rejects %s', (_label, hash) => {
    expect(parseTokenFromHash(hash)).toBe(null);
  });

  it('rejects a missing hash', () => {
    expect(parseTokenFromHash(undefined)).toBe(null);
    expect(parseTokenFromHash(null)).toBe(null);
  });
});

describe('stripTokenFromLocation', () => {
  it('removes the fragment and keeps path and query', () => {
    window.history.replaceState(null, '', '/studio?tab=history#token=secret-value');
    stripTokenFromLocation();
    expect(window.location.pathname).toBe('/studio');
    expect(window.location.search).toBe('?tab=history');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('secret-value');
  });

  it('replaces the history entry instead of adding one', () => {
    window.history.replaceState(null, '', '/#token=secret-value');
    const before = window.history.length;
    stripTokenFromLocation();
    expect(window.history.length).toBe(before);
    expect(window.location.hash).toBe('');
  });
});

describe('exchangeStartupToken', () => {
  it('POSTs the bearer token to the exchange endpoint without a body', async () => {
    const response = { status: 200, ok: true };
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeStartupToken('token-value');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/exchange');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-value' });
    expect(init.body).toBeUndefined();
    expect(result).toBe(response);
  });
});

describe('fetchAuthStatus', () => {
  function stubStatus(status, body, { throwNetwork = false } = {}) {
    const fetchMock = vi.fn(async () => {
      if (throwNetwork) throw new Error('network down');
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads authenticated:true from the body', async () => {
    const fetchMock = stubStatus(200, { authenticated: true });
    expect(await fetchAuthStatus()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/status');
  });

  it('reads authenticated:false from the body', async () => {
    stubStatus(200, { authenticated: false });
    expect(await fetchAuthStatus()).toBe(false);
  });

  it('a 200 without the field is NOT authenticated', async () => {
    stubStatus(200, {});
    expect(await fetchAuthStatus()).toBe(false);
  });

  it('a truthy non-boolean is NOT authenticated', async () => {
    stubStatus(200, { authenticated: 'true' });
    expect(await fetchAuthStatus()).toBe(false);
  });

  it('a non-200 status is NOT authenticated', async () => {
    stubStatus(401, { authenticated: true });
    expect(await fetchAuthStatus()).toBe(false);
    stubStatus(500, { authenticated: true });
    expect(await fetchAuthStatus()).toBe(false);
  });

  it('survives a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    })));
    expect(await fetchAuthStatus()).toBe(false);
  });

  it('propagates a network failure (the caller decides the fallback)', async () => {
    stubStatus(0, null, { throwNetwork: true });
    await expect(fetchAuthStatus()).rejects.toThrow('network down');
  });
});