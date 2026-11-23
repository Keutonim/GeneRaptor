/**
 * Provider registry + ProviderConfig resolution.
 *
 * Contract under test (server/lib/providers.mjs):
 *   - PROVIDER_REGISTRY exposes exactly 4 kinds (routerai/openrouter/ollama/
 *     custom) with default base URLs, env keys and the D9 images capability
 *     (routerai 'yes', ollama 'no', openrouter/custom 'unknown');
 *   - key resolution: env wins over the local store (D10), local used when
 *     env absent, none when both absent — the value NEVER leaks into
 *     descriptors returned to clients (masked shape);
 *   - modelsJson parses into {critical,generation,standard,cover};
 *   - resolveActiveProvider: enabled row wins; switching the enabled row
 *     changes the resolution (M3 AC, unit); env fallback (ROUTERAI_API_KEY)
 *     applies headless when no row is enabled; null when nothing at all;
 *   - resolveCoverProvider (D9): only images-capable providers may serve
 *     covers; otherwise an honest machine code, never a silent fallback.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

const providers = await import('../../server/lib/providers.mjs');

beforeEach(async () => {
  // The vitest config injects ROUTERAI_API_KEY globally; neutralize every
  // provider env per test so each case controls its own env reality.
  for (const key of [
    'ROUTERAI_API_KEY',
    'ROUTERAI_ENDPOINT',
    'ROUTERAI_MODEL_CRITICAL',
    'ROUTERAI_MODEL_GENERATION',
    'ROUTERAI_MODEL_STANDARD',
    'OPENROUTER_API_KEY',
    'OLLAMA_API_KEY',
    'CUSTOM_API_KEY',
    'GENERAPTOR_ALLOW_PRIVATE_NETWORK',
  ]) {
    vi.stubEnv(key, '');
  }
  // SEC-02: a stored loopback endpoint is denied by default; these cases model
  // the operator who explicitly allowed a local gateway.
  vi.stubEnv('GENERAPTOR_ALLOW_PRIVATE_NETWORK', 'true');
  await prisma.providerConfig.deleteMany();
});

afterEach(async () => {
  await prisma.providerConfig.deleteMany();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
  // Release the shared SQLite handle (providers.mjs lazy-imports db.mjs) so
  // the global-setup temp dir teardown does not hit a Windows file lock.
  const { prisma: sharedPrisma } = await import('../../server/db.mjs');
  await sharedPrisma.$disconnect();
});

describe('PROVIDER_REGISTRY — 4 kinds with defaults and D9 capability', () => {
  it('exposes exactly routerai/openrouter/ollama/custom', () => {
    expect(providers.PROVIDER_KINDS).toEqual(['routerai', 'openrouter', 'ollama', 'custom']);
  });

  it('carries the documented default base URLs and env keys', () => {
    expect(providers.PROVIDER_REGISTRY.routerai.defaultBaseUrl).toBe('https://routerai.ru/api/v1');
    expect(providers.PROVIDER_REGISTRY.routerai.envKey).toBe('ROUTERAI_API_KEY');
    expect(providers.PROVIDER_REGISTRY.openrouter.defaultBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(providers.PROVIDER_REGISTRY.openrouter.envKey).toBe('OPENROUTER_API_KEY');
    expect(providers.PROVIDER_REGISTRY.ollama.defaultBaseUrl).toBe('http://localhost:11434/v1');
    expect(providers.PROVIDER_REGISTRY.ollama.keyOptional).toBe(true);
  });

  it('D9: routerai images yes, ollama no, openrouter/custom unknown', () => {
    expect(providers.PROVIDER_REGISTRY.routerai.imagesCapability).toBe('yes');
    expect(providers.PROVIDER_REGISTRY.ollama.imagesCapability).toBe('no');
    expect(providers.PROVIDER_REGISTRY.openrouter.imagesCapability).toBe('unknown');
    expect(providers.PROVIDER_REGISTRY.custom.imagesCapability).toBe('unknown');
  });
});

describe('parseProviderModels', () => {
  it('parses tier + cover model assignments', () => {
    const models = providers.parseProviderModels(
      JSON.stringify({ critical: 'm-crit', generation: 'm-gen', standard: 'm-std', cover: 'm-cover' }),
    );
    expect(models).toEqual({ critical: 'm-crit', generation: 'm-gen', standard: 'm-std', cover: 'm-cover' });
  });

  it('returns empty shape for null/garbage json and drops non-string values', () => {
    expect(providers.parseProviderModels(null)).toEqual({});
    expect(providers.parseProviderModels('not json')).toEqual({});
    expect(providers.parseProviderModels(JSON.stringify({ critical: 42, cover: 'ok' }))).toEqual({ cover: 'ok' });
  });
});

describe('resolveProviderKey — env wins over local store (D10)', () => {
  it('env value wins when present', () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'env-secret');
    const resolved = providers.resolveProviderKey('routerai', { apiKey: 'local-secret' });
    expect(resolved).toEqual({ value: 'env-secret', source: 'env' });
  });

  it('local store used when env absent', () => {
    const resolved = providers.resolveProviderKey('routerai', { apiKey: 'local-secret' });
    expect(resolved).toEqual({ value: 'local-secret', source: 'local' });
  });

  it('none when both absent', () => {
    expect(providers.resolveProviderKey('routerai', {})).toEqual({ value: '', source: 'none' });
    expect(providers.resolveProviderKey('routerai', null)).toEqual({ value: '', source: 'none' });
  });
});

describe('resolveActiveProvider', () => {
  it('enabled row wins over env fallback and carries local key + models', async () => {
    await prisma.providerConfig.create({
      data: {
        kind: 'custom',
        baseUrl: 'http://127.0.0.1:9101/v1',
        apiKey: 'custom-local-secret',
        enabled: true,
        modelsJson: JSON.stringify({ critical: 'fake-critical', generation: 'fake-gen', standard: 'fake-std' }),
      },
    });

    const provider = await providers.resolveActiveProvider();
    expect(provider.kind).toBe('custom');
    expect(provider.baseUrl).toBe('http://127.0.0.1:9101/v1');
    expect(provider.apiKey).toBe('custom-local-secret');
    expect(provider.keySource).toBe('local');
    expect(provider.models.critical).toBe('fake-critical');
  });

  it('switching the enabled provider changes resolution (M3 AC)', async () => {
    const custom = await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: 'http://127.0.0.1:9101/v1', apiKey: 'k1', enabled: true },
    });
    expect((await providers.resolveActiveProvider()).baseUrl).toBe('http://127.0.0.1:9101/v1');

    // Single-active switch (what the route write path performs).
    await prisma.providerConfig.update({ where: { id: custom.id }, data: { enabled: false } });
    await prisma.providerConfig.create({
      data: { kind: 'ollama', baseUrl: 'http://127.0.0.1:9102/v1', enabled: true },
    });

    const switched = await providers.resolveActiveProvider();
    expect(switched.kind).toBe('ollama');
    expect(switched.baseUrl).toBe('http://127.0.0.1:9102/v1');
    expect(switched.keyOptional).toBe(true);
  });

  it('headless env fallback: no enabled rows + ROUTERAI_API_KEY → routerai from env', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'env-routerai-secret');
    vi.stubEnv('ROUTERAI_ENDPOINT', 'http://127.0.0.1:9103/v1');
    vi.stubEnv('ROUTERAI_MODEL_CRITICAL', 'env-crit-model');

    const provider = await providers.resolveActiveProvider();
    expect(provider.kind).toBe('routerai');
    expect(provider.baseUrl).toBe('http://127.0.0.1:9103/v1');
    expect(provider.apiKey).toBe('env-routerai-secret');
    expect(provider.keySource).toBe('env');
    expect(provider.models.critical).toBe('env-crit-model');
  });

  it('null when nothing is configured at all', async () => {
    expect(await providers.resolveActiveProvider()).toBeNull();
  });
});

describe('resolveCoverProvider (D9 honest gate)', () => {
  it('images-capable enabled provider serves covers with its cover model', async () => {
    await prisma.providerConfig.create({
      data: {
        kind: 'routerai',
        apiKey: 'ra-key',
        enabled: true,
        modelsJson: JSON.stringify({ cover: 'img-model-x' }),
      },
    });

    const cover = await providers.resolveCoverProvider();
    expect(cover.ok).toBe(true);
    expect(cover.kind).toBe('routerai');
    expect(cover.coverModel).toBe('img-model-x');
    expect(cover.apiKey).toBe('ra-key');
  });

  it('images-incapable active provider → honest machine code, no silent fallback', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true },
    });

    const cover = await providers.resolveCoverProvider();
    expect(cover.ok).toBe(false);
    expect(cover.code).toBe('cover_provider_images_unsupported');
  });

  it('env fallback counts: headless ROUTERAI_API_KEY keeps covers available', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'env-routerai-secret');
    const cover = await providers.resolveCoverProvider();
    expect(cover.ok).toBe(true);
    expect(cover.kind).toBe('routerai');
    expect(cover.coverModel).toBeNull(); // no assignment → caller uses its own default
  });
});
