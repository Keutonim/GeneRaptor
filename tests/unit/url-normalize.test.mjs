import { describe, it, expect } from 'vitest';
import { canonicalSignature } from '../../server/lib/url-normalize.mjs';

describe('canonicalSignature', () => {
  it('strips a trailing slash from the path', () => {
    expect(canonicalSignature('https://site.ru/foo/')).toBe(
      'https://site.ru/foo'
    );
  });

  it('strips the www. prefix', () => {
    expect(canonicalSignature('https://www.site.ru/foo')).toBe(
      'https://site.ru/foo'
    );
  });

  it('lowercases the host', () => {
    expect(canonicalSignature('https://SITE.ru/foo')).toBe('https://site.ru/foo');
  });

  it('treats www / trailing-slash / uppercase host variants as the same page', () => {
    // The three shapes called out in the plan must collapse to one signature.
    const a = canonicalSignature('https://site.ru/x/');
    const b = canonicalSignature('https://www.site.ru/x');
    const c = canonicalSignature('https://SITE.ru/x');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe('https://site.ru/x');
  });

  it('removes the query string', () => {
    expect(canonicalSignature('https://site.ru/foo?bar=1&baz=2')).toBe(
      'https://site.ru/foo'
    );
  });

  it('removes the fragment', () => {
    expect(canonicalSignature('https://site.ru/foo#section')).toBe(
      'https://site.ru/foo'
    );
  });

  it('removes both query and fragment', () => {
    expect(canonicalSignature('https://site.ru/foo?a=1#frag')).toBe(
      'https://site.ru/foo'
    );
  });

  it('forces the https protocol', () => {
    expect(canonicalSignature('http://site.ru/foo')).toBe('https://site.ru/foo');
  });

  it('forces https even with www + trailing slash', () => {
    expect(canonicalSignature('http://www.site.ru/foo/')).toBe(
      'https://site.ru/foo'
    );
  });

  it('returns the same value for an already-canonical url (idempotent)', () => {
    const canonical = 'https://site.ru/foo/bar';
    expect(canonicalSignature(canonical)).toBe(canonical);
  });

  it('normalizes a bare root url', () => {
    expect(canonicalSignature('https://site.ru/')).toBe('https://site.ru');
    expect(canonicalSignature('https://www.site.ru')).toBe('https://site.ru');
  });

  it('preserves the path case (only host is lowercased)', () => {
    // Path segments are NOT lowercased — /CaseA and /casea are different pages
    // on many servers. Only the host is case-insensitive.
    expect(canonicalSignature('https://site.ru/FooBar')).toBe(
      'https://site.ru/FooBar'
    );
  });

  it('returns empty string for empty input', () => {
    expect(canonicalSignature('')).toBe('');
  });

  it('returns empty string for null/undefined input', () => {
    expect(canonicalSignature(null)).toBe('');
    expect(canonicalSignature(undefined)).toBe('');
  });

  it('returns empty string for a non-string input', () => {
    expect(canonicalSignature(123)).toBe('');
    expect(canonicalSignature({ href: 'https://site.ru' })).toBe('');
  });

  it('returns empty string for an invalid url', () => {
    expect(canonicalSignature('not-a-url')).toBe('');
    expect(canonicalSignature('://no-host')).toBe('');
  });

  it('strips multiple trailing slashes', () => {
    expect(canonicalSignature('https://site.ru/foo//')).toBe(
      'https://site.ru/foo'
    );
  });

  it('handles a url with port (keeps the port)', () => {
    expect(canonicalSignature('https://site.ru:8080/foo/')).toBe(
      'https://site.ru:8080/foo'
    );
  });
});
