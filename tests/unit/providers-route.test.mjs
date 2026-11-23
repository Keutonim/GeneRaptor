/**
 * Provider settings + catalog routes.
 *
 * Contract under test (server/routes/providers.mjs):
 *   Settings router (mounted at /api/settings/providers):
 *     GET  /            → 200 { success, data:{ providers:[4 masked cards] } };
 *                         key values NEVER in the body (D10);
 *     PUT  /:kind       → upsert via the storage API; masked card back;
 *                         400 with { error:{code} } on typed validation errors;
 *     POST /:kind/test  → probe result { ok, level, message, latencyMs,
 *                         checkedAt } always 200 for a known kind; optional
 *                         body { model } = model ping; 30 s cooldown per
 *                         kind+model returns warning + cooldown:true WITHOUT
 *                         a second network call; 400 for unknown kind;
 *                         key values never in the body.
 *   Catalog router (mounted at /api/providers):
 *     GET  /:kind/models → 200 { success, data:{ models:[{id}...] } } proxied
 *                         from GET {base}/models; 502 honest failure when the
 *                         endpoint rejects (no provider body echoes, no keys);
 *                         400 unknown kind / key-required provider without key.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { PrismaClient } from '@prisma/client';

import providersSettingsRoutes, {
  providerCatalogRoutes,
  resetProvidersProbeCache,
} from '../../server/routes/providers.mjs';

const prisma = new PrismaClient({ log: ['error'] });

const SETTINGS_BASE = '/api/settings/providers';
const CATALOG_BASE = '/api/providers';

let server;
let baseUrl;

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

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(SETTINGS_BASE, providersSettingsRoutes);
  app.use(CATALOG_BASE, providerCatalogRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  // Release the shared SQLite handle (providers.mjs lazy-imports db.mjs) so
  // the Windows temp-dir teardown can remove the test DB file.
  const { prisma: sharedPrisma } = await import('../../server/db.mjs');
  await sharedPrisma.$disconnect();
});

beforeEach(async () => {
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
  resetProvidersProbeCache();
  await prisma.providerConfig.deleteMany();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.providerConfig.deleteMany();
});

/** method + path + JSON body (the payload itself, not wrapped in { body }). */
async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

/** OpenAI-compatible /models Response stub. */
function modelsResponse(ids, status = 200) {
  return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stubs fetch ONLY for outbound provider URLs: requests to the local test
 * server pass through to the real fetch (the test's own HTTP client).
 */
function stubOutboundFetch(handler) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url, init) => {
    if (String(url).startsWith(baseUrl)) return realFetch(url, init);
    return handler(url, init);
  });
}

describe('GET /api/settings/providers — masked cards', () => {
  it('returns 4 cards, no key material anywhere after a key is stored', async () => {
    await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-route-secret-DO-NOT-LEAK',
      enabled: true,
    });

    const { status, body } = await call('GET', SETTINGS_BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.providers.map((p) => p.kind)).toEqual([
      'routerai',
      'openrouter',
      'ollama',
      'custom',
    ]);
    expect(JSON.stringify(body)).not.toContain('sk-route-secret-DO-NOT-LEAK');
    const custom = body.data.providers.find((p) => p.kind === 'custom');
    expect(custom.keyConfigured).toBe(true);
    expect(custom.keySource).toBe('local');
    expect(custom.enabled).toBe(true);
    expect(custom.envKey).toBe('CUSTOM_API_KEY');
  });
});

