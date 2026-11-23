/**
 * Masked ProviderConfig storage API (docs/security.md §3).
 *
 * Contract under test (server/lib/providers.mjs storage functions):
 *   - listProviderDescriptors(): exactly the 4 registry kinds in order, each
 *     PUBLIC (no apiKey value anywhere in the shape) merged with its DB row;
 *   - saveProviderConfig(kind, patch): upsert by kind; apiKey is write-only
 *     (absent = keep, clearApiKey = drop); models tiers + cover round-trip;
 *     enabling a provider disables every other row (single active provider);
 *     validation errors are typed (unknown kind, custom without baseUrl);
 *   - getProviderDescriptor(kind): server-side INTERNAL descriptor (baseUrl
 *     + resolved key + keyOptional + models) for probe/catalog wiring —
 *     never sent to clients by the routes.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

const providers = await import('../../server/lib/providers.mjs');

const ENV_KEYS = [
  'ROUTERAI_API_KEY',
  'ROUTERAI_ENDPOINT',
  'ROUTERAI_MODEL_CRITICAL',
  'ROUTERAI_MODEL_GENERATION',
  'ROUTERAI_MODEL_STANDARD',
  'OPENROUTER_API_KEY',
  'OLLAMA_API_KEY',
  'CUSTOM_API_KEY',
];

beforeEach(async () => {
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
  await prisma.providerConfig.deleteMany();
});

afterEach(async () => {
  await prisma.providerConfig.deleteMany();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
  const { prisma: sharedPrisma } = await import('../../server/db.mjs');
  await sharedPrisma.$disconnect();
});

describe('listProviderDescriptors — masked read of all 4 kinds', () => {
  it('returns exactly the 4 registry kinds in order, never an apiKey value', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'openrouter', apiKey: 'sk-openrouter-local-secret', enabled: true },
    });

    const list = await providers.listProviderDescriptors();

    expect(list.map((p) => p.kind)).toEqual(['routerai', 'openrouter', 'ollama', 'custom']);
    expect(JSON.stringify(list)).not.toContain('sk-openrouter-local-secret');
    const openrouter = list.find((p) => p.kind === 'openrouter');
    expect(openrouter.keyConfigured).toBe(true);
    expect(openrouter.keySource).toBe('local');
    expect(openrouter.enabled).toBe(true);
    // The untouched kinds carry their registry defaults.
    expect(list.find((p) => p.kind === 'routerai').baseUrl).toBe('https://routerai.ru/api/v1');
  });

  it('keySource env when the env var wins over the local store (D10)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-openrouter-env-secret');
    await prisma.providerConfig.create({
      data: { kind: 'openrouter', apiKey: 'sk-openrouter-local-secret', enabled: false },
    });

    const list = await providers.listProviderDescriptors();
    const openrouter = list.find((p) => p.kind === 'openrouter');

    expect(openrouter.keySource).toBe('env');
    expect(openrouter.keyConfigured).toBe(true);
    expect(JSON.stringify(list)).not.toContain('sk-openrouter-env-secret');
    expect(JSON.stringify(list)).not.toContain('sk-openrouter-local-secret');
  });
});

describe('saveProviderConfig — masked write path', () => {
  it('creates a custom provider row (baseUrl + key + tier/cover models) and returns the PUBLIC shape', async () => {
    const saved = await providers.saveProviderConfig('custom', {
      baseUrl: 'https://example.com/v1/',
      apiKey: 'sk-custom-local-secret',
      enabled: true,
      models: { critical: 'm-crit', generation: 'm-gen', standard: 'm-std', cover: 'm-img' },
    });

    expect(saved.kind).toBe('custom');
    expect(saved.baseUrl).toBe('https://example.com/v1'); // trailing slash normalized
    expect(saved.enabled).toBe(true);
    expect(saved.keyConfigured).toBe(true);
    expect(saved.keySource).toBe('local');
    expect(saved.models).toEqual({ critical: 'm-crit', generation: 'm-gen', standard: 'm-std', cover: 'm-img' });
    expect(JSON.stringify(saved)).not.toContain('sk-custom-local-secret');

    const row = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    // SEC-04: the stored key is CIPHERTEXT — the plaintext never reaches the
    // database file (the at-rest proof lives in
    // tests/integration/provider-secret-at-rest.test.mjs).
    expect(row.apiKey).not.toBe('sk-custom-local-secret');
    expect(row.apiKey.startsWith('genr:v1:')).toBe(true);
    expect(JSON.parse(row.modelsJson)).toEqual({ critical: 'm-crit', generation: 'm-gen', standard: 'm-std', cover: 'm-img' });
  });

  it('absent apiKey keeps the stored key; clearApiKey drops it', async () => {
    await providers.saveProviderConfig('custom', {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-keep-me',
    });

    const kept = await providers.saveProviderConfig('custom', { baseUrl: 'https://example.com/v1' });
    expect(kept.keyConfigured).toBe(true);

    const cleared = await providers.saveProviderConfig('custom', { clearApiKey: true });
    expect(cleared.keyConfigured).toBe(false);
    const row = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    expect(row.apiKey).toBeNull();
  });

  it('enabling a provider disables every other row (single active provider)', async () => {
    await providers.saveProviderConfig('custom', { baseUrl: 'https://example.com/v1', apiKey: 'k', enabled: true });
    await providers.saveProviderConfig('ollama', { enabled: true });

    const rows = await prisma.providerConfig.findMany();
    expect(rows.filter((r) => r.enabled)).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'ollama').enabled).toBe(true);
    expect(rows.find((r) => r.kind === 'custom').enabled).toBe(false);
  });

  it('models patch: empty-string tiers are dropped, unknown keys ignored', async () => {
    const saved = await providers.saveProviderConfig('routerai', {
      models: { critical: '  m-crit  ', generation: '', cover: 'm-img', bogus: 'x' },
    });

    expect(saved.models).toEqual({ critical: 'm-crit', cover: 'm-img' });
  });

  it('throws a typed error for an unknown kind', async () => {
    const err = await providers.saveProviderConfig('yandex', {}).catch((e) => e);
    expect(err).toBeInstanceOf(providers.ProviderConfigError);
    expect(err.code).toBe('unknown_provider_kind');
  });

  it('throws a typed error when custom ends up without a baseUrl', async () => {
    const err = await providers.saveProviderConfig('custom', { apiKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(providers.ProviderConfigError);
    expect(err.code).toBe('custom_base_url_required');
  });
});

describe('getProviderDescriptor — server-side internal descriptor', () => {
  it('merges row + env into the internal shape (key value present for server use only)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-openrouter-env-secret');
    await prisma.providerConfig.create({
      data: {
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1/',
        modelsJson: JSON.stringify({ standard: 'm-std' }),
        enabled: true,
      },
    });

    const internal = await providers.getProviderDescriptor('openrouter');

    expect(internal.apiKey).toBe('sk-openrouter-env-secret'); // env wins (D10)
    expect(internal.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(internal.keyOptional).toBe(false);
    expect(internal.models).toEqual({ standard: 'm-std' });
  });

  it('keyless kind works without any key (ollama defaults)', async () => {
    const internal = await providers.getProviderDescriptor('ollama');

    expect(internal.apiKey).toBe('');
    expect(internal.keyOptional).toBe(true);
    expect(internal.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('rejects unknown kinds', async () => {
    const err = await providers.getProviderDescriptor('nope').catch((e) => e);
    expect(err).toBeInstanceOf(providers.ProviderConfigError);
    expect(err.code).toBe('unknown_provider_kind');
  });
});
