/**
 * Yandex Search API REST routes (legacy, provider-specific).
 *
 * Exposes the async/poll search cycle to the UI and worker. Mounted under
 * /api/yandex by express-app.mjs.
 *
 *   POST /api/yandex/search  body { query, page?, region? }
 *     → { success, data: { results, totalOperations, elapsedMs } }
 *
 * The generic, backend-agnostic API lives in server/routes/web-search.mjs
 * (GET /api/search/backends, POST /api/search/search).
 */
import { Router } from 'express';
import { searchYandex, getApiKey } from '../lib/yandex-search.mjs';

const router = Router();

/**
 * POST /search
 * Run a Yandex search. The full async/poll cycle runs server-side and the
 * parsed results are returned in a single response.
 */
router.post('/search', async (req, res) => {
  try {
    const { query, page, region } = req.body || {};

    if (!query || typeof query !== 'string' || query.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Параметр query обязателен и должен содержать не менее 3 символов.',
      });
    }

    if (!getApiKey()) {
      return res.status(400).json({
        success: false,
        error: 'Yandex Search API key не настроен (GENERAPTOR_YANDEX_API_KEY).',
      });
    }

    const data = await searchYandex({
      query: query.trim(),
      page: page ?? 0,
      region: region ?? '213',
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[YandexSearch] Ошибка поиска:', err.message);
    const status = err.message?.includes('не настроен') ? 400 : 500;
    return res.status(status).json({
      success: false,
      error: err.message || 'Не удалось выполнить поиск Yandex.',
    });
  }
});

export default router;
