/**
 * API-ключи: правдивый статус серверных ключей + реальная проба (волна 1, B3).
 *
 * Монтируется в server/express-app.mjs ПОСЛЕ requireGate:
 *   app.use('/api/settings/api-keys', apiKeysRoutes);
 *
 * Контракт:
 *   GET  /api/settings/api-keys       → { success, data: { providers: [...] } }
 *   POST /api/settings/api-keys/test  → { success, data: { provider, ok, level,
 *                                           message, latencyMs, checkedAt } }
 *   Повторная проба того же провайдера в течение 30 секунд НЕ делает сетевой
 *   запрос: отдаётся level 'warning' с пометкой cooldown (защита квоты).
 *
 * Значения ключей НИКОГДА не возвращаются и не логируются — наружу уходят
 * только булевы флаги, имена переменных env и результат пробы.
 */
import { Router } from 'express';
import {
  isApiKeyConfigured,
  probeRouterAiKey,
  probeYandexSearchKey,
} from '../lib/api-key-probe.mjs';

const router = Router();

/**
 * Провайдеры ровно два. `probe` — функция проверки из server/lib/api-key-probe.mjs.
 */
const PROVIDERS = [
  {
    id: 'routerai',
    label: 'RouterAI',
    envKey: 'ROUTERAI_API_KEY',
    probe: probeRouterAiKey,
  },
  {
    id: 'yandexSearch',
    label: 'Yandex Search API',
    envKey: 'YANDEX_SEARCH_API_KEY',
    probe: probeYandexSearchKey,
  },
];

/**
 * Последний результат пробы по каждому провайдеру — в памяти процесса.
 * Позволяет отличать «ключ не задан» (unknown) от «ключ отвергнут» (error)
 * и от «ключ принят, но поиск ограничен по частоте» (warning).
 * После рестарта сервера кэш пуст → probeStatus снова 'unknown'.
 */
const lastProbeByProvider = new Map();

/**
 * Сброс кэша последних проб. Нужен в тестах (кэш живёт в памяти процесса
 * и пережил бы отдельные кейсы) и как точка инвалидации, если ключ в .env
 * сменили и сервер перезапустили в том же процессе.
 */
export function resetApiKeyProbeCache() {
  lastProbeByProvider.clear();
}

function success(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, message, status = 400) {
  return res.status(status).json({ success: false, error: message });
}

/** Подсказка для незаданного ключа — что именно сделать владельцу. */
function buildHint(envKey) {
  return `Добавьте \`${envKey}\` в \`/opt/generaptor/.env\` и перезапустите контейнер`;
}

/**
 * GET / — статус серверных ключей (без значений ключей).
 */
router.get('/', (req, res) => {
  const providers = PROVIDERS.map((provider) => {
    const configured = isApiKeyConfigured(process.env[provider.envKey]);
    const cached = lastProbeByProvider.get(provider.id);

    // Незаданный ключ — это «неизвестно», а не «сломан»: stale-кэш не показываем.
    const probeStatus = !configured || !cached ? 'unknown' : cached.level;
    const probeCheckedAt = !configured || !cached ? null : cached.checkedAt;

    return {
      id: provider.id,
      label: provider.label,
      configured,
      envKey: provider.envKey,
      hint: configured ? null : buildHint(provider.envKey),
      probeStatus,
      probeCheckedAt,
    };
  });

  return success(res, { providers });
});

/**
 * Минимальный интервал между двумя пробами одного провайдера (мс).
 * TL P2-3: без cooldown владелец мог спамить кнопку «Проверить подключение»
 * и жечь квоту провайдера (RouterAI/Yandex считают запросы к лимиту).
 */
const PROBE_COOLDOWN_MS = 30_000;

/**
 * POST /test — реальная проверка серверного ключа.
 * Body: { provider: 'routerai' | 'yandexSearch' }
 *
 * Ответ всегда HTTP 200 при корректном body: результат проверки (ок или не
 * ок) — это ДАННЫЕ, а не ошибка сервера.
 */
router.post('/test', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const providerId = body.provider;

  if (providerId === undefined || providerId === null || providerId === '') {
    return fail(res, 'Не указан провайдер', 400);
  }

  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    return fail(res, 'Неизвестный провайдер', 400);
  }

  // Cooldown: не делаем сетевой запрос, если предыдущая проба была недавно.
  const cached = lastProbeByProvider.get(provider.id);
  if (cached?.checkedAt) {
    const elapsed = Date.now() - new Date(cached.checkedAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PROBE_COOLDOWN_MS) {
      const waitSec = Math.ceil((PROBE_COOLDOWN_MS - elapsed) / 1000);
      const agoSec = Math.max(1, Math.round(elapsed / 1000));
      const previous = typeof cached.message === 'string' && cached.message ? ` «${cached.message}»` : '';
      return success(res, {
        provider: provider.id,
        ok: cached.level === 'ok',
        level: 'warning',
        message:
          `Проверка уже выполнялась ${agoSec} с назад${previous}. ` +
          `Повторите через ${waitSec} с — частые проверки тратят квоту провайдера.`,
        latencyMs: cached.latencyMs ?? null,
        statusCode: cached.statusCode ?? null,
        checkedAt: cached.checkedAt,
        cooldown: true,
      });
    }
  }

  const apiKey = process.env[provider.envKey] || '';
  let result;
  try {
    result = await provider.probe(apiKey);
  } catch (err) {
    // Проба не должна ронять роут: детали ошибки наружу не отдаём.
    console.error('[ApiKeys] probe failed:', err?.message || err);
    result = {
      ok: false,
      level: 'warning',
      message: 'Проверка не прошла: нет связи с провайдером',
      latencyMs: 0,
    };
  }

  const checkedAt = new Date().toISOString();
  lastProbeByProvider.set(provider.id, { ...result, checkedAt });

  return success(res, {
    provider: provider.id,
    ok: result.level === 'ok',
    level: result.level,
    message: result.message,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode ?? null,
    checkedAt,
  });
});

export default router;
