/**
 * RouterAI image-generation client for covers (cases 17-22).
 *
 * Own budget — never inherits the chat client's ROUTERAI_MAX_RETRIES /
 * ROUTERAI_TIMEOUT_MS defaults:
 *  - per-attempt timeout: ROUTERAI_IMAGE_TIMEOUT_MS (default 120000);
 *  - max attempts: 2 (1 initial + 1 transport retry);
 *  - sliding total budget: maxAttempts × timeoutMs (roleBudgetMs pattern);
 *  - transport retries: 429 / 5xx / network error / timeout only.
 *
 * Payload/route fixes are NOT transport attempts (same attempt slot, one-shot):
 *  - 400 mentioning the size field → flip `size` ↔ `resolution` once;
 *  - 400 mentioning quality → drop `quality` once ("sent when supported");
 *  - 404/405 on /images → retry once on /images/generations.
 *
 * Error messages carry endpoint path + HTTP status only — never the API key.
 *
 * SEC-02: the endpoint passes the same structural policy as every other
 * outbound provider call (server/lib/provider-url.mjs); the network policy for
 * a user-supplied URL is applied where the provider descriptor is built.
 */

import { ProviderUrlError, assertTrustedProviderEndpoint } from './provider-url.mjs';

const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;
const MIN_TIMEOUT_MS = 1_000;
const DETAIL_MAX_LEN = 200;

