import type { Page, Route } from '@playwright/test';

/**
 * Общий фейковый API для e2e M6: подменяет HTTP-слой /api/** через page.route,
 * поэтому сценарии идут без Postgres/Redis (fake provider).
 *
 * Dev-5b: мок обязан отдавать ТОТ ЖЕ payload, что и настоящий сервер.
 * Раньше мок отдавал coverFile + coverStatus:'ready' из GET /content — payload,
 * которого реальный сервер не производил, — и этим маскировал дефект «content
 * route не отдаёт coverFile». Набор ключей зафиксирован сверху реального
 * маршрута (server/routes/articles.mjs) и проверяется в
 * tests/integration/cover-manual-flow.test.mjs.
 */

export const ARTICLE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
/** Имя файла обложки в локальном хранилище (M5): <articleId>-<n>.<ext>. */
export const COVER_FILE_NAME = `${ARTICLE_ID}-1.png`;
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

export interface MockState {
  exchanged: boolean;
  coverReady: boolean;
  deleted: boolean;
  coverBodies: Array<Record<string, unknown>>;
  created: Array<Record<string, unknown>>;
  /**
   * The startup token is single-use — the first successful exchange
   * consumes it (the real gate does the same, server/lib/startup-token.mjs).
   */
  tokenConsumed: boolean;
  /**
   * A journal of every intercepted request, so a test can
   * prove the client stops attaching Authorization after the exchange.
   */
  requests: Array<{ path: string; method: string; authorization: string | null }>;
}

/** The one startup token the fake accepts (single-use). */
export const STARTUP_TOKEN = 'startup-token';

/**
 * Payload of GET /api/articles/:id/content — the same shape the real route
 * produces (server/routes/articles.mjs, GET /articles/:id/content).
 */
export function buildContentPayload(state: MockState) {
  const ready = state.coverReady;
  return {
    title: 'Как выбрать провайдера',
    description: 'Короткое описание',
    h1: 'Как выбрать провайдера',
    contentHtml: '<p>Готовый текст статьи</p>',
    contentText: 'Готовый текст статьи',
    contentMarkdown: '# Как выбрать провайдера',
    characterCount: 65000,
    coverUrl: ready ? `/api/articles/${ARTICLE_ID}/cover` : null,
    coverFile: ready ? COVER_FILE_NAME : null,
    coverModel: ready ? 'qwen/qwen-image-2.1-pro' : null,
    coverCostRub: ready ? 13 : null,
    coverGeneratedAt: ready ? '2026-11-13T10:00:00.000Z' : null,
    coverStatus: ready ? 'ready' : null,
    coverSkipReason: null,
    coverAvailable: true,
    coverUnavailableReason: null,
  };
}

