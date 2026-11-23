import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_ENV = 'GENERAPTOR_SOURCE_REGISTRY';
const tempDirs = [];

/**
 * Write a registry file for a deployment and return its path.
 * @param {unknown[]} entries
 * @returns {string}
 */
function writeRegistryFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'generaptor-registry-'));
  tempDirs.push(dir);
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  return file;
}

/**
 * Load source-domains with a fresh module graph — the registry is read from
 * the environment at import time.
 * @param {string|null} registryFile
 * @returns {Promise<typeof import('../../server/lib/source-domains.mjs')>}
 */
async function loadSourceDomains(registryFile) {
  if (registryFile) process.env[REGISTRY_ENV] = registryFile;
  else delete process.env[REGISTRY_ENV];
  vi.resetModules();
  return import('../../server/lib/source-domains.mjs');
}

afterEach(() => {
  delete process.env[REGISTRY_ENV];
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ownDomains — default registry is empty (no brands shipped)', () => {
  it('returns an empty list when no registry is configured', async () => {
    const { ownDomains } = await loadSourceDomains(null);
    expect(ownDomains()).toEqual([]);
  });

  it('never leaks a scheme or www prefix', async () => {
    const file = writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }]);
    const { ownDomains } = await loadSourceDomains(file);
    for (const d of ownDomains()) {
      expect(d).not.toMatch(/^https?:\/\//);
      expect(d).not.toMatch(/^www\./);
    }
  });
});

describe('isOwnSiteUrl — empty registry (graceful degradation)', () => {
  it('returns false for every url when nothing is registered', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(null);
    expect(isOwnSiteUrl('https://example.com/services/x')).toBe(false);
    expect(isOwnSiteUrl('https://www.example.com/')).toBe(false);
  });

  it('returns false for an invalid url', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(null);
    expect(isOwnSiteUrl('not-a-url')).toBe(false);
    expect(isOwnSiteUrl('://no-host')).toBe(false);
  });

  it('returns false for empty / null / undefined / non-string input', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(null);
    expect(isOwnSiteUrl('')).toBe(false);
    expect(isOwnSiteUrl(null)).toBe(false);
    expect(isOwnSiteUrl(undefined)).toBe(false);
    expect(isOwnSiteUrl(123)).toBe(false);
    expect(isOwnSiteUrl({ href: 'https://example.com' })).toBe(false);
    expect(isOwnSiteUrl(['https://example.com'])).toBe(false);
  });
});

describe('isOwnSiteUrl — env-driven registry', () => {
  const registry = [
    { id: 'site', name: 'Example Site', baseUrl: 'https://www.example.com' },
    { id: 'other', name: 'Other Site', baseUrl: 'https://other.example.net' },
  ];

  it('lists the registered hosts (bare, no scheme/www)', async () => {
    const { ownDomains } = await loadSourceDomains(writeRegistryFile(registry));
    expect(ownDomains().sort()).toEqual(['example.com', 'other.example.net']);
  });

  it('matches a registered url with www', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://www.example.com/services/x')).toBe(true);
  });

  it('matches a registered url without www', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://example.com/services/x')).toBe(true);
  });

  it('matches the home url and http (non-https) urls', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://www.example.com/')).toBe(true);
    expect(isOwnSiteUrl('http://www.example.com/')).toBe(true);
  });

  it('matches an uppercase host', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://WWW.EXAMPLE.COM/services/x')).toBe(true);
  });

  it('returns false for an external domain', async () => {
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://example.org/12345/')).toBe(false);
  });

  it('returns false for a look-alike domain (not a suffix match)', async () => {
    // evil-example.com must NOT be treated as own — host equality, not suffix.
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://evil-example.com/x')).toBe(false);
    expect(isOwnSiteUrl('https://example.com.evil.com/x')).toBe(false);
  });

  it('returns false for a subdomain that is not the bare registered host', async () => {
    // blog.example.com is a different host; only the registered own hosts match.
    // (We match exact host equality after stripping www, to avoid spoofing.)
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://blog.example.com/x')).toBe(false);
  });

  it('ignores the optional sourceSiteId argument (matches registry anyway)', async () => {
    // sourceSiteId is accepted for API symmetry but the registry is the source
    // of truth, so a matching url is still detected regardless of the arg.
    const { isOwnSiteUrl } = await loadSourceDomains(writeRegistryFile(registry));
    expect(isOwnSiteUrl('https://example.com/', 'site')).toBe(true);
    expect(isOwnSiteUrl('https://example.com/', 'other')).toBe(true);
    expect(isOwnSiteUrl('https://example.com/', undefined)).toBe(true);
  });
});

describe('source registry — broken configuration degrades gracefully', () => {
  it('falls back to an empty registry when the file is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ownDomains, isOwnSiteUrl } = await loadSourceDomains(
      join(tmpdir(), 'generaptor-registry-does-not-exist.json')
    );
    expect(ownDomains()).toEqual([]);
    expect(isOwnSiteUrl('https://example.com/')).toBe(false);
    warn.mockRestore();
  });

  it('falls back to an empty registry when the file is not valid json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generaptor-registry-'));
    tempDirs.push(dir);
    const file = join(dir, 'registry.json');
    writeFileSync(file, '{ not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ownDomains } = await loadSourceDomains(file);
    expect(ownDomains()).toEqual([]);
    warn.mockRestore();
  });

  it('drops entries without id or baseUrl', async () => {
    const { ownDomains } = await loadSourceDomains(
      writeRegistryFile([
        { id: 'good', baseUrl: 'https://good.example.com' },
        { name: 'no id', baseUrl: 'https://noid.example.com' },
        { id: 'no-base-url' },
      ])
    );
    expect(ownDomains()).toEqual(['good.example.com']);
  });
});