/** Typed error the cover service/routes map to machine codes (plan App A). */
export class CoverImageError extends Error {
  /**
   * @param {'cover_generation_failed' | 'cover_not_configured'} code
   * @param {string} message redacted, machine-oriented
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'CoverImageError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function resolveEnvNumber(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= MIN_TIMEOUT_MS ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function urlPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '<endpoint>';
  }
}

function truncate(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > DETAIL_MAX_LEN ? `${oneLine.slice(0, DETAIL_MAX_LEN)}…` : oneLine;
}

/** qwen family documents `size` (1K|2K); gemini documents `resolution` (512|1K|2K|4K). */
function resolutionKeyFor(model) {
  return String(model).startsWith('qwen') ? 'size' : 'resolution';
}

/**
 * Build the /images request body. `quality` is only sent for explicit non-auto
 * values ("sent when the model supports quality; omitted otherwise" —
 * a 400 mentioning quality drops it once at runtime).
 */
function buildImagePayload(args, resolutionKey, includeQuality) {
  const payload = {
    model: args.model,
    prompt: args.prompt,
    n: 1,
    aspect_ratio: args.aspectRatio,
    output_format: args.outputFormat || 'png',
  };
  payload[resolutionKey] = args.resolution;
  const quality = typeof args.quality === 'string' ? args.quality.trim() : '';
  if (includeQuality && quality && quality !== 'auto') {
    payload.quality = quality;
  }
  return payload;
}

/**
 * Generate one cover image.
 * @param {object} args
 * @param {string} args.model provider model id
 * @param {string} args.prompt composed image prompt
 * @param {string} args.aspectRatio e.g. '16:9'
 * @param {string} args.resolution '512'|'1K'|'2K'|'4K'
 * @param {string} [args.quality] 'auto'|'low'|'medium'|'high'
 * @param {string} [args.outputFormat] 'png'|'jpeg'|'webp'
 * @param {string} [args.baseUrl] provider endpoint (default: ROUTERAI_ENDPOINT)
 * @param {string} [args.apiKey] provider key (default: ROUTERAI_API_KEY)
 * @param {number} [args.timeoutMs] per-attempt timeout (env default 120000)
 * @param {number} [args.maxAttempts] transport attempts (default 2)
 * @param {number} [args.retryDelayMs] delay between transport retries (default 2000; tests use 0)
 * @param {AbortSignal} [args.signal] outer cancellation
 * @returns {Promise<{buffer: Buffer, costRub: number, raw: unknown}>}
 * @throws {CoverImageError}
 */
export async function generateImage(args) {
  // M5: the endpoint + key come from the provider configuration;
  // the env vars stay the fallback for the headless default.
  const endpoint = args?.baseUrl || process.env.ROUTERAI_ENDPOINT || 'https://routerai.ru/api/v1';
  const apiKey = args?.apiKey || process.env.ROUTERAI_API_KEY || '';
  try {
    assertTrustedProviderEndpoint(endpoint);
  } catch (err) {
    if (err instanceof ProviderUrlError) {
      throw new CoverImageError('cover_generation_failed', 'routerai images: endpoint rejected by policy');
    }
    throw err;
  }
  if (!apiKey) {
    throw new CoverImageError('cover_not_configured', 'routerai images: API key is not configured');
  }
  if (args?.signal?.aborted) {
    throw new CoverImageError('cover_generation_failed', 'routerai images: aborted by caller');
  }

  const timeoutMs = Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0
    ? args.timeoutMs
    : resolveEnvNumber(process.env.ROUTERAI_IMAGE_TIMEOUT_MS, DEFAULT_IMAGE_TIMEOUT_MS);
  const maxAttempts = Number.isInteger(args?.maxAttempts) && args.maxAttempts > 0
    ? args.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = Number.isFinite(args?.retryDelayMs) ? args.retryDelayMs : RETRY_DELAY_MS;
  const totalBudgetMs = maxAttempts * timeoutMs;

  let url = `${endpoint}/images`;
  let resolutionKey = resolutionKeyFor(args.model);
  let includeQuality = true;
  let usedKeyFix = false;
  let usedQualityFix = false;
  let usedEndpointFallback = false;
  let lastStatus = null;
  let lastDetail = '';
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && Date.now() - startedAt >= totalBudgetMs) {
      throw new CoverImageError(
        'cover_generation_failed',
        `routerai images: budget exhausted after ${totalBudgetMs}ms at ${urlPathname(url)}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (args?.signal) args.signal.addEventListener('abort', onOuterAbort, { once: true });

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildImagePayload(args, resolutionKey, includeQuality)),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (args?.signal?.aborted) {
          throw new CoverImageError(
            'cover_generation_failed',
            'routerai images: aborted by caller',
            err,
          );
        }
        // Per-attempt timeout — retryable within the sliding budget.
        lastStatus = null;
        lastDetail = `timed out after ${timeoutMs}ms`;
        if (attempt < maxAttempts) continue;
        throw new CoverImageError(
          'cover_generation_failed',
          `routerai images: ${lastDetail} at ${urlPathname(url)}`,
          err,
        );
      }
      // Network failure (DNS, connection refused) — retryable like a timeout.
      lastStatus = null;
      lastDetail = truncate(err?.message || 'network error');
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new CoverImageError(
        'cover_generation_failed',
        `routerai images: network error (${lastDetail}) at ${urlPathname(url)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
      if (args?.signal) args.signal.removeEventListener('abort', onOuterAbort);
    }

    const status = response.status;

    // Route fix: /images → /images/generations (once, same attempt slot).
    if ((status === 404 || status === 405) && !usedEndpointFallback && url.endsWith('/images')) {
      usedEndpointFallback = true;
      url = `${endpoint}/images/generations`;
      attempt -= 1;
      continue;
    }

    // Payload fixes on 400 (once each, same attempt slot).
    if (status === 400) {
      const detail = truncate(await safeText(response));
      const mentionsSize = /\bsize\b|\bresolution\b/i.test(detail);
      const mentionsQuality = /quality/i.test(detail);
      if (!usedKeyFix && mentionsSize) {
        usedKeyFix = true;
        resolutionKey = resolutionKey === 'size' ? 'resolution' : 'size';
        attempt -= 1;
        continue;
      }
      if (!usedQualityFix && mentionsQuality) {
        usedQualityFix = true;
        includeQuality = false;
        attempt -= 1;
        continue;
      }
      throw new CoverImageError(
        'cover_generation_failed',
        `routerai images http 400 at ${urlPathname(url)}: ${detail || 'bad request'}`,
      );
    }

    // Transport retries: 429 / 5xx.
    if (status === 429 || status >= 500) {
      lastStatus = status;
      lastDetail = truncate(await safeText(response));
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new CoverImageError(
        'cover_generation_failed',
        `routerai images http ${status} at ${urlPathname(url)}: ${lastDetail || 'upstream error'}`,
      );
    }

    if (!response.ok) {
      const detail = truncate(await safeText(response));
      throw new CoverImageError(
        'cover_generation_failed',
        `routerai images http ${status} at ${urlPathname(url)}: ${detail || 'request failed'}`,
      );
    }

    return parseImageResponse(response, url);
  }

  // Loop exit without return/throw can only mean budget exhaustion.
  throw new CoverImageError(
    'cover_generation_failed',
    `routerai images: attempts exhausted (last status ${lastStatus ?? 'n/a'}) at ${urlPathname(url)}`,
  );
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function parseImageResponse(response, url) {
  let raw;
  try {
    raw = await response.json();
  } catch (err) {
    throw new CoverImageError(
      'cover_generation_failed',
      `routerai images: malformed JSON at ${urlPathname(url)}`,
      err,
    );
  }

  const b64 = raw?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new CoverImageError(
      'cover_generation_failed',
      `routerai images: response has no data[0].b64_json at ${urlPathname(url)}`,
    );
  }

  const cost = Number(raw?.usage?.cost);
  return {
    buffer: Buffer.from(b64, 'base64'),
    costRub: Number.isFinite(cost) ? cost : 0,
    raw,
  };
}
