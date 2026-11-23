/**
 * S5 T1 (round 2) — pure contract of the dev-UI-origin marker.
 *
 * The marker is a TOPOLOGY fact handed to the API child by the launcher
 * (`--dev-ui-origin <origin>`), never a NODE_ENV guess: the owner's .env sets
 * NODE_ENV=production while the launcher still starts Vite, so a NODE_ENV-based
 * rule silently left the owner's 403 bug in place (results/s5-security-verify.md
 * §3.1, must-fix 1/3).
 *
 * SEC-03 stays strict. The marker adds AT MOST ONE alias — the other loopback
 * spelling of the SAME port (127.0.0.1 <-> localhost). Acceptance is fail-closed:
 * exactly one origin, a loopback host, an explicit port, the scheme preserved.
 * A non-loopback host, a missing port, a list, 'null', a wildcard, a path or
 * credentials are ignored — the set is then unchanged.
 *
 * U1-U9 of results/s5-security-pre.md §3.5.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  devUiOrigins,
  isAllowedOrigin,
} from '../../server/lib/request-origin.mjs';

const UI_PORT = 5173;
const API_PORT = 8802;

describe('devUiOrigins — the marker is accepted fail-closed (S5 T1)', () => {
  it('U1: a 127.0.0.1 marker yields the origin plus exactly ONE alias', () => {
    expect(devUiOrigins(`http://127.0.0.1:${UI_PORT}`)).toEqual([
      `http://127.0.0.1:${UI_PORT}`,
      `http://localhost:${UI_PORT}`,
    ]);
  });

  it('U2: a localhost marker yields the symmetric pair', () => {
    expect(devUiOrigins(`http://localhost:${UI_PORT}`)).toEqual([
      `http://localhost:${UI_PORT}`,
      `http://127.0.0.1:${UI_PORT}`,
    ]);
  });

  it('U3: a non-loopback marker is ignored', () => {
    expect(devUiOrigins(`http://192.168.1.10:${UI_PORT}`)).toEqual([]);
    expect(devUiOrigins(`http://0.0.0.0:${UI_PORT}`)).toEqual([]);
    expect(devUiOrigins(`http://localtest.me:${UI_PORT}`)).toEqual([]);
    expect(devUiOrigins(`http://app.localhost:${UI_PORT}`)).toEqual([]);
    expect(devUiOrigins('https://studio.example.com')).toEqual([]);
  });

  it('U4: a marker WITHOUT an explicit port is ignored (no implicit 80/443)', () => {
    expect(devUiOrigins('http://127.0.0.1')).toEqual([]);
    expect(devUiOrigins('http://localhost')).toEqual([]);
    expect(devUiOrigins('https://localhost')).toEqual([]);
    expect(devUiOrigins('http://[::1]')).toEqual([]);
  });

  it('U5: empty, null, a list, a wildcard and a foreign origin are ignored', () => {
    for (const value of [
      '',
      '   ',
      undefined,
      null,
      'null',
      'NULL',
      '*',
      'http://evil.example',
      `http://127.0.0.1:${UI_PORT},http://localhost:${UI_PORT}`,
      `http://127.0.0.1:${UI_PORT} http://localhost:${UI_PORT}`,
      `["http://127.0.0.1:${UI_PORT}"]`,
      42,
      {},
    ]) {
      expect(devUiOrigins(value)).toEqual([]);
    }
  });

  it('U6: the scheme is preserved (https marker -> https alias)', () => {
    expect(devUiOrigins(`https://127.0.0.1:${UI_PORT}`)).toEqual([
      `https://127.0.0.1:${UI_PORT}`,
      `https://localhost:${UI_PORT}`,
    ]);
    expect(devUiOrigins(`https://localhost:${UI_PORT}`)).toEqual([
      `https://localhost:${UI_PORT}`,
      `https://127.0.0.1:${UI_PORT}`,
    ]);
  });

  it('a ::1 marker is accepted as itself but gets NO alias (director decision)', () => {
    expect(devUiOrigins(`http://[::1]:${UI_PORT}`)).toEqual([`http://[::1]:${UI_PORT}`]);
  });

  it('a marker carrying a path, a query, a fragment or credentials is ignored', () => {
    expect(devUiOrigins(`http://127.0.0.1:${UI_PORT}/path`)).toEqual([]);
    expect(devUiOrigins(`http://127.0.0.1:${UI_PORT}/`)).toEqual([]);
    expect(devUiOrigins(`http://127.0.0.1:${UI_PORT}/?x=1`)).toEqual([]);
    expect(devUiOrigins(`http://127.0.0.1:${UI_PORT}/#frag`)).toEqual([]);
    expect(devUiOrigins(`http://user:pass@127.0.0.1:${UI_PORT}`)).toEqual([]);
    expect(devUiOrigins(`ftp://127.0.0.1:${UI_PORT}`)).toEqual([]);
    expect(devUiOrigins(`http://127.0.0.1:0`)).toEqual([]);
  });

  it('the marker is normalized to lower case (an Origin header is case-insensitive)', () => {
    expect(devUiOrigins(`HTTP://LOCALHOST:${UI_PORT}`)).toEqual([
      `http://localhost:${UI_PORT}`,
      `http://127.0.0.1:${UI_PORT}`,
    ]);
  });
});

describe('allowedOrigins — the marker widens the GUARD set only (S5 T1)', () => {
  it('U7: both spellings of the UI port AND the own API origins are allowed', () => {
    const allowed = allowedOrigins({
      actualPort: API_PORT,
      bindHost: '127.0.0.1',
      corsOrigin: `http://127.0.0.1:${UI_PORT}`,
      devUiOrigin: `http://127.0.0.1:${UI_PORT}`,
    });
    expect(isAllowedOrigin(`http://127.0.0.1:${UI_PORT}`, { allowedOrigins: allowed })).toBe(true);
    expect(isAllowedOrigin(`http://localhost:${UI_PORT}`, { allowedOrigins: allowed })).toBe(true);
    expect(allowed.has(`http://127.0.0.1:${API_PORT}`)).toBe(true);
    expect(allowed.has(`http://localhost:${API_PORT}`)).toBe(true);
    expect(allowed.has(`http://[::1]:${API_PORT}`)).toBe(true);
  });

  it('U2/U7: a localhost marker is expanded symmetrically in the set', () => {
    const allowed = allowedOrigins({
      actualPort: API_PORT,
      corsOrigin: `http://localhost:${UI_PORT}`,
      devUiOrigin: `http://localhost:${UI_PORT}`,
    });
    expect(allowed.has(`http://127.0.0.1:${UI_PORT}`)).toBe(true);
    expect(allowed.has(`http://localhost:${UI_PORT}`)).toBe(true);
    expect(allowed.has(`http://[::1]:${UI_PORT}`)).toBe(false);
  });

  it('U8: without the marker the set is NOT widened (prod invariant)', () => {
    const base = { actualPort: API_PORT, bindHost: '127.0.0.1', corsOrigin: `http://127.0.0.1:${UI_PORT}` };
    const withoutMarker = allowedOrigins(base);
    expect(withoutMarker.has(`http://127.0.0.1:${UI_PORT}`)).toBe(true);
    expect(withoutMarker.has(`http://localhost:${UI_PORT}`)).toBe(false);
    expect(withoutMarker.has(`http://[::1]:${UI_PORT}`)).toBe(false);
    expect([...allowedOrigins({ ...base, devUiOrigin: undefined })]).toEqual([...withoutMarker]);
    expect([...allowedOrigins({ ...base, devUiOrigin: '' })]).toEqual([...withoutMarker]);
    expect([...allowedOrigins({ ...base, devUiOrigin: 'null' })]).toEqual([...withoutMarker]);
  });

  it('an invalid marker never widens the set (fail-closed, same size as without it)', () => {
    const base = { actualPort: API_PORT, bindHost: '127.0.0.1', corsOrigin: `http://127.0.0.1:${UI_PORT}` };
    const expected = [...allowedOrigins(base)];
    for (const devUiOrigin of [
      'http://evil.example',
      `http://192.168.1.10:${UI_PORT}`,
      'http://127.0.0.1',
      `http://127.0.0.1:${UI_PORT},http://localhost:${UI_PORT}`,
      `http://app.localhost:${UI_PORT}`,
      '*',
    ]) {
      expect([...allowedOrigins({ ...base, devUiOrigin })]).toEqual(expected);
    }
  });

  it('the marker never opens another port, a foreign host or null', () => {
    const allowed = allowedOrigins({
      actualPort: API_PORT,
      bindHost: '127.0.0.1',
      corsOrigin: `http://127.0.0.1:${UI_PORT}`,
      devUiOrigin: `http://127.0.0.1:${UI_PORT}`,
    });
    expect(isAllowedOrigin(`http://localhost:${UI_PORT + 1}`, { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin(`http://127.0.0.1:${UI_PORT + 1}`, { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin('http://evil.example', { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin(`http://localtest.me:${UI_PORT}`, { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin('null', { allowedOrigins: allowed })).toBe(false);
  });

  it('a non-loopback CORS origin is never expanded by the marker rule', () => {
    const allowed = allowedOrigins({
      actualPort: API_PORT,
      corsOrigin: 'https://studio.example.com',
      devUiOrigin: 'https://studio.example.com',
    });
    expect(allowed.has('https://studio.example.com')).toBe(true);
    expect(allowed.has('https://localhost:443')).toBe(false);
    expect(allowed.size).toBe(allowedOrigins({ actualPort: API_PORT, corsOrigin: 'https://studio.example.com' }).size);
  });

  it('U9: isAllowedOrigin keeps the SEC-03 rules (null/other port/subdomain/https refused, empty allowed)', () => {
    const allowed = allowedOrigins({
      actualPort: API_PORT,
      bindHost: '127.0.0.1',
      corsOrigin: `http://127.0.0.1:${UI_PORT}`,
      devUiOrigin: `http://127.0.0.1:${UI_PORT}`,
    });
    expect(isAllowedOrigin('null', { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin(`http://127.0.0.1:${UI_PORT + 1}`, { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin(`http://app.localhost:${UI_PORT}`, { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin(`https://127.0.0.1:${UI_PORT}`, { allowedOrigins: allowed })).toBe(false);
    expect(isAllowedOrigin(`https://localhost:${UI_PORT}`, { allowedOrigins: allowed })).toBe(false);
    // A missing Origin is a CLI client, not a browser — it stays allowed.
    expect(isAllowedOrigin('', { allowedOrigins: allowed })).toBe(true);
    expect(isAllowedOrigin(undefined, { allowedOrigins: allowed })).toBe(true);
  });

  it('the own API origins are present with and without the marker (unchanged behaviour)', () => {
    for (const devUiOrigin of [undefined, `http://127.0.0.1:${UI_PORT}`]) {
      const allowed = allowedOrigins({
        actualPort: API_PORT,
        bindHost: '127.0.0.1',
        corsOrigin: `http://127.0.0.1:${UI_PORT}`,
        devUiOrigin,
      });
      expect(allowed.has(`http://127.0.0.1:${API_PORT}`)).toBe(true);
      expect(allowed.has(`http://localhost:${API_PORT}`)).toBe(true);
      expect(allowed.has(`http://[::1]:${API_PORT}`)).toBe(true);
    }
  });
});
