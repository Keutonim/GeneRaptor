// Unit tests for server/lib/routerai-images.mjs.
// fetch is stubbed — NO live network, synthetic tokens only (brief house rules).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { generateImage, CoverImageError } = await import('../../server/lib/routerai-images.mjs');

const ENDPOINT = 'http://localhost:9999';
const TEST_KEY = 'test-mock-key-not-real';

let fetchMock;

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function successBody(cost = 4.82) {
  const bytes = Buffer.from('fake-png-bytes');
  return {
    body: {
      created: 1761300000,
      data: [{ b64_json: bytes.toString('base64') }],
      usage: { cost },
    },
    bytes,
  };
}

const BASE_ARGS = {
  model: 'qwen/qwen-image-2.1-pro',
  prompt: 'Баннер для статьи',
  aspectRatio: '16:9',
  resolution: '1K',
  outputFormat: 'png',
  retryDelayMs: 0,
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ROUTERAI_ENDPOINT', ENDPOINT);
  vi.stubEnv('ROUTERAI_API_KEY', TEST_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Case 17: request shape.
describe('request shape', () => {
  it('POSTs to ${ROUTERAI_ENDPOINT}/images with Bearer auth and the pinned body (no stream)', async () => {
    const { body } = successBody();
    fetchMock.mockImplementation(() => jsonResponse(body));

    await generateImage(BASE_ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/images`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(init.headers['content-type']).toBe('application/json');
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      model: 'qwen/qwen-image-2.1-pro',
      prompt: 'Баннер для статьи',
      n: 1,
      aspect_ratio: '16:9',
      size: '1K', // qwen family uses `size`
      output_format: 'png',
    });
    expect(payload).not.toHaveProperty('stream');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the `resolution` key for non-qwen (gemini) models', async () => {
    const { body } = successBody();
    fetchMock.mockImplementation(() => jsonResponse(body));

    await generateImage({ ...BASE_ARGS, model: 'google/gemini-nano-banana-2.1' });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.resolution).toBe('1K');
    expect(payload).not.toHaveProperty('size');
  });

  it('sends quality when explicitly set (non-auto), omits it otherwise', async () => {
    const { body } = successBody();
    fetchMock.mockImplementation(() => jsonResponse(body));

    await generateImage({ ...BASE_ARGS, quality: 'high' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).quality).toBe('high');

    await generateImage({ ...BASE_ARGS, quality: 'auto' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('quality');

    await generateImage(BASE_ARGS);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('quality');
  });

  it('throws cover_not_configured without touching the network when the API key is missing', async () => {
    vi.stubEnv('ROUTERAI_API_KEY', '');

    await expect(generateImage(BASE_ARGS)).rejects.toMatchObject({
      name: 'CoverImageError',
      code: 'cover_not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Case 18: 400 mentioning the size field → ONE retry with the alternative key.
describe('alternative-key retry on 400', () => {
  it('flips size → resolution once and succeeds on the same attempt slot', async () => {
    const { body } = successBody();
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse({ error: { message: "Invalid value for 'size'. Supported: 512,1K" } }, 400),
      )
      .mockImplementationOnce(() => jsonResponse(body));

    const result = await generateImage(BASE_ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${ENDPOINT}/images`); // same endpoint — payload fix, not transport retry
    const secondPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondPayload.resolution).toBe('1K');
    expect(secondPayload).not.toHaveProperty('size');
    expect(result.costRub).toBeCloseTo(4.82, 10);
  });

  it('throws a typed error when the 400 does not mention the size field', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ error: { message: 'prompt policy violation' } }, 400),
    );

    await expect(generateImage(BASE_ARGS)).rejects.toMatchObject({
      name: 'CoverImageError',
      code: 'cover_generation_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // not retryable
  });

  it('never flips the key more than once', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ error: { message: 'bad size' } }, 400),
    );

    await expect(generateImage(BASE_ARGS)).rejects.toBeInstanceOf(CoverImageError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + single flip
  });

  it('drops quality once when the 400 mentions quality', async () => {
    const { body } = successBody();
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse({ error: { message: "Unsupported parameter: 'quality'" } }, 400),
      )
      .mockImplementationOnce(() => jsonResponse(body));

    await generateImage({ ...BASE_ARGS, quality: 'high' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('quality');
  });
});

