import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_ENV = 'GENERAPTOR_SOURCE_REGISTRY';
const tempDirs = [];

/**
 * Write a registry file for a deployment and return its path.
 * @param {unknown} content
 * @returns {string}
 */
function writeRegistryFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'generaptor-registry-'));
  tempDirs.push(dir);
  const file = join(dir, 'registry.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

/**
 * Load source-registry with a fresh module graph — the registry is read from
 * the environment at import time.
 * @param {string|null} registryFile
 * @returns {Promise<typeof import('../../server/source-registry.mjs')>}
 */
async function loadSourceRegistry(registryFile) {
  if (registryFile) process.env[REGISTRY_ENV] = registryFile;
  else delete process.env[REGISTRY_ENV];
  vi.resetModules();
  return import('../../server/source-registry.mjs');
}

afterEach(() => {
  delete process.env[REGISTRY_ENV];
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('source registry — ships ZERO default sites (no brand in the open-source build)', () => {
  it('exposes the env var name of the mechanism', async () => {
    const { SOURCE_REGISTRY_ENV } = await loadSourceRegistry(null);
    expect(SOURCE_REGISTRY_ENV).toBe('GENERAPTOR_SOURCE_REGISTRY');
  });

  it('is empty when no registry file is configured', async () => {
    const { sourceRegistry } = await loadSourceRegistry(null);
    expect(sourceRegistry).toEqual([]);
  });

  it('getSourceById returns null for every id while the registry is empty', async () => {
    const { getSourceById } = await loadSourceRegistry(null);
    expect(getSourceById('anything')).toBeNull();
  });
});

describe('source registry — env-driven mechanism (KEPT)', () => {
  it('loads the sites of the deployment from the registry file', async () => {
    const { sourceRegistry, getSourceById } = await loadSourceRegistry(
      writeRegistryFile([
        {
          id: 'site',
          name: 'Example Site',
          baseUrl: 'https://www.example.com',
          doctorsIndex: 'https://www.example.com/doctors/',
          servicesIndex: 'https://www.example.com/services/',
          prices: 'https://www.example.com/prices/',
          llms: 'https://www.example.com/llms.txt',
          sitemap: 'https://www.example.com/sitemap.xml',
        },
      ])
    );
    expect(sourceRegistry).toHaveLength(1);
    expect(sourceRegistry[0].id).toBe('site');
    expect(sourceRegistry[0].name).toBe('Example Site');
    expect(getSourceById('site')?.baseUrl).toBe('https://www.example.com');
    expect(getSourceById('missing')).toBeNull();
  });

  it('builds the core links of a site from its index urls', async () => {
    const { sourceRegistry } = await loadSourceRegistry(
      writeRegistryFile([
        {
          id: 'site',
          baseUrl: 'https://example.com',
          doctorsIndex: 'https://example.com/doctors/',
          servicesIndex: 'https://example.com/services/',
        },
      ])
    );
    const urls = sourceRegistry[0].core.map((l) => l.url);
    expect(urls).toContain('https://example.com');
    expect(urls).toContain('https://example.com/doctors/');
    expect(urls).toContain('https://example.com/services/');
    expect(urls).not.toContain(undefined);
  });

  it('keeps an explicit core link list', async () => {
    const { sourceRegistry } = await loadSourceRegistry(
      writeRegistryFile([
        {
          id: 'site',
          baseUrl: 'https://example.com',
          core: [{ kind: 'custom', label: 'Custom', url: 'https://example.com/custom' }],
        },
      ])
    );
    expect(sourceRegistry[0].core).toHaveLength(1);
    expect(sourceRegistry[0].core[0].url).toBe('https://example.com/custom');
  });

  it('accepts the { sites: [...] } wrapper shape', async () => {
    const { sourceRegistry } = await loadSourceRegistry(
      writeRegistryFile({ sites: [{ id: 'site', baseUrl: 'https://example.com' }] })
    );
    expect(sourceRegistry).toHaveLength(1);
  });
});

describe('source registry — graceful degradation', () => {
  it('falls back to an empty registry when the file is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sourceRegistry } = await loadSourceRegistry(
      join(tmpdir(), 'generaptor-registry-missing.json')
    );
    expect(sourceRegistry).toEqual([]);
    warn.mockRestore();
  });

  it('falls back to an empty registry when the file is broken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sourceRegistry } = await loadSourceRegistry(writeRegistryFile('{ broken'));
    expect(sourceRegistry).toEqual([]);
    warn.mockRestore();
  });

  it('drops entries without id or baseUrl', async () => {
    const { sourceRegistry } = await loadSourceRegistry(
      writeRegistryFile([
        { id: 'good', baseUrl: 'https://example.com' },
        { name: 'no id', baseUrl: 'https://noid.example.com' },
        { id: 'no-base-url' },
        null,
      ])
    );
    expect(sourceRegistry).toHaveLength(1);
    expect(sourceRegistry[0].id).toBe('good');
  });
});