describe('PUT /api/settings/providers/:kind — masked write', () => {
  it('saves baseUrl + key + models, returns the masked card', async () => {
    const { status, body } = await call('PUT', `${SETTINGS_BASE}/openrouter`, {
      apiKey: 'sk-or-secret',
      models: { critical: 'a/b', cover: 'img/x' },
      enabled: true,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.kind).toBe('openrouter');
    expect(body.data.models).toEqual({ critical: 'a/b', cover: 'img/x' });
    expect(JSON.stringify(body)).not.toContain('sk-or-secret');
  });

  it('switching the active provider disables the previous one', async () => {
    await call('PUT', `${SETTINGS_BASE}/openrouter`, { apiKey: 'k1', enabled: true });
    await call('PUT', `${SETTINGS_BASE}/ollama`, { enabled: true });

    const { body } = await call('GET', SETTINGS_BASE);
    const enabled = body.data.providers.filter((p) => p.enabled);
    expect(enabled.map((p) => p.kind)).toEqual(['ollama']);
  });

  it('400 with machine code for unknown kind and for custom without baseUrl', async () => {
    const unknown = await call('PUT', `${SETTINGS_BASE}/yandex`, {});
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('unknown_provider_kind');

    const noBase = await call('PUT', `${SETTINGS_BASE}/custom`, { apiKey: 'k' });
    expect(noBase.status).toBe(400);
    expect(noBase.body.error.code).toBe('custom_base_url_required');
  });
});

describe('POST /api/settings/providers/:kind/test — probe with cooldown + model ping', () => {
  it('key ping via GET /models → ok with latency; repeat within 30 s = cooldown warning, no 2nd network call', async () => {
    await call('PUT', `${SETTINGS_BASE}/routerai`, { apiKey: 'sk-probe-secret' });
    const fetchSpy = vi.fn(async () => modelsResponse(['qwen/x']));
    stubOutboundFetch(fetchSpy);

    const first = await call('POST', `${SETTINGS_BASE}/routerai/test`);
    expect(first.status).toBe(200);
    expect(first.body.data.ok).toBe(true);
    expect(first.body.data.level).toBe('ok');
    expect(first.body.data.latencyMs).toBeGreaterThanOrEqual(0);

    const second = await call('POST', `${SETTINGS_BASE}/routerai/test`);
    expect(second.body.data.level).toBe('warning');
    expect(second.body.data.cooldown).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second.body)).not.toContain('sk-probe-secret');
  });

  it('model ping POSTs chat/completions with EXACTLY the chosen model', async () => {
    await call('PUT', `${SETTINGS_BASE}/routerai`, { apiKey: 'sk-probe-secret' });
    const calls = [];
    stubOutboundFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { body } = await call('POST', `${SETTINGS_BASE}/routerai/test`, { model: 'qwen/pinned' });

    expect(body.data.ok).toBe(true);
    expect(body.data.level).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/chat/completions');
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.model).toBe('qwen/pinned');
    expect(sent.max_tokens).toBe(1);
  });

  it('401 from the provider → level error; key value never echoed', async () => {
    await call('PUT', `${SETTINGS_BASE}/openrouter`, { apiKey: 'sk-bad-key' });
    stubOutboundFetch(async () => modelsResponse([], 401));

    const { body } = await call('POST', `${SETTINGS_BASE}/openrouter/test`);

    expect(body.data.level).toBe('error');
    expect(body.data.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('sk-bad-key');
  });

  it('400 for unknown kind', async () => {
    const { status } = await call('POST', `${SETTINGS_BASE}/nope/test`);
    expect(status).toBe(400);
  });
});

describe('GET /api/providers/:kind/models — catalog proxy', () => {
  it('normalizes the OpenAI /models shape to { models:[{id}] }', async () => {
    await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-cat-secret',
    });
    const calls = [];
    stubOutboundFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return modelsResponse(['m-one', 'm-two']);
    });

    const { status, body } = await call('GET', `${CATALOG_BASE}/custom/models`);

    expect(status).toBe(200);
    expect(body.data.models).toEqual([{ id: 'm-one' }, { id: 'm-two' }]);
    expect(calls[0].url).toBe('https://example.com/v1/models');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-cat-secret');
  });

  it('keyless provider (ollama) proxies without an Authorization header', async () => {
    const calls = [];
    stubOutboundFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return modelsResponse(['qwen3:8b']);
    });

    await call('GET', `${CATALOG_BASE}/ollama/models`);

    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('provider failure → 502 honest message, no provider body echo, no key', async () => {
    await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-cat-secret',
    });
    stubOutboundFetch(
      async () =>
        new Response('<html>echo sk-cat-secret internal</html>', {
          status: 500,
        }),
    );

    const { status, body } = await call('GET', `${CATALOG_BASE}/custom/models`);

    expect(status).toBe(502);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain('sk-cat-secret');
    expect(JSON.stringify(body)).not.toContain('echo');
  });

  it('400 unknown kind; 400 key-required provider without any key', async () => {
    const unknown = await call('GET', `${CATALOG_BASE}/nope/models`);
    expect(unknown.status).toBe(400);

    const noKey = await call('GET', `${CATALOG_BASE}/openrouter/models`);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('provider_key_missing');
  });
});
