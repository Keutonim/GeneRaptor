import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderResearchSourcesBlock, EVIDENCE_LEVELS } from '../../server/lib/research-source.mjs';

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
 * Load research-source with a fresh module graph — the source registry is read
 * from the environment at import time.
 * @param {string|null} registryFile
 * @returns {Promise<typeof import('../../server/lib/research-source.mjs')>}
 */
async function loadResearchSource(registryFile) {
  if (registryFile) process.env[REGISTRY_ENV] = registryFile;
  else delete process.env[REGISTRY_ENV];
  vi.resetModules();
  return import('../../server/lib/research-source.mjs');
}

afterEach(() => {
  delete process.env[REGISTRY_ENV];
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('normalizeResearchSource — own-site promotion (A2)', () => {
  it('does NOT promote a url when the registry is empty (default deployment)', async () => {
    const { normalizeResearchSource } = await loadResearchSource(null);
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://www.example.com/services/botulinoterapiya',
      title: 'Ботулинотерапия',
      evidenceLevel: 'medium',
    });
    expect(s.evidenceLevel).toBe('medium');
    expect(s.metadata?.isOwn).toBeFalsy();
  });

  it('promotes a registered url to evidenceLevel "canon"', async () => {
    const { normalizeResearchSource } = await loadResearchSource(
      writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }])
    );
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://www.example.com/services/botulinoterapiya',
      title: 'Ботулинотерапия',
      evidenceLevel: 'medium',
    });
    expect(s.evidenceLevel).toBe('canon');
  });

  it('promotes a registered url to evidenceLevel "canon" even if it came as "low"', async () => {
    const { normalizeResearchSource } = await loadResearchSource(
      writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }])
    );
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://example.com/doctors/ivanov',
      title: 'Иванов',
      evidenceLevel: 'low',
    });
    expect(s.evidenceLevel).toBe('canon');
  });

  it('sets metadata.isOwn = true for a registered url', async () => {
    const { normalizeResearchSource } = await loadResearchSource(
      writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }])
    );
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://example.com/',
      title: 'Главная',
      evidenceLevel: 'medium',
    });
    expect(s.metadata).toBeTruthy();
    expect(s.metadata.isOwn).toBe(true);
  });

  it('does NOT promote a look-alike host (anti-spoofing)', async () => {
    const { normalizeResearchSource } = await loadResearchSource(
      writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }])
    );
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://evil-example.com/services/x',
      title: 'X',
      evidenceLevel: 'medium',
    });
    expect(s.evidenceLevel).toBe('medium');
    expect(s.metadata?.isOwn).toBeFalsy();
  });

  it('does NOT promote an external url (keeps the given evidenceLevel)', async () => {
    const { normalizeResearchSource } = await loadResearchSource(null);
    const s = normalizeResearchSource({
      provider: 'duckduckgo',
      url: 'https://example.org/12345/',
      title: 'Study',
      evidenceLevel: 'high',
    });
    expect(s.evidenceLevel).toBe('high');
    expect(s.metadata?.isOwn).toBeFalsy();
  });

  it('preserves caller-supplied metadata and merges isOwn into it', async () => {
    const { normalizeResearchSource } = await loadResearchSource(
      writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }])
    );
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://www.example.com/x',
      title: 'X',
      evidenceLevel: 'medium',
      metadata: { pmid: '999', foo: 'bar' },
    });
    expect(s.metadata.isOwn).toBe(true);
    expect(s.metadata.pmid).toBe('999');
    expect(s.metadata.foo).toBe('bar');
  });

  it('leaves metadata null for a non-own external url when none was supplied', async () => {
    const { normalizeResearchSource } = await loadResearchSource(null);
    const s = normalizeResearchSource({
      provider: 'duckduckgo',
      url: 'https://example.org/1',
      title: 'T',
      evidenceLevel: 'high',
    });
    expect(s.metadata).toBeNull();
  });

  it('still normalizes the url for a registered source', async () => {
    const { normalizeResearchSource } = await loadResearchSource(
      writeRegistryFile([{ id: 'site', baseUrl: 'https://www.example.com' }])
    );
    const s = normalizeResearchSource({
      provider: 'yandex',
      url: 'https://www.example.com/services/x/',
      title: 'X',
      evidenceLevel: 'medium',
    });
    expect(s.normalizedUrl).toBe('https://example.com/services/x');
  });
});

describe('normalizeResearchSource — validation', () => {
  it('throws on an unknown provider', async () => {
    const { normalizeResearchSource } = await loadResearchSource(null);
    expect(() =>
      normalizeResearchSource({ provider: 'bogus', url: 'https://x', evidenceLevel: 'medium' })
    ).toThrow(/provider/);
  });

  it('throws on an unknown evidenceLevel', async () => {
    const { normalizeResearchSource } = await loadResearchSource(null);
    expect(() =>
      normalizeResearchSource({ provider: 'yandex', url: 'https://x', evidenceLevel: 'bogus' })
    ).toThrow(/evidenceLevel/);
  });

  it('includes "canon" in the allowed evidence levels', () => {
    expect(EVIDENCE_LEVELS).toContain('canon');
  });
});

describe('renderResearchSourcesBlock — canon prioritization (A2)', () => {
  it('orders canon sources above high/medium/low', () => {
    const block = renderResearchSourcesBlock([
      {
        provider: 'duckduckgo',
        evidenceLevel: 'high',
        title: 'HighStudy',
        sourceUrl: 'https://example.org/1',
        extractedText: 'hi',
      },
      {
        provider: 'yandex',
        evidenceLevel: 'canon',
        title: 'OurSite',
        sourceUrl: 'https://example.com/x',
        extractedText: 'ours',
      },
      {
        provider: 'duckduckgo',
        evidenceLevel: 'medium',
        title: 'MedStudy',
        sourceUrl: 'https://example.org/2',
        extractedText: 'med',
      },
    ]);
    // The canon (own-site) source must appear before the high and medium ones.
    const canonIdx = block.indexOf('OurSite');
    const highIdx = block.indexOf('HighStudy');
    const medIdx = block.indexOf('MedStudy');
    expect(canonIdx).toBeGreaterThanOrEqual(0);
    expect(canonIdx).toBeLessThan(highIdx);
    expect(canonIdx).toBeLessThan(medIdx);
  });

  it('renders a YANDEX/CANON line for an own-site source', () => {
    const block = renderResearchSourcesBlock([
      {
        provider: 'yandex',
        evidenceLevel: 'canon',
        title: 'Наша услуга',
        sourceUrl: 'https://example.com/services/x',
        extractedText: 'desc',
      },
    ]);
    expect(block).toMatch(/YANDEX\/CANON/);
  });

  it('returns empty string for an empty list', () => {
    expect(renderResearchSourcesBlock([])).toBe('');
    expect(renderResearchSourcesBlock(null)).toBe('');
    expect(renderResearchSourcesBlock(undefined)).toBe('');
  });
});
