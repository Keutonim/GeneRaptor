/**
 * Provider settings + model catalog API (M3).
 *
 * Two routers (mounted in server/express-app.mjs AFTER requireGate):
 *   settings (default export) at /api/settings/providers:
 *     GET  /            → { success, data:{ providers:[ 4 masked cards ] } }
 *     PUT  /:kind       → upsert (masked card back); 400 { error:{ code } }
 *                         on typed validation errors;
 *     POST /:kind/test  → probe result (ok|warning|error + latencyMs);
 *                         body { model } = «пингануть выбранную модель»;
 *                         30 s cooldown per kind+model (quota guard, the
 *                         api-keys.mjs pattern).
 *   catalog (named export) at /api/providers:
 *     GET  /:kind/models → proxies GET {base}/models of that provider.
 *
 * Security (D10, docs/security.md §3): key values NEVER appear in any
 * response or log — only masked facts (keyConfigured/keySource/envKey) and
 * probe results. The internal descriptor (with the key) is used strictly
 * server-side for the probe and the catalog proxy.
 */
import { Router } from 'express';

import {
  listProviderDescriptors,
  getProviderDescriptor,
  saveProviderConfig,
  ProviderConfigError,
  isProviderKind,
} from '../lib/providers.mjs';
import { probeOpenAICompatible } from '../lib/api-key-probe.mjs';

/* ------------------------------------------------------------------ */
/*  Settings router                                                    */
/* ------------------------------------------------------------------ */

const settingsRouter = Router();

function success(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, error, status = 400) {
  // error: string message or { code, message } (typed storage errors).
  const payload =
    typeof error === 'string' || error instanceof Error
      ? { message: String(error.message ?? error) }
      : { code: error.code, message: error.message };
  return res.status(status).json({ success: false, error: payload });
}

/**
 * GET / — masked cards for all 4 registry kinds (one settings section row
 * per kind), merged with their ProviderConfig rows. No key material.
 */
settingsRouter.get('/', async (req, res) => {
  try {
    const providers = await listProviderDescriptors();
    // probeStatus from the in-memory cache below (unknown until first test).
    const cards = providers.map((card) => {
      const cached = probeCache.get(card.kind) ?? null;
      return {
        ...card,
        probeStatus: cached ? cached.level : 'unknown',
        probeCheckedAt: cached ? cached.checkedAt : null,
      };
    });
    return success(res, { providers: cards });
  } catch (err) {
    console.error('[Providers] list failed:', err?.message || err);
    return fail(res, 'Не удалось получить список провайдеров', 500);
  }
});

/**
 * PUT /:kind — masked write through the storage API (D10). Body (all
 * optional): { baseUrl?, apiKey?, clearApiKey?, enabled?, models? }.
 */
settingsRouter.put('/:kind', async (req, res) => {
  const { kind } = req.params;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const saved = await saveProviderConfig(kind, body);
    return success(res, saved);
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return fail(res, { code: err.code, message: err.message }, 400);
    }
    console.error('[Providers] save failed:', err?.message || err);
    return fail(res, 'Не удалось сохранить провайдера', 500);
  }
});

/**
 * Last probe result per provider (in memory, resets on restart) — powers
 * probeStatus/probeCheckedAt on the settings cards. Keyed by kind only;
 * the model ping cooldown below is keyed by kind+model.
 */
const probeCache = new Map();

/** Test-hook + invalidation point (the api-keys.mjs pattern). */
export function resetProvidersProbeCache() {
  probeCache.clear();
  lastProbeByKey.clear();
}

/** Cooldown between two probes of the same kind+model (quota guard, 30 s). */
const PROBE_COOLDOWN_MS = 30_000;
const lastProbeByKey = new Map();

/**
 * POST /:kind/test — real probe of the provider: key ping
 * (GET /models → 1-token chat fallback) or, with body { model }, a ping of
 * EXACTLY that model. The key value is passed only in the Authorization
 * header and never surfaces in the response.
 */
