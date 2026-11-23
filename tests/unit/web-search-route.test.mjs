/**
 * Contract tests for the generic web-search HTTP route.
 *
 * The route must never answer 5xx: a missing key, an exhausted quota or a
 * dead network must degrade into an empty result set with `degraded: true`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import webSearchRoutes from '../../server/routes/web-search.mjs';

let server;
let baseUrl;

/**
 * The real fetch — the tests mock `globalThis.fetch` to simulate a dead
 * network, so the local HTTP client must bypass the mock.
 */
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/search', webSearchRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GET /api/search/backends', () => {
  it('lists the available backends for the settings page', async () => {
    const response = await fetch(`${baseUrl}/api/search/backends`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.backends)).toBe(true);
    expect(body.data.backends.length).toBeGreaterThanOrEqual(3);

    const ids = body.data.backends.map((b) => b.id);
    expect(ids).toContain('tavily-keyless');
    expect(ids).toContain('wikipedia');
    expect(ids).toContain('serper');
    expect(ids).toContain('yandex');

    const keyless = body.data.backends.find((b) => b.id === 'tavily-keyless');
    expect(keyless.requiresKey).toBe(false);
    expect(keyless.configured).toBe(true);

    // The unofficial scraping backend is listed, but marked as opt-in.
    const unofficial = body.data.backends.find((b) => b.id === 'duckduckgo');
    expect(unofficial.unofficial).toBe(true);
    expect(unofficial.official).toBe(false);
    expect(unofficial.optIn).toBe(true);
  });

  it('reports the keyless backend as the default selection', async () => {
    const response = await fetch(`${baseUrl}/api/search/backends`);
    const body = await response.json();

    expect(body.data.selected).toBe('auto');
    expect(body.data.defaultBackend).toBe('tavily-keyless');
  });

  it('lists the narrow verticals as keyless and official', async () => {
    const response = await fetch(`${baseUrl}/api/search/backends`);
    const body = await response.json();

    expect(Array.isArray(body.data.verticals)).toBe(true);
    expect(body.data.verticals.length).toBeGreaterThanOrEqual(8);
    for (const vertical of body.data.verticals) {
      expect(vertical.requiresKey).toBe(false);
      expect(vertical.official).toBe(true);
      expect(vertical.vertical).toBe(true);
      expect(vertical.inAutoChain).toBe(false);
    }
  });
});

describe('POST /api/search/search', () => {
  it('returns 200 with an empty result set when the network is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.tavily.com');
    });

    const response = await realFetch(`${baseUrl}/api/search/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'offline smoke' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.results).toEqual([]);
    expect(body.data.degraded).toBe(true);
    expect(body.data.reason).toBe('network_unavailable');
  });

  it('returns 200 with an empty result set for an empty query', async () => {
    const response = await realFetch(`${baseUrl}/api/search/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '  ' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.results).toEqual([]);
    expect(body.data.degraded).toBe(true);
  });

  it('never exposes an API key in the response payload', async () => {
    vi.stubEnv('GENERAPTOR_SERPER_API_KEY', 'super-secret-value');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('offline');
    });

    const response = await realFetch(`${baseUrl}/api/search/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'secret check' }),
    });
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain('super-secret-value');
  });
});

describe('POST /api/search/probe', () => {
  it('probes a keyed backend without a key: no network call, no 5xx', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('GENERAPTOR_TAVILY_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await realFetch(`${baseUrl}/api/search/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'tavily' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.backend).toBe('tavily');
    expect(body.data.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a backend without a key-based probe', async () => {
    const response = await realFetch(`${baseUrl}/api/search/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'wikipedia' }),
    });

    expect(response.status).toBe(400);
  });

  it('does not probe twice within the cooldown', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('GENERAPTOR_SERPER_API_KEY', 'serper-secret');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ organic: [] }),
      text: async () => '{}',
    }));

    const probe = () => realFetch(`${baseUrl}/api/search/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'serper' }),
    });

    const first = await probe();
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(firstBody.data.cooldown).not.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await probe();
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.data.cooldown).toBe(true);
    expect(secondBody.data.waitSec).toBeGreaterThan(0);
    // The second probe must not burn another request of the free quota.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
