/**
 * The redirect-wrapper unwrapping policy of the web-search layer.
 *
 * Every fixture here is SYNTHETIC: no network, no provider key, no live URL.
 * The policy must unwrap the four known wrapper forms to their real target
 * BEFORE deduplication and persistence, drop everything that cannot be
 * unwrapped safely, and leave every non-wrapper URL byte-for-byte untouched.
 *
 * RED contract: on the base revision the module does not exist and
 * the end-to-end suites collapse five goto wrappers into one result — these
 * tests fail there and pass only with the policy in place.
 */
import { describe, it, expect } from 'vitest';
import {
  REDIRECT_WRAPPER_IDS,
  isRedirectWrapperUrl,
  unwrapRedirectUrl,
  unwrapDuckDuckGoUrl,
} from '../../server/lib/web-search/redirect-unwrap.mjs';

/** base64url of a synthetic target (Bing `ck/a` carries `a1` + base64url). */
const b64url = (value) => Buffer.from(value, 'utf8').toString('base64url');

describe('redirect-unwrap — rule table (4 forms)', () => {
  it('exposes exactly the four wrapper rule ids', () => {
    expect([...REDIRECT_WRAPPER_IDS].sort()).toEqual(
      ['bing-ck', 'ddg-l', 'google-goto', 'google-url'].sort(),
    );
  });

  const VALID_CASES = [
    ['google-url', 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage', 'https://example.com/page'],
    ['google-url', 'https://google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=U&ved=0', 'https://example.com/page'],
    ['google-goto', 'https://www.google.com/goto?url=https%3A%2F%2Fwww.apple.com%2F', 'https://www.apple.com/'],
    ['google-goto', 'https://google.com/goto?url=https%3A%2F%2Fexample.com%2Fgoto-target', 'https://example.com/goto-target'],
    ['bing-ck', `https://www.bing.com/ck/a?u=a1${b64url('https://example.org/bing-target')}`, 'https://example.org/bing-target'],
    ['bing-ck', `https://bing.com/ck/a?u=a1${b64url('https://example.org/bing-target')}&ntb=1`, 'https://example.org/bing-target'],
    ['ddg-l', 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fddg', 'https://example.net/ddg'],
    ['ddg-l', 'https://www.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fwww-ddg', 'https://example.net/www-ddg'],
    ['ddg-l', 'https://links.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Flinks', 'https://example.net/links'],
  ];

  it.each(VALID_CASES)('unwraps %s: %s → %s', (id, raw, target) => {
    const result = unwrapRedirectUrl(raw);
    expect(result.status).toBe('unwrapped');
    expect(result.url).toBe(target);
    expect(result.wrapper).toBe(id);
    expect(result.reason).toBeNull();
    expect(isRedirectWrapperUrl(raw)).toBe(true);
  });

  const BROKEN_CASES = [
    ['google-url', 'https://www.google.com/url?q=javascript%3Aalert(1)'],
    ['google-url', 'https://www.google.com/url?q='],
    ['google-goto', 'https://google.com/goto?url=data%3Atext%2Fhtml%2C%3Ch1%3Ehi%3C%2Fh1%3E'],
    ['google-goto', 'https://google.com/goto?url='],
    ['bing-ck', 'https://www.bing.com/ck/a?u=a1!!!not-base64!!!'],
    ['bing-ck', 'https://www.bing.com/ck/a?u='],
    ['ddg-l', 'https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)'],
    ['ddg-l', 'https://duckduckgo.com/l/?uddg='],
  ];

  it.each(BROKEN_CASES)('drops the broken %s wrapper: %s', (id, raw) => {
    const result = unwrapRedirectUrl(raw);
    expect(result.status).toBe('dropped');
    expect(result.wrapper).toBe(id);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
    // A dropped wrapper is still a RECOGNISED wrapper shape.
    expect(isRedirectWrapperUrl(raw)).toBe(true);
  });

  const MISSING_PARAM_CASES = [
    'https://www.google.com/url',
    'https://www.google.com/url?sa=U',
    'https://google.com/goto',
    'https://www.bing.com/ck/a',
    'https://www.bing.com/ck/a?ntb=1',
    'https://duckduckgo.com/l/',
  ];

  it.each(MISSING_PARAM_CASES)('a wrapper path WITHOUT its parameter stays plain: %s', (raw) => {
    const result = unwrapRedirectUrl(raw);
    expect(result.status).toBe('plain');
    expect(result.url).toBe(raw);
    expect(result.wrapper).toBeNull();
    expect(isRedirectWrapperUrl(raw)).toBe(false);
  });

  const LOOKALIKE_CASES = [
    'https://google.com/search?q=https%3A%2F%2Fexample.com%2F',
    'https://www.google.com/search?q=test',
    'https://example.com/url?q=https%3A%2F%2Fexample.org%2F',
    'https://www.google.com/urlx?q=https%3A%2F%2Fexample.org%2F',
    'https://www.bing.com/search?q=test',
    'https://bing.com/ck/b?u=a1abc',
    'https://duckduckgo.com/?q=test',
    'https://example.com/goto?url=https%3A%2F%2Fexample.org%2F',
    'https://example.com/page?id=2',
    'https://example.com/page?id=3',
  ];

  it.each(LOOKALIKE_CASES)('a look-alike URL is NOT a wrapper and stays byte-for-byte: %s', (raw) => {
    const result = unwrapRedirectUrl(raw);
    expect(result.status).toBe('plain');
    expect(result.url).toBe(raw);
    expect(result.wrapper).toBeNull();
    expect(result.reason).toBeNull();
    expect(isRedirectWrapperUrl(raw)).toBe(false);
  });
});

describe('redirect-unwrap — security and boundary cases', () => {
  it('unwraps a protocol-relative wrapper to an https target', () => {
    const result = unwrapRedirectUrl('//google.com/goto?url=https%3A%2F%2Fexample.com%2Frel');
    expect(result.status).toBe('unwrapped');
    expect(result.url).toBe('https://example.com/rel');
    const ddg = unwrapRedirectUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Frel');
    expect(ddg.status).toBe('unwrapped');
    expect(ddg.url).toBe('https://example.net/rel');
  });

  it('unwraps goto?url= carrying a raw (unencoded) target', () => {
    const result = unwrapRedirectUrl('https://google.com/goto?url=https://www.apple.com/');
    expect(result.status).toBe('unwrapped');
    expect(result.url).toBe('https://www.apple.com/');
  });

  it('unwraps a double percent-encoded url?q= value (one pass + one fallback)', () => {
    const result = unwrapRedirectUrl('https://www.google.com/url?q=https%253A%252F%252Fexample.com%252Fdouble');
    expect(result.status).toBe('unwrapped');
    expect(result.url).toBe('https://example.com/double');
  });

  it('drops an empty parameter value', () => {
    const result = unwrapRedirectUrl('https://www.google.com/url?q=');
    expect(result.status).toBe('dropped');
    expect(result.wrapper).toBe('google-url');
  });

  it('drops a Bing u= value that is not base64', () => {
    const result = unwrapRedirectUrl('https://www.bing.com/ck/a?u=a1!!!not-base64!!!');
    expect(result.status).toBe('dropped');
    expect(result.wrapper).toBe('bing-ck');
  });

  it('accepts a Bing base64 target WITHOUT the a1 prefix (prefix is optional)', () => {
    const target = 'https://example.org/no-prefix';
    const result = unwrapRedirectUrl(`https://www.bing.com/ck/a?u=${b64url(target)}`);
    expect(result.status).toBe('unwrapped');
    expect(result.url).toBe(target);
  });

  it('drops a javascript: target carried in the parameter', () => {
    for (const raw of [
      'https://google.com/goto?url=javascript%3Aalert(1)',
      'https://google.com/goto?url=javascript:alert(1)',
    ]) {
      const result = unwrapRedirectUrl(raw);
      expect(result.status).toBe('dropped');
    }
  });

  it('drops data:, vbscript:, file: and about: targets', () => {
    for (const scheme of ['data:text/html,hi', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'about:blank']) {
      const raw = `https://www.google.com/url?q=${encodeURIComponent(scheme)}`;
      const result = unwrapRedirectUrl(raw);
      expect(result.status).toBe('dropped');
    }
  });

  it('drops a target with embedded credentials (user:pass@host)', () => {
    const result = unwrapRedirectUrl('https://www.google.com/url?q=https%3A%2F%2Fuser%3Apass%40example.com%2Fx');
    expect(result.status).toBe('dropped');
    expect(result.wrapper).toBe('google-url');
  });

  it('drops a target longer than 2048 characters', () => {
    const longTarget = `https://example.com/${'a'.repeat(2100)}`;
    const result = unwrapRedirectUrl(`https://google.com/goto?url=${encodeURIComponent(longTarget)}`);
    expect(result.status).toBe('dropped');
    // A target of exactly 2048 characters is still acceptable.
    const edgeTarget = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
    expect(edgeTarget.length).toBe(2048);
    const edge = unwrapRedirectUrl(`https://google.com/goto?url=${encodeURIComponent(edgeTarget)}`);
    expect(edge.status).toBe('unwrapped');
    expect(edge.url).toBe(edgeTarget);
  });

  it('unwraps two nested wrapper levels down to the final target', () => {
    const target = 'https://example.com/final';
    const inner = `https://www.google.com/url?q=${encodeURIComponent(target)}`;
    const outer = `https://google.com/goto?url=${encodeURIComponent(inner)}`;
    const result = unwrapRedirectUrl(outer);
    expect(result.status).toBe('unwrapped');
    expect(result.url).toBe(target);
    expect(result.wrapper).toBe('google-goto');
  });

  it('drops a three-level nesting (depth limit is 2)', () => {
    const target = 'https://example.com/too-deep';
    const level1 = `https://www.google.com/url?q=${encodeURIComponent(target)}`;
    const level2 = `https://google.com/goto?url=${encodeURIComponent(level1)}`;
    const level3 = `https://www.bing.com/ck/a?u=a1${b64url(level2)}`;
    const result = unwrapRedirectUrl(level3);
    expect(result.status).toBe('dropped');
  });

  it('is idempotent: an unwrapped target passed again stays plain and unchanged', () => {
    const first = unwrapRedirectUrl('https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Fone');
    expect(first.status).toBe('unwrapped');
    const second = unwrapRedirectUrl(first.url);
    expect(second.status).toBe('plain');
    expect(second.url).toBe(first.url);
  });

  it('leaves an ordinary link byte-for-byte untouched (query included)', () => {
    const raw = 'https://example.com/page?id=2#frag';
    const result = unwrapRedirectUrl(raw);
    expect(result.status).toBe('plain');
    expect(result.url).toBe(raw);
  });

  it('treats empty and non-string input as plain without throwing', () => {
    expect(unwrapRedirectUrl('').status).toBe('plain');
    expect(unwrapRedirectUrl(null).status).toBe('plain');
    expect(unwrapRedirectUrl(undefined).status).toBe('plain');
    expect(unwrapRedirectUrl(42).status).toBe('plain');
    expect(isRedirectWrapperUrl('')).toBe(false);
    expect(isRedirectWrapperUrl(null)).toBe(false);
  });

  it('does not recognise an unparseable URL as a wrapper', () => {
    const result = unwrapRedirectUrl('not a url at all');
    expect(result.status).toBe('plain');
    expect(result.url).toBe('not a url at all');
  });
});

describe('redirect-unwrap — DuckDuckGo legacy semantics preserved', () => {
  // The legacy parser searches `uddg=` as a SUBSTRING, accepts protocol-
  // relative hrefs, and returns '' for anything non-http(s). These pins are
  // the exact behaviour of duckduckgo.mjs on the base candidate.
  const LEGACY_CASES = [
    ['//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone', 'https://example.com/one'],
    ['uddg=https%3A%2F%2Fexample.com%2Ftwo', 'https://example.com/two'],
    ['https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=abc', 'https://example.com/'],
    ['https://example.org/two', 'https://example.org/two'],
    ['//example.com/path', 'https://example.com/path'],
    ['  https://example.org/trimmed  ', 'https://example.org/trimmed'],
    ['javascript:alert(1)', ''],
    ['uddg=javascript%3Aalert(1)', ''],
    ['uddg=%E0%A4%A', ''],
    ['', ''],
  ];

  it.each(LEGACY_CASES)('legacy unwrap(%j) → %j', (href, expected) => {
    expect(unwrapDuckDuckGoUrl(href)).toBe(expected);
  });

  it('returns empty string for null / non-string input', () => {
    expect(unwrapDuckDuckGoUrl(null)).toBe('');
    expect(unwrapDuckDuckGoUrl(undefined)).toBe('');
    expect(unwrapDuckDuckGoUrl(42)).toBe('');
  });

  it('keeps the legacy lenient shape: an http(s) target with credentials is returned as-is', () => {
    // The STRICT policy (drop credentials) applies to the wrapper rule table;
    // the legacy DDG helper keeps its base semantics verbatim — changing it
    // would break the opt-in backend contract.
    expect(unwrapDuckDuckGoUrl('uddg=https%3A%2F%2Fuser%3Apass%40example.com%2F'))
      .toBe('https://user:pass@example.com/');
  });

  it('duckduckgo.mjs keeps exporting the same helper (public path unchanged)', async () => {
    const ddg = await import('../../server/lib/web-search/duckduckgo.mjs');
    expect(typeof ddg.unwrapDuckDuckGoUrl).toBe('function');
    expect(ddg.unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone'))
      .toBe('https://example.com/one');
    expect(ddg.unwrapDuckDuckGoUrl('javascript:alert(1)')).toBe('');
  });
});
