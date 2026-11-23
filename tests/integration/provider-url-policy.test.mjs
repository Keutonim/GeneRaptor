/**
 * SEC-02 (CWE-918 / CWE-522): outbound provider URL policy + key/URL binding.
 *
 * The attack the AppSec round reproduced: a stored provider `baseUrl` used to
 * override the canonical endpoint of a FIXED provider, while the environment
 * key (ROUTERAI_API_KEY) won the key resolution — so the server sent the
 * operator's key to an attacker-controlled host.
 *
 * Contract under test:
 *   - a stored baseUrl is validated BEFORE it is saved (HTTP 400, machine code);
 *   - a stored baseUrl is validated BEFORE it is used (no outbound request at all
 *     when the target is rejected);
 *   - the fixed kinds (routerai, openrouter) never take a user-supplied URL;
 *   - a key is only ever sent to the endpoint it is bound to: the env key goes
 *     to the operator-controlled endpoint, the stored key to its own stored URL,
 *     and the custom kind never uses an env key;
 *   - a rejected target never produces an outbound request and never echoes a
 *     raw provider HTTP status.
 *
 * The REAL Express routers and the REAL storage layer are used — no mocked
 * Express. Only the outbound HTTP client is stubbed (to prove where a request
 * would have gone).
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

const ENV_KEYS = [
  'ROUTERAI_API_KEY',
  'ROUTERAI_ENDPOINT',
  'ROUTERAI_MODEL_CRITICAL',
  'ROUTERAI_MODEL_GENERATION',
  'ROUTERAI_MODEL_STANDARD',
  'OPENROUTER_API_KEY',
  'OLLAMA_API_KEY',
  'CUSTOM_API_KEY',
  'GENERAPTOR_ALLOW_PRIVATE_NETWORK',
];

let server;
let baseUrl;

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

/** method + path + JSON body. */
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

/** Stubs ONLY the outbound provider client; requests to the test server pass through. */
function stubOutboundFetch(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  vi.stubGlobal('fetch', (url, init) => {
    const target = String(url);
    if (target.startsWith(baseUrl)) return realFetch(url, init);
    calls.push({ url: target, init });
    return handler(url, init);
  });
  return calls;
}

describe('SEC-02 — stored baseUrl is rejected BEFORE it is saved', () => {
  it('rejects an unresolvable attacker host for the custom kind', async () => {
    const { status, body } = await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'http://attacker.example',
      apiKey: 'sk-attacker',
    });

    expect(status).toBe(400);
    expect(body.error.code).toMatch(/^provider_url/);
    const stored = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    expect(stored).toBeNull();
  });

  it('rejects the cloud metadata endpoint (link-local)', async () => {
    const { status, body } = await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('provider_url_private');
    const stored = await prisma.providerConfig.findFirst({ where: { kind: 'custom' } });
    expect(stored).toBeNull();
  });

  it('rejects a loopback target for the custom kind unless the operator opts in', async () => {
    const blocked = await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('provider_url_private');

    vi.stubEnv('GENERAPTOR_ALLOW_PRIVATE_NETWORK', 'true');
    const allowed = await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.success).toBe(true);
  });

  it('allows a loopback target for ollama (local inference server)', async () => {
    const { status, body } = await call('PUT', `${SETTINGS_BASE}/ollama`, {
      baseUrl: 'http://127.0.0.1:11434',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('rejects a stored baseUrl for the fixed routerai kind', async () => {
    const { status, body } = await call('PUT', `${SETTINGS_BASE}/routerai`, {
      baseUrl: 'http://attacker.example',
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('provider_url_not_allowed');
    const stored = await prisma.providerConfig.findFirst({ where: { kind: 'routerai' } });
    expect(stored?.baseUrl ?? null).toBeNull();
  });

  it('rejects a non-http(s) scheme and a URL with credentials', async () => {
    const scheme = await call('PUT', `${SETTINGS_BASE}/custom`, { baseUrl: 'ftp://example.com/v1' });
    expect(scheme.status).toBe(400);
    expect(scheme.body.error.code).toBe('provider_url_scheme');

    const credentials = await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'http://user:pass@example.com/v1',
    });
    expect(credentials.status).toBe(400);
    expect(credentials.body.error.code).toBe('provider_url_credentials');
  });
});

describe('SEC-02 — a rejected target is never used', () => {
  it('never sends the provider key to a stored attacker URL (fixed routerai kind)', async () => {
    // A hostile row written straight into the store (bypassing the save path).
    await prisma.providerConfig.create({
      data: { kind: 'routerai', baseUrl: 'http://attacker.example', enabled: true },
    });
    vi.stubEnv('ROUTERAI_API_KEY', 'env-secret-must-not-leak');
    const calls = stubOutboundFetch(async () => modelsResponse(['qwen/x']));

    const { status } = await call('GET', `${CATALOG_BASE}/routerai/models`);

    expect(status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    // The stored attacker URL is ignored: the request goes to the canonical endpoint.
    expect(calls.every((call) => !call.url.includes('attacker.example'))).toBe(true);
    expect(calls[0].url).toBe('https://routerai.ru/api/v1/models');
    // The key is bound to the canonical endpoint — it is never sent elsewhere.
    expect(calls[0].init.headers.Authorization).toBe('Bearer env-secret-must-not-leak');
  });

  it('refuses to call a blocked custom endpoint at all', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: 'http://169.254.169.254/latest/meta-data/', enabled: true },
    });
    const calls = stubOutboundFetch(async () => modelsResponse(['m-one']));

    const { status, body } = await call('GET', `${CATALOG_BASE}/custom/models`);

    expect(status).toBe(502);
    expect(body.error.code).toBe('provider_endpoint_rejected');
    expect(calls).toHaveLength(0);
  });

  it('refuses to probe a blocked endpoint without a network call', async () => {
    await prisma.providerConfig.create({
      data: { kind: 'custom', baseUrl: 'http://169.254.169.254/latest/meta-data/', enabled: true },
    });
    const calls = stubOutboundFetch(async () => modelsResponse(['m-one']));

    const { status, body } = await call('POST', `${SETTINGS_BASE}/custom/test`);

    expect(status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('SEC-02 — key/URL binding', () => {
  it('never uses an env key for the custom kind and binds the stored key to its own URL', async () => {
    vi.stubEnv('CUSTOM_API_KEY', 'env-custom-secret-must-not-be-used');
    await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'stored-custom-secret',
    });
    const calls = stubOutboundFetch(async () => modelsResponse(['m-one']));

    const { status } = await call('GET', `${CATALOG_BASE}/custom/models`);

    expect(status).toBe(200);
    expect(calls[0].url).toBe('https://example.com/v1/models');
    expect(calls[0].init.headers.Authorization).toBe('Bearer stored-custom-secret');
    expect(calls[0].init.headers.Authorization).not.toContain('env-custom-secret');
  });

  it('does not attach the env key to a stored (user-supplied) endpoint', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', 'env-secret-must-not-leak');
    await call('PUT', `${SETTINGS_BASE}/custom`, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'stored-custom-secret',
    });
    const calls = stubOutboundFetch(async () => modelsResponse(['m-one']));

    await call('GET', `${CATALOG_BASE}/custom/models`);

    const authHeaders = calls.map((call) => call.init.headers.Authorization ?? '');
    expect(authHeaders.some((value) => value.includes('env-secret-must-not-leak'))).toBe(false);
  });
});
