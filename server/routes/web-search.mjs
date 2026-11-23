/**
 * Generic web-search HTTP API.
 *
 *   GET  /api/search/backends → the available backends (settings page)
 *   POST /api/search/search   → search results
 *
 * The endpoint never answers 5xx: a missing key, an exhausted quota, a
 * blocked keyless backend or a dead network degrade into HTTP 200 with
 * `degraded: true` and an empty result set.
 */
import { Router } from 'express';
import {
  searchWeb,
  describeSearchBackends,
  describeVerticalBackends,
  resolveSearchBackend,
  getSearchLang,
  DEFAULT_SEARCH_BACKEND,
  SEARCH_BACKEND_IDS,
} from '../lib/web-search/index.mjs';
import { probeSerperSearchKey, probeYandexSearchKey, probeTavilySearchKey } from '../lib/api-key-probe.mjs';
import { getApiKey as getYandexApiKey } from '../lib/yandex-search.mjs';

const router = Router();

/**
 * The backends whose key can be probed. The narrow verticals are keyless —
 * there is nothing to check, so they are not probeable.
 */
const PROBEABLE_BACKENDS = ['serper', 'yandex', 'tavily'];

/**
 * Minimal interval between two probes of the same backend (ms).
 *
 * A probe of Serper.dev consumes one request of the free quota, and the
 * button "Проверить ключ" is not protected against a spammer — without the
 * cooldown the owner burns the quota of the provider by clicking it twice.
 * The same guard as in server/routes/api-keys.mjs.
 */
const PROBE_COOLDOWN_MS = 30_000;

/** The last probe per backend — the cooldown guard. */
const lastProbeByBackend = new Map();

/**
 * Remembers the probe of a backend for the cooldown.
 *
 * The cooldown protects the quota of the provider, so it is remembered only
 * when a request was really sent (a key was present). A probe without a key
 * costs nothing and must not block the next attempt.
 *
 * @param {string} backend
 * @param {string|null} key
 * @param {object} result
 */
function rememberProbe(backend, key, result) {
  if (!key) return;
  lastProbeByBackend.set(backend, { ...result, checkedAt: new Date().toISOString() });
}

function readQuery(body) {
  const raw = body?.query ?? body?.q ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function readLimit(body) {
  const parsed = Number.parseInt(String(body?.limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(parsed, 25);
}

function readLang(body) {
  const raw = String(body?.lang ?? '').trim().toLowerCase();
  return raw === 'en' ? 'en' : raw === 'ru' ? 'ru' : null;
}

function readBackend(body) {
  const raw = String(body?.backend ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return raw === 'auto' || SEARCH_BACKEND_IDS.includes(raw) ? raw : undefined;
}

/**
 * GET /api/search/backends
 */
router.get('/backends', (req, res) => {
  const resolved = resolveSearchBackend(process.env);
  res.json({
    success: true,
    data: {
      backends: describeSearchBackends(process.env),
      // The narrow verticals are listed separately: they are not a tier of
      // the chain and they are consulted only when the topic matches.
      verticals: describeVerticalBackends(),
      selected: resolved.id,
      defaultBackend: DEFAULT_SEARCH_BACKEND,
      lang: getSearchLang(process.env),
      warning: resolved.warning,
    },
  });
});

/**
 * POST /api/search/search
 */
router.post('/search', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = readQuery(body);
  const limit = readLimit(body);
  const lang = readLang(body);
  const backend = readBackend(body);

  try {
    const outcome = await searchWeb({
      query,
      limit,
      lang: lang || undefined,
      backend,
    });
    res.json({ success: true, data: outcome });
  } catch (err) {
    // searchWeb() never throws, but the route must stay 5xx-free.
    console.warn('[WebSearch] search failed (degraded):', err?.message || err);
    res.json({
      success: true,
      data: {
        results: [],
        backend: null,
        degraded: true,
        reason: 'internal_error',
        lang: lang || getSearchLang(process.env),
        limit,
        attempts: [],
      },
    });
  }
});

/**
 * POST /api/search/probe
 * Проверяет ключ конкретного платного backend-а.
 * Ключ читается из окружения сервера и уходит только на канонический endpoint
 * провайдера — ответ никогда не содержит значение ключа.
 */
router.post('/probe', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const backend = String(body.backend || '').trim().toLowerCase();

  if (!PROBEABLE_BACKENDS.includes(backend)) {
    return res.status(400).json({
      success: false,
      error: `Проба доступна только для backend-ов с ключом: tavily, serper, yandex. Получено: ${backend || '—'}.`,
    });
  }

  // Cooldown: no network request when the previous probe was recent.
  const cached = lastProbeByBackend.get(backend);
  if (cached?.checkedAt) {
    const elapsed = Date.now() - new Date(cached.checkedAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PROBE_COOLDOWN_MS) {
      const waitSec = Math.ceil((PROBE_COOLDOWN_MS - elapsed) / 1000);
      return res.json({
        success: true,
        data: {
          backend,
          ok: false,
          level: 'warning',
          cooldown: true,
          waitSec,
          message:
            `Повторите через ${waitSec} с — частые проверки тратят квоту провайдера.`,
        },
      });
    }
  }

  try {
    if (backend === 'serper') {
      const key = process.env.GENERAPTOR_SERPER_API_KEY;
      const result = await probeSerperSearchKey(key);
      rememberProbe(backend, key, result);
      return res.json({ success: true, data: { backend, ...result } });
    }
    if (backend === 'yandex') {
      const key = getYandexApiKey();
      const result = await probeYandexSearchKey(key);
      rememberProbe(backend, key, result);
      return res.json({ success: true, data: { backend, ...result } });
    }
    if (backend === 'tavily') {
      const key = process.env.GENERAPTOR_TAVILY_API_KEY;
      const result = await probeTavilySearchKey(key);
      rememberProbe(backend, key, result);
      return res.json({ success: true, data: { backend, ...result } });
    }
    return res.status(400).json({
      success: false,
      error: `Проба доступна только для backend-ов с ключом: tavily, serper, yandex. Получено: ${backend || '—'}.`,
    });
  } catch (err) {
    console.warn('[WebSearch] probe failed (degraded):', err?.message || err);
    return res.json({
      success: true,
      data: {
        backend,
        ok: false,
        level: 'warning',
        message: 'Проверка не прошла: нет связи с провайдером',
      },
    });
  }
});

export const webSearchRoutes = router;
export default router;