/**
 * The launcher's browser auto-open decision.
 *
 * The decision is a PURE function so every guard can be pinned without
 * spawning anything; the spawn wrapper and the readiness poll take injections
 * so the unit suite never opens a real browser and never waits 60 s.
 *
 * Invariants under test:
 *   - auto-open is skipped for --no-browser, NODE_ENV=test, CI, a non-TTY
 *     stdout, a fixed reusable token and an unavailable UI;
 *   - the one-time token rides the URL FRAGMENT (never the query — the HTTP
 *     logger prints req.url);
 *   - a spawn failure is reported, never thrown (the launcher must not die);
 *   - the readiness poll returns false on timeout instead of hanging.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import {
  shouldAutoOpenBrowser,
  buildAutoOpenUrl,
  openBrowser,
  waitForUiReady,
} from '../../server/lib/open-browser.mjs';

const ui = { uiServed: true, mode: 'api-root', uiUrl: 'http://127.0.0.1:8787' };

describe('shouldAutoOpenBrowser', () => {
  const base = { env: {}, isTTY: true, noBrowserFlag: false, ui, tokenMode: 'one-time' };

  it('opens for a one-time token on a TTY', () => {
    expect(shouldAutoOpenBrowser(base)).toEqual({ open: true, reason: 'ok' });
  });

  it.each([
    ['flag', { noBrowserFlag: true }],
    ['test-env', { env: { NODE_ENV: 'test' } }],
    ['ci', { env: { CI: 'true' } }],
    ['no-tty', { isTTY: false }],
    ['fixed-token', { tokenMode: 'fixed' }],
    ['no-ui', { ui: { ...ui, uiServed: false } }],
  ])('skips on %s', (reason, patch) => {
    expect(shouldAutoOpenBrowser({ ...base, ...patch })).toEqual({ open: false, reason });
  });

  it.each(['none', 'dev-server-not-started'])('skips when the UI mode is %s', (mode) => {
    expect(shouldAutoOpenBrowser({ ...base, ui: { ...ui, mode } })).toEqual({
      open: false,
      reason: 'no-ui',
    });
  });

  it('skips when the UI object is missing entirely', () => {
    expect(shouldAutoOpenBrowser({ ...base, ui: undefined })).toEqual({
      open: false,
      reason: 'no-ui',
    });
  });

  it('CI=false does not skip', () => {
    expect(shouldAutoOpenBrowser({ ...base, env: { CI: 'false' } }).open).toBe(true);
  });

  it('CI=0 does not skip', () => {
    expect(shouldAutoOpenBrowser({ ...base, env: { CI: '0' } }).open).toBe(true);
  });

  it('an empty CI does not skip', () => {
    expect(shouldAutoOpenBrowser({ ...base, env: { CI: '' } }).open).toBe(true);
  });

  it('opens without a token in no-auth mode', () => {
    expect(shouldAutoOpenBrowser({ ...base, tokenMode: 'no-auth' }).open).toBe(true);
  });

  it('the explicit flag wins over every other guard', () => {
    expect(
      shouldAutoOpenBrowser({ ...base, noBrowserFlag: true, env: { CI: 'true' }, isTTY: false }),
    ).toEqual({ open: false, reason: 'flag' });
  });
});

describe('buildAutoOpenUrl', () => {
  it('appends the token as a fragment', () => {
    expect(buildAutoOpenUrl({ uiUrl: 'http://127.0.0.1:8787/', token: 'T'.repeat(43) }))
      .toBe(`http://127.0.0.1:8787/#token=${'T'.repeat(43)}`);
  });

  it('returns the plain url without a token', () => {
    expect(buildAutoOpenUrl({ uiUrl: 'http://127.0.0.1:8787', token: null })).toBe('http://127.0.0.1:8787');
  });

  it('never puts the token into the query string', () => {
    const url = buildAutoOpenUrl({ uiUrl: 'http://127.0.0.1:8787', token: 'abc_-DEF' });
    expect(url).toBe('http://127.0.0.1:8787/#token=abc_-DEF');
    expect(url).not.toContain('?');
    expect(new URL(url).search).toBe('');
    expect(new URL(url).hash).toBe('#token=abc_-DEF');
  });

  it('strips every trailing slash before appending the fragment', () => {
    expect(buildAutoOpenUrl({ uiUrl: 'http://127.0.0.1:5173///', token: 'x' }))
      .toBe('http://127.0.0.1:5173/#token=x');
  });
});

describe('openBrowser (injected spawn)', () => {
  function fakeSpawn(calls, event = 'spawn') {
    return (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      const e = new EventEmitter();
      queueMicrotask(() => e.emit(event, event === 'error' ? new Error('nope') : undefined));
      return e;
    };
  }

  it('uses cmd start on win32', async () => {
    const calls = [];
    const res = await openBrowser('http://x/#token=t', { platform: 'win32', spawnImpl: fakeSpawn(calls) });
    expect(res.ok).toBe(true);
    expect(calls[0][0]).toBe('cmd.exe');
    expect(calls[0][1]).toEqual(['/c', 'start', '', 'http://x/#token=t']);
  });

  it('uses open on darwin', async () => {
    const calls = [];
    const res = await openBrowser('http://x/#token=t', { platform: 'darwin', spawnImpl: fakeSpawn(calls) });
    expect(res.ok).toBe(true);
    expect(calls[0][0]).toBe('open');
    expect(calls[0][1]).toEqual(['http://x/#token=t']);
  });

  it('uses xdg-open on linux', async () => {
    const calls = [];
    const res = await openBrowser('http://x/#token=t', { platform: 'linux', spawnImpl: fakeSpawn(calls) });
    expect(res.ok).toBe(true);
    expect(calls[0][0]).toBe('xdg-open');
    expect(calls[0][1]).toEqual(['http://x/#token=t']);
  });

  it('spawns without a shell and detached, so the launcher is not blocked', async () => {
    const calls = [];
    await openBrowser('http://x', { platform: 'linux', spawnImpl: fakeSpawn(calls) });
    expect(calls[0][2]).toMatchObject({ shell: false, detached: true, stdio: 'ignore' });
  });

  it('reports failure on spawn error', async () => {
    const calls = [];
    const res = await openBrowser('http://x', { platform: 'linux', spawnImpl: fakeSpawn(calls, 'error') });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });

  it('reports failure when spawn itself throws', async () => {
    const res = await openBrowser('http://x', {
      platform: 'linux',
      spawnImpl: () => { throw new Error('no spawn here'); },
    });
    expect(res.ok).toBe(false);
  });
});

describe('waitForUiReady (injected fetch)', () => {
  it('resolves true on 200 and false on timeout', async () => {
    const ok = await waitForUiReady('http://x', { fetchImpl: async () => ({ ok: true }), timeoutMs: 100, intervalMs: 10 });
    expect(ok).toBe(true);
    const bad = await waitForUiReady('http://x', { fetchImpl: async () => { throw new Error('down'); }, timeoutMs: 50, intervalMs: 10 });
    expect(bad).toBe(false);
  });

  it('keeps polling until the UI answers 2xx', async () => {
    let attempts = 0;
    const ok = await waitForUiReady('http://x', {
      fetchImpl: async () => {
        attempts += 1;
        return { ok: attempts >= 3 };
      },
      timeoutMs: 2000,
      intervalMs: 5,
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('does not follow redirects while probing readiness', async () => {
    const seen = [];
    await waitForUiReady('http://x', {
      fetchImpl: async (url, opts) => { seen.push([url, opts]); return { ok: true }; },
      timeoutMs: 100,
      intervalMs: 10,
    });
    expect(seen[0][0]).toBe('http://x');
    expect(seen[0][1]).toMatchObject({ redirect: 'manual' });
  });
});