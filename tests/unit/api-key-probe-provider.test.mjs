/**
 * The generic OpenAI-compatible probe + model ping.
 *
 * Contract under test (server/lib/api-key-probe.mjs):
 *   probeOpenAICompatible(apiKey, { baseUrl, model?, fetchImpl, timeoutMs,
 *                                   keyOptional?, label? })
 *
 *   - key ping (no model): GET {base}/models → ok; 404/405 → fallback
 *     POST {base}/chat/completions max_tokens:1 (legacy semantics, now
 *     parameterized by baseUrl instead of ROUTERAI_ENDPOINT env);
 *   - model ping (model given): POST chat/completions exercises EXACTLY the
 *     chosen model id (M3 AC) — 2xx ok, 401/403 error, 429 warning;
 *   - keyless providers (keyOptional, e.g. ollama): probe proceeds without
 *     an Authorization header; key-required providers without a key →
 *     warning 'key missing', no network;
 *   - latencyMs always present; the key value never appears in the result.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const probe = await import('../../server/lib/api-key-probe.mjs');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body ?? {}) };
}

beforeEach(() => {
  vi.stubEnv('ROUTERAI_ENDPOINT', '');
  vi.stubEnv('ROUTERAI_MODEL_STANDARD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('probeOpenAICompatible — key ping (GET /models)', () => {
  it('ok with latency when /models accepts the key', async () => {
    const fetchImpl = vi.fn(async (url) => jsonResponse(200, { data: [{ id: 'm1' }] }));
    const result = await probe.probeOpenAICompatible('secret-key', {
      baseUrl: 'http://127.0.0.1:9201/v1/',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:9201/v1/models');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-key');
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it('error on 401 — key rejected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, {}));
    const result = await probe.probeOpenAICompatible('bad-key', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      fetchImpl,
    });
    expect(result.level).toBe('error');
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('fallback to a 1-token chat completion when /models is 404', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: 'x' } }] }));
    const result = await probe.probeOpenAICompatible('secret-key', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      fetchImpl,
    });

    expect(result.level).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [fallbackUrl, fallbackInit] = fetchImpl.mock.calls[1];
    expect(fallbackUrl).toBe('http://127.0.0.1:9201/v1/chat/completions');
    const body = JSON.parse(fallbackInit.body);
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
  });

  it('network failure → warning with latency, no provider details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const result = await probe.probeOpenAICompatible('secret-key', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      fetchImpl,
    });
    expect(result.level).toBe('warning');
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('fetch failed');
  });
});

describe('probeOpenAICompatible — model ping (M3 AC)', () => {
  it('exercises EXACTLY the chosen model via chat/completions max_tokens:1', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const result = await probe.probeOpenAICompatible('secret-key', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      model: 'chosen-model-x',
      fetchImpl,
    });

    expect(result.level).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9201/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('chosen-model-x');
    expect(body.max_tokens).toBe(1);
  });

  it('model ping surfaces 429 as warning (rate-limited, key is fine)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    const result = await probe.probeOpenAICompatible('secret-key', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      model: 'chosen-model-x',
      fetchImpl,
    });
    expect(result.level).toBe('warning');
    expect(result.statusCode).toBe(429);
  });

  it('model ping 401 is an error (key, not model, problem)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, {}));
    const result = await probe.probeOpenAICompatible('secret-key', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      model: 'chosen-model-x',
      fetchImpl,
    });
    expect(result.level).toBe('error');
  });
});

describe('probeOpenAICompatible — keyless providers (ollama)', () => {
  it('keyOptional: probes without an Authorization header, no key-missing warning', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith('/models')) return jsonResponse(200, { data: [] });
      return jsonResponse(200, { choices: [] });
    });
    const result = await probe.probeOpenAICompatible('', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      keyOptional: true,
      fetchImpl,
    });

    expect(result.level).toBe('ok');
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('key required and missing → warning, zero network calls', async () => {
    const fetchImpl = vi.fn();
    const result = await probe.probeOpenAICompatible('', {
      baseUrl: 'http://127.0.0.1:9201/v1',
      fetchImpl,
    });
    expect(result.level).toBe('warning');
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
