/**
 * The single LLM call site resolves endpoint/key/
 * tier models from the ACTIVE PROVIDER config instead of the ROUTERAI_*
 * module constants.
 *
 * Contract under test (server/agent-role-execution.mjs, fetch region only —
 * retry/SSE/fallback-chain semantics unchanged):
 *   - callRouterAI POSTs {provider.baseUrl}/chat/completions with the
 *     provider's key (DB row) — Bearer local key;
 *   - no DB config → env fallback (ROUTERAI_ENDPOINT + ROUTERAI_API_KEY),
 *     legacy behavior preserved;
 *   - keyless providers (ollama) call WITHOUT an Authorization header;
 *   - key-required provider with no key anywhere → honest error naming the
 *     provider's env key (not the routerai-only message);
 *   - callRouterAIWithFallbackChain remaps the role's tier model to the
 *     provider's assignment when set (tier assignment per provider, M3).
 */
import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

const execution = await import('../../server/agent-role-execution.mjs');

/** Captures URL + init; returns a valid non-streaming OpenAI-shaped Response. */
function makeCapturingFetch(content = '{"ok":true}') {
  const calls = [];
  const fetchSpy = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      id: 'fake-completion',
      model: JSON.parse(init.body).model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  fetchSpy.calls = calls;
  return fetchSpy;
}

const basePayload = { model: 'some-model', stream: false, messages: [{ role: 'user', content: 'hi' }] };

beforeEach(async () => {
  for (const key of ['ROUTERAI_API_KEY', 'ROUTERAI_ENDPOINT', 'ROUTERAI_MODEL_CRITICAL', 'ROUTERAI_MODEL_GENERATION', 'ROUTERAI_MODEL_STANDARD']) {
    vi.stubEnv(key, '');
  }
  // SEC-02: a stored loopback endpoint is denied by default — these cases model
  // the operator who explicitly allowed a local gateway.
  vi.stubEnv('GENERAPTOR_ALLOW_PRIVATE_NETWORK', 'true');
  await prisma.providerConfig.deleteMany();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.providerConfig.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  const { prisma: sharedPrisma } = await import('../../server/db.mjs');
  await sharedPrisma.$disconnect();
});

describe('callRouterAI — provider-resolved endpoint/key', () => {
  it('uses the ACTIVE provider baseUrl + local key from ProviderConfig', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: 'http://127.0.0.1:9301/v1', apiKey: 'custom-local-secret', enabled: true },
    });
    const fetchSpy = makeCapturingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await execution.callRouterAI({ ...basePayload });

    expect(result.status).toBe(200);
    expect(fetchSpy.calls[0].url).toBe('http://127.0.0.1:9301/v1/chat/completions');
    expect(fetchSpy.calls[0].init.headers.authorization).toBe('Bearer custom-local-secret');
  });

  it('env fallback keeps the legacy behavior (ROUTERAI_ENDPOINT + ROUTERAI_API_KEY)', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'env-fallback-secret');
    vi.stubEnv('ROUTERAI_ENDPOINT', 'http://127.0.0.1:9302/v1');
    const fetchSpy = makeCapturingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await execution.callRouterAI({ ...basePayload });

    expect(fetchSpy.calls[0].url).toBe('http://127.0.0.1:9302/v1/chat/completions');
    expect(fetchSpy.calls[0].init.headers.authorization).toBe('Bearer env-fallback-secret');
  });

  it('keyless provider (ollama) calls without an Authorization header', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true },
    });
    const fetchSpy = makeCapturingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await execution.callRouterAI({ ...basePayload, model: 'qwen3:8b' });

    expect(result.status).toBe(200);
    expect(fetchSpy.calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(fetchSpy.calls[0].init.headers.authorization).toBeUndefined();
  });

  it('key-required provider without any key → honest error naming the env key', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true },
    });

    await expect(execution.callRouterAI({ ...basePayload })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('callRouterAIWithFallbackChain — provider tier model assignment', () => {
  it('remaps the role model to the provider tier assignment (critical)', async () => {
    await prisma.providerConfig.create({
      data: {
        kind: 'custom',
        baseUrl: 'http://127.0.0.1:9303/v1',
        apiKey: 'k',
        enabled: true,
        modelsJson: JSON.stringify({ critical: 'fake-critical', generation: 'fake-gen', standard: 'fake-std' }),
      },
    });
    const fetchSpy = makeCapturingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const chainInfo = { model: null, fallbackModel: null, failedAttempts: 0 };
    const result = await execution.callRouterAIWithFallbackChain(
      { ...basePayload, model: 'env-default-model' },
      { roleId: 'factchecker', chainInfo },
    );

    expect(result.status).toBe(200);
    const sentModel = JSON.parse(fetchSpy.calls[0].init.body).model;
    expect(sentModel).toBe('fake-critical');
    expect(chainInfo.model).toBe('fake-critical');
  });

  it('no provider assignment → payload model untouched (env defaults rule)', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'env-fallback-secret');
    vi.stubEnv('ROUTERAI_ENDPOINT', 'http://127.0.0.1:9304/v1');
    const fetchSpy = makeCapturingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await execution.callRouterAIWithFallbackChain(
      { ...basePayload, model: 'env-default-model' },
      { roleId: 'article-author' },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(fetchSpy.calls[0].init.body).model).toBe('env-default-model');
  });
});