// Case 19: 404/405 on /images → one retry on /images/generations.
describe('endpoint fallback', () => {
  it.each([404, 405])('retries on /images/generations after HTTP %i', async (status) => {
    const { body } = successBody();
    fetchMock
      .mockImplementationOnce(() => jsonResponse({ error: { message: 'not found' } }, status))
      .mockImplementationOnce(() => jsonResponse(body));

    const result = await generateImage(BASE_ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/images`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${ENDPOINT}/images/generations`);
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it('gives up with a typed error when the fallback endpoint also 404s', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'nope' } }, 404));

    await expect(generateImage(BASE_ARGS)).rejects.toMatchObject({
      code: 'cover_generation_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // primary + fallback, no loop
  });
});

// Case 20: 429/5xx bounded retry, exhaustion → typed error.
describe('transport retries', () => {
  it('retries a 429 once and succeeds', async () => {
    const { body } = successBody();
    fetchMock
      .mockImplementationOnce(() => jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockImplementationOnce(() => jsonResponse(body));

    const result = await generateImage(BASE_ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.costRub).toBeCloseTo(4.82, 10);
  });

  it('exhausts maxAttempts=2 on 5xx and throws a typed error', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'boom' } }, 503));

    const err = await generateImage(BASE_ARGS).catch((e) => e);

    expect(err).toBeInstanceOf(CoverImageError);
    expect(err.code).toBe('cover_generation_failed');
    expect(err.message).toContain('503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours a custom maxAttempts', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'boom' } }, 500));

    await expect(generateImage({ ...BASE_ARGS, maxAttempts: 3 })).rejects.toBeInstanceOf(
      CoverImageError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a network failure (fetch rejected) then succeeds', async () => {
    const { body } = successBody();
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')))
      .mockImplementationOnce(() => jsonResponse(body));

    const result = await generateImage(BASE_ARGS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it('never leaks the API key into error messages', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'boom' } }, 500));

    const err = await generateImage(BASE_ARGS).catch((e) => e);
    expect(err.message).not.toContain(TEST_KEY);
  });
});

// Case 21: timeout → AbortError mapped to a typed error.
describe('timeout', () => {
  it('aborts a hanging request and maps AbortError to cover_generation_failed', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );

    const err = await generateImage({ ...BASE_ARGS, timeoutMs: 40, maxAttempts: 1 }).catch((e) => e);

    expect(err).toBeInstanceOf(CoverImageError);
    expect(err.code).toBe('cover_generation_failed');
    expect(err.message).toMatch(/timed out/i);
  });

  it('rejects immediately for an already-aborted outer signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateImage({ ...BASE_ARGS, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'CoverImageError', code: 'cover_generation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Case 22: response parsing.
describe('response parsing', () => {
  it('decodes data[0].b64_json to a buffer and usage.cost to a number', async () => {
    const { body, bytes } = successBody(3.4);
    fetchMock.mockImplementation(() => jsonResponse(body));

    const result = await generateImage(BASE_ARGS);

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.equals(bytes)).toBe(true);
    expect(result.costRub).toBe(3.4);
    expect(result.raw).toEqual(body);
  });

  it('throws a typed error when data[0] is missing', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ created: 1, data: [], usage: { cost: 1 } }));

    await expect(generateImage(BASE_ARGS)).rejects.toMatchObject({
      name: 'CoverImageError',
      code: 'cover_generation_failed',
    });
  });

  it('throws a typed error when b64_json is missing', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ data: [{ url: 'https://cdn/x.png' }], usage: { cost: 1 } }),
    );

    await expect(generateImage(BASE_ARGS)).rejects.toMatchObject({
      code: 'cover_generation_failed',
    });
  });

  it('falls back to costRub 0 when usage.cost is absent', async () => {
    const { body } = successBody();
    delete body.usage;
    fetchMock.mockImplementation(() => jsonResponse(body));

    const result = await generateImage(BASE_ARGS);
    expect(result.costRub).toBe(0);
  });
});