settingsRouter.post('/:kind/test', async (req, res) => {
  const { kind } = req.params;
  if (!isProviderKind(kind)) {
    return fail(res, { code: 'unknown_provider_kind', message: `Неизвестный провайдер: ${kind}` }, 400);
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const cooldownKey = `${kind}::${model ?? ''}`;

  const cached = lastProbeByKey.get(cooldownKey);
  if (cached?.checkedAt) {
    const elapsed = Date.now() - new Date(cached.checkedAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PROBE_COOLDOWN_MS) {
      const waitSec = Math.ceil((PROBE_COOLDOWN_MS - elapsed) / 1000);
      const agoSec = Math.max(1, Math.round(elapsed / 1000));
      return success(res, {
        provider: kind,
        ok: false,
        level: 'warning',
        message: `Проверка уже выполнялась ${agoSec} с назад. Повторите через ${waitSec} с — частые проверки тратят квоту провайдера.`,
        latencyMs: cached.latencyMs ?? null,
        checkedAt: cached.checkedAt,
        cooldown: true,
      });
    }
  }

  let descriptor;
  try {
    descriptor = await getProviderDescriptor(kind);
  } catch (err) {
    console.error('[Providers] probe resolve failed:', err?.message || err);
    return fail(res, 'Не удалось разрешить провайдера', 500);
  }

  let result;
  if (descriptor.endpointRejected || !descriptor.baseUrl) {
    // SEC-02: a rejected endpoint never becomes an outbound target — the probe
    // reports the refusal instead of calling the host.
    result = {
      ok: false,
      level: 'warning',
      message: 'Адрес провайдера отклонён политикой безопасности — проверка не выполнялась',
      latencyMs: 0,
      statusCode: null,
    };
  } else {
    try {
      result = await probeOpenAICompatible(descriptor.apiKey, {
        baseUrl: descriptor.baseUrl,
        model,
        kind,
        endpointSource: descriptor.endpointSource,
        keyOptional: descriptor.keyOptional,
        label: descriptor.label,
        fallbackModel: descriptor.models?.standard,
      });
    } catch (err) {
      // The probe must never take the route down; details stay server-side.
      console.error('[Providers] probe failed:', err?.message || err);
      result = {
        ok: false,
        level: 'warning',
        message: 'Проверка не прошла: нет связи с провайдером',
        latencyMs: 0,
      };
    }
  }

  const checkedAt = new Date().toISOString();
  lastProbeByKey.set(cooldownKey, { ...result, checkedAt });
  probeCache.set(kind, { ...result, checkedAt });

  return success(res, {
    provider: kind,
    ok: result.level === 'ok',
    level: result.level,
    message: result.message,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode ?? null,
    checkedAt,
  });
});

export default settingsRouter;

/* ------------------------------------------------------------------ */
/* Catalog router — first server-side model catalog route */
/* ------------------------------------------------------------------ */

const catalogRouter = Router();

const CATALOG_TIMEOUT_MS = 10_000;

/**
 * GET /:kind/models — proxies GET {base}/models of the provider and
 * normalizes the OpenAI shape ({ data:[{id}] }) to { models:[{id}] }.
 * Honest failures only: HTTP status + own message, never the provider's
 * body (it may echo the request) and never the key.
 */
catalogRouter.get('/:kind/models', async (req, res) => {
  const { kind } = req.params;
  if (!isProviderKind(kind)) {
    return fail(res, { code: 'unknown_provider_kind', message: `Неизвестный провайдер: ${kind}` }, 400);
  }

  let descriptor;
  try {
    descriptor = await getProviderDescriptor(kind);
  } catch (err) {
    console.error('[Providers] catalog resolve failed:', err?.message || err);
    return fail(res, 'Не удалось разрешить провайдера', 500);
  }

  if (!descriptor.apiKey && !descriptor.keyOptional) {
    return fail(res, { code: 'provider_key_missing', message: 'Ключ провайдера не настроен' }, 400);
  }

  // SEC-02: a rejected endpoint is never called — and the provider's own HTTP
  // status is never echoed for it (there is no provider response to echo).
  if (descriptor.endpointRejected || !descriptor.baseUrl) {
    return fail(
      res,
      { code: 'provider_endpoint_rejected', message: 'Адрес провайдера отклонён политикой безопасности' },
      502,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const url = `${descriptor.baseUrl}/models`;
    const response = await fetch(url, {
      method: 'GET',
      headers: descriptor.apiKey ? { Authorization: `Bearer ${descriptor.apiKey}` } : {},
      signal: controller.signal,
    });

    if (!response.ok) {
      // Own message only — the provider body can echo request internals.
      return fail(res, `Провайдер вернул HTTP ${response.status} на запрос каталога моделей`, 502);
    }

    const json = await response.json().catch(() => null);
    const rawList = Array.isArray(json?.data) ? json.data : [];
    const models = rawList
      .map((entry) => (entry && typeof entry.id === 'string' ? { id: entry.id } : null))
      .filter(Boolean);

    return success(res, { models });
  } catch {
    return fail(res, 'Каталог моделей недоступен: нет связи с провайдером', 502);
  } finally {
    clearTimeout(timer);
  }
});

export const providerCatalogRoutes = catalogRouter;