export function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export async function installFakeApi(
  page: Page,
  options?: { authenticated?: boolean },
): Promise<MockState> {
  const state: MockState = {
    exchanged: options?.authenticated ?? false,
    coverReady: false,
    deleted: false,
    coverBodies: [],
    created: [],
    tokenConsumed: options?.authenticated ?? false,
    requests: [],
  };

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    state.requests.push({
      path,
      method,
      authorization: route.request().headers()['authorization'] ?? null,
    });

    // The REAL server always answers 200 {authenticated} —
    // the truth is in the body, never in the HTTP status.
    if (path === '/api/auth/status') {
      return json(route, 200, { authenticated: state.exchanged });
    }

    // Single-use exchange, the real contract (200 {ok:true} / 401).
    if (path === '/api/auth/exchange') {
      const header = route.request().headers()['authorization'] ?? '';
      const bearer = header.replace(/^Bearer\s+/i, '').trim();
      if (bearer === STARTUP_TOKEN && !state.tokenConsumed) {
        state.tokenConsumed = true;
        state.exchanged = true;
        return json(route, 200, { ok: true });
      }
      return json(route, 401, { error: 'Токен не принят' });
    }

    if (path === '/api/settings/cover') {
      return json(route, 200, {
        success: true,
        data: { available: true, unavailableReason: null, estimatedCoverCostRub: 13 },
      });
    }

    if (path === '/api/settings/providers') {
      return json(route, 200, {
        success: true,
        data: {
          providers: [
            {
              kind: 'routerai',
              label: 'RouterAI',
              baseUrl: 'https://routerai.ru/api/v1',
              enabled: true,
              keyConfigured: true,
              keySource: 'local',
              envKey: null,
              keyOptional: false,
              imagesCapability: 'yes',
              models: {
                critical: 'qwen/qwen3.7-plus',
                generation: 'qwen/qwen3.6-flash',
                standard: 'deepseek/deepseek-v4-flash',
                cover: 'qwen/qwen-image-2.1-pro',
              },
              probeStatus: 'ok',
            },
          ],
        },
      });
    }

    if (path === '/api/settings/agent-roles') {
      return json(route, 200, {
        success: true,
        data: {
          roles: [
            {
              id: 'research-analyst',
              nameRu: 'Исследователь',
              systemPrompt: 'Промпт исследователя '.repeat(20),
              source: 'catalog',
              updatedAt: null,
            },
          ],
        },
      });
    }

    if (path === '/api/articles' && method === 'POST') {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      state.created.push(body);
      return json(route, 201, { success: true, data: { id: ARTICLE_ID } });
    }

    if (path === '/api/articles' && method === 'GET') {
      if (state.deleted) return json(route, 200, { success: true, data: [] });
      return json(route, 200, {
        success: true,
        data: [
          {
            id: ARTICLE_ID,
            topic: 'Как выбрать провайдера для статей',
            status: 'completed',
            targetLength: 65000,
            createdAt: '2026-11-13T10:00:00.000Z',
            language: 'ru',
          },
        ],
      });
    }

    if (path === `/api/articles/${ARTICLE_ID}/start`) {
      return json(route, 200, { success: true, data: {} });
    }

    if (path === `/api/articles/${ARTICLE_ID}/progress`) {
      return json(route, 200, {
        success: true,
        data: {
          status: 'completed',
          currentStage: 11,
          totalStages: 11,
          stageName: 'Готово',
          agentName: '',
          description: '',
          percent: 100,
          message: '',
        },
      });
    }

    if (path === `/api/articles/${ARTICLE_ID}/content`) {
      return json(route, 200, {
        success: true,
        data: buildContentPayload(state),
      });
    }

    if (path === `/api/articles/${ARTICLE_ID}/cover` && method === 'GET') {
      // M5 contract: no cover yet → 404 cover_not_found (the real route).
      if (!state.coverReady) {
        return json(route, 404, {
          success: false,
          error: 'Обложка не найдена',
          code: 'cover_not_found',
        });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 });
    }

    if (path === `/api/articles/${ARTICLE_ID}/cover` && method === 'POST') {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      state.coverBodies.push(body);
      state.coverReady = true;
      return json(route, 200, {
        success: true,
        data: {
          coverUrl: `/api/articles/${ARTICLE_ID}/cover`,
          coverFile: COVER_FILE_NAME,
          model: 'qwen/qwen-image-2.1-pro',
          costRub: 13,
          spentThisMonthRub: 13,
          monthlyCapRub: 300,
          promptPreview: 'Промпт обложки',
          warnings: [],
        },
      });
    }

    if (path === `/api/articles/${ARTICLE_ID}` && method === 'GET') {
      return json(route, 200, {
        success: true,
        data: {
          id: ARTICLE_ID,
          topic: 'Как выбрать провайдера для статей',
          status: 'completed',
          targetLength: 65000,
          createdAt: '2026-11-13T10:00:00.000Z',
          language: 'ru',
        },
      });
    }

    if (path === `/api/articles/${ARTICLE_ID}` && method === 'DELETE') {
      state.deleted = true;
      return json(route, 200, { success: true, data: {} });
    }

    return json(route, 404, { error: `no mock for ${method} ${path}` });
  });

  return state;
}
