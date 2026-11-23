/**
 * End-to-end tests for the REAL article-generation worker.
 *
 * `server/workers/article-generation.mjs` exports `processArticleGeneration(job)`.
 * Until now nothing covered it end-to-end: the existing suite only exercised
 * the role-level engine (`callRouterAIWithFallbackChain`) and a fake queue
 * processor. These tests drive the real worker against a local fake
 * OpenAI-compatible provider, so the orchestration, the DB writes (Article,
 * AgentRun, ArticleVersion) and the failure branches are covered for real.
 *
 * Guarantees:
 *  - no external network: the fake provider listens on 127.0.0.1 and a fetch
 *    guard hard-blocks every non-loopback request (the research stage of the
 *    worker is not key-gated and would otherwise reach the internet);
 *  - no real keys: the provider row in SQLite points at the fake server;
 *  - deterministic: every provider answer is a canned fixture.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRoleOutputContract } from '../../server/agent-role-contracts.mjs';
import { agentRoleData } from '../../server/agent-role-data.mjs';
import { prisma } from '../../server/db.mjs';
import { processArticleGeneration } from '../../server/workers/article-generation.mjs';
import {
  ALL_ROLE_IDS,
  FAQ_RESPONSE,
  buildRoleOutputs,
  installLoopbackOnlyFetchGuard,
  startRoleAwareFakeProvider,
} from '../helpers/worker-fake-provider.mjs';

const ENV_KEYS = [
  'ROUTERAI_API_KEY',
  'ROUTERAI_ENDPOINT',
  'ROUTERAI_MODEL_CRITICAL',
  'ROUTERAI_MODEL_GENERATION',
  'ROUTERAI_MODEL_STANDARD',
  'OPENROUTER_API_KEY',
  'OLLAMA_API_KEY',
  'CUSTOM_API_KEY',
];

/** Agent name of the local post-check run (server/lib/article-postcheck.mjs). */
const POSTCHECK_AGENT_NAME = 'Пост-проверка качества';

/** Hosts of the research stage of the worker — the only outbound calls it may try. */
const RESEARCH_HOST_PATTERN =
  /api\.tavily\.com|duckduckgo\.com|serper\.dev|api\.cloud\.yandex\.net|wikipedia\.org|wikidata\.org/i;

/** Roles that the quality gate re-runs after a blocked finalization. */
const QUALITY_RESET_ROLE_IDS = [
  'article-author',
  'factchecker',
  'seo-reviewer',
  'quality-controller',
  'humanizer',
];

const roleName = (roleId) => agentRoleData.find((role) => role.id === roleId)?.nameRu ?? roleId;

function createJob(articleId) {
  const progressCalls = [];
  return {
    id: `test-job-${articleId}`,
    data: { articleId },
    progressCalls,
    async updateProgress(percent) {
      progressCalls.push(percent);
    },
  };
}

describe('processArticleGeneration — реальная оркестрация воркера', () => {
  let provider = null;
  let guard = null;

  beforeEach(async () => {
    for (const key of ENV_KEYS) vi.stubEnv(key, '');
    // Loopback-провайдер разрешён только с этим флагом (server/lib/provider-url.mjs).
    vi.stubEnv('GENERAPTOR_ALLOW_PRIVATE_NETWORK', 'true');

    await prisma.agentRun.deleteMany();
    await prisma.articleVersion.deleteMany();
    await prisma.article.deleteMany();
    await prisma.providerConfig.deleteMany();

    guard = installLoopbackOnlyFetchGuard();
  });

  afterEach(async () => {
    guard?.restore();
    guard = null;
    if (provider) {
      await provider.stop();
      provider = null;
    }
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function startProvider(respond) {
    provider = await startRoleAwareFakeProvider({ respond });
    await prisma.providerConfig.create({
      data: {
        kind: 'custom',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-fake-local-key',
        enabled: true,
        modelsJson: JSON.stringify({
          critical: 'fake-critical',
          generation: 'fake-gen',
          standard: 'fake-std',
        }),
      },
    });
    return provider;
  }

  async function createArticle() {
    return prisma.article.create({
      data: {
        topic: 'Имплантация зубов под ключ',
        targetLength: 4000,
        status: 'queued',
      },
    });
  }

  it('прогоняет статью по всем ролям и сохраняет финальный текст в БД', async () => {
    const outputs = buildRoleOutputs();
    const fake = await startProvider(({ roleId }) => {
      // Служебный FAQ-вызов воркера идёт без маркера роли.
      if (!roleId) return { json: FAQ_RESPONSE };
      return { json: outputs[roleId] };
    });

    const article = await createArticle();
    const job = createJob(article.id);

    await processArticleGeneration(job);

    const updated = await prisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('ready');
    expect(updated.needsReviewReason).toBeNull();

    // Финальный текст лежит в ArticleVersion, а не в Article.
    const versions = await prisma.articleVersion.findMany({ where: { articleId: article.id } });
    expect(versions).toHaveLength(1);
    const version = versions[0];
    expect(version.platform).toBe('base');
    expect(version.characterCount).toBeGreaterThan(500);
    expect(version.contentMarkdown.toLowerCase()).toContain('чистка лица');
    expect(version.contentHtml.length).toBeGreaterThan(200);

    // Журнал стадий: по одному AgentRun на роль + пост-проверка.
    const runs = await prisma.agentRun.findMany({ where: { articleId: article.id } });
    const roleRuns = runs.filter((run) => run.agentName !== POSTCHECK_AGENT_NAME);
    expect(roleRuns.map((run) => run.agentName).sort()).toEqual(
      agentRoleData.map((role) => role.nameRu).sort(),
    );

    for (const run of roleRuns) {
      expect(run.status, `статус роли «${run.agentName}»`).toBe('completed');
      expect(run.progress).toBe(100);
      expect(run.finishedAt, `finishedAt роли «${run.agentName}»`).not.toBeNull();
      expect(run.inputTokens).toBe(5);
      expect(run.outputTokens).toBe(7);

      const output = JSON.parse(run.outputJson);
      const role = agentRoleData.find((item) => item.nameRu === run.agentName);
      expect(output.structured?.data, `structured.data роли «${run.agentName}»`).toBeTruthy();
      expect(Object.keys(output.structured.data)).toContain(
        getRoleOutputContract(role.id).required[0],
      );
    }

    const postcheckRuns = runs.filter((run) => run.agentName === POSTCHECK_AGENT_NAME);
    expect(postcheckRuns).toHaveLength(1);
    expect(postcheckRuns[0].status).toBe('completed');

    // Провайдер получил ровно один запрос на роль, в порядке пайплайна.
    const roleCallOrder = fake
      .chatRequests()
      .filter((request) => request.roleId)
      .map((request) => request.roleId);
    expect(roleCallOrder).toEqual(ALL_ROLE_IDS);
    expect(fake.chatRequests().filter((request) => !request.roleId)).toHaveLength(1);

    // Прогресс-леджер задания.
    expect(job.progressCalls.length).toBeGreaterThanOrEqual(ALL_ROLE_IDS.length);
    expect(job.progressCalls.at(-1)).toBe(100);
    expect([...job.progressCalls].sort((a, b) => a - b)).toEqual(job.progressCalls);

    // Исследовательская стадия пыталась выйти в сеть — guard её заблокировал.
    expect(guard.blocked.length).toBeGreaterThan(0);
    for (const url of guard.blocked) {
      expect(url, `незаблокированный внешний запрос: ${url}`).toMatch(RESEARCH_HOST_PATTERN);
    }
  }, 30000);

  it('при 502 на роли автора не зовёт FAQ-генератор по шаблонному черновику', async () => {
    // FIX-M2 (2026-08-17) + W1.3: transient-сбой роли автора → воркер строит
    // ШАБЛОННЫЙ черновик и помечает его маркером _fallbackTemplate
    // (server/workers/article-generation.mjs:1814). FAQ по такому черновику —
    // это вызов по мёртвому провайдеру (~9 мин ожидания до fail-safe), поэтому
    // FAQ-генератор НЕ должен вызываться НИ в аварийном пути finalizeWithFallback
    // (там маркер уже учитывался — см. :3234-3235), НИ в обычной финализации.
    // Бюджет ретраев и цепочка моделей к контракту FAQ-пропуска отношения не
    // имеют — отключаем их, чтобы тест не ждал backoff-паузу на 502.
    vi.stubEnv('ROUTERAI_MAX_RETRIES', '0');
    vi.stubEnv('ROUTERAI_FALLBACK_CHAIN', 'off');

    const outputs = buildRoleOutputs();
    const fake = await startProvider(({ roleId }) => {
      // Служебный FAQ-вызов воркера идёт без маркера роли.
      if (!roleId) return { json: FAQ_RESPONSE };
      if (roleId === 'article-author') {
        return { status: 502, json: { error: { message: 'bad gateway' } } };
      }
      return { json: outputs[roleId] };
    });

    const article = await createArticle();
    const job = createJob(article.id);

    await processArticleGeneration(job);

    // Черновик-шаблон сохранён: статья готова, версия создана.
    const updated = await prisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('ready');
    const versions = await prisma.articleVersion.findMany({ where: { articleId: article.id } });
    expect(versions).toHaveLength(1);

    // Автор отработал шаблонным fallback'ом — в журнале роль закрыта с пометкой.
    const runs = await prisma.agentRun.findMany({ where: { articleId: article.id } });
    const authorRun = runs.find((run) => run.agentName === roleName('article-author'));
    expect(authorRun.status).toBe('completed');
    expect(authorRun.error).toContain('fallback:');

    // ГЛАВНОЕ УТВЕРЖДЕНИЕ: FAQ-вызов (запрос без маркера роли) НЕ состоялся.
    // До фикса здесь был 1 вызов — FAQ-генератор прогонялся по шаблону.
    expect(fake.roleCallCounts()['(no-role)'] ?? 0).toBe(0);
    expect(versions[0].contentMarkdown).not.toContain('Вопрос 1 об имплантации зубов?');
  }, 30000);

  it('при живом авторском тексте FAQ-генератор вызывается ровно один раз', async () => {
    // Обратная сторона фикса: пропуск FAQ по _fallbackTemplate не должен
    // стать общим правилом. Живой автор (без маркера) → FAQ генерируется
    // как раньше: у faq-генератора свой fail-safe, терять FAQ живой статьи
    // дороже одного служебного вызова (W1.3, 2026-08-17).
    const outputs = buildRoleOutputs();
    const fake = await startProvider(({ roleId }) => {
      if (!roleId) return { json: FAQ_RESPONSE };
      return { json: outputs[roleId] };
    });

    const article = await createArticle();
    const job = createJob(article.id);

    await processArticleGeneration(job);

    // Ровно один служебный вызов FAQ-генератора (без маркера роли).
    expect(fake.roleCallCounts()['(no-role)'] ?? 0).toBe(1);

    // FAQ-блок реально попал в финальный текст статьи.
    const versions = await prisma.articleVersion.findMany({ where: { articleId: article.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].contentMarkdown).toContain('Вопрос 1 об имплантации зубов?');
  }, 30000);

  it('после исчерпания quality-ретраев уводит статью в needs_review, но контент сохраняет', async () => {
    const outputs = buildRoleOutputs({ finalizationAllowed: false });
    const fake = await startProvider(({ roleId }) => {
      if (!roleId) return { json: FAQ_RESPONSE };
      return { json: outputs[roleId] };
    });

    const article = await createArticle();
    const job = createJob(article.id);

    await expect(processArticleGeneration(job)).resolves.toBeUndefined();

    const updated = await prisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('needs_review');
    expect(updated.needsReviewReason).toContain('Качество не сошлось за 4 попыток');

    // Контент всё равно сохранён — ветка needs_review вызывает saveFinalVersion.
    const versions = await prisma.articleVersion.findMany({ where: { articleId: article.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].characterCount).toBeGreaterThan(500);

    // Реальный цикл ретраев quality-гейта: 4 попытки, humanizer не достигнут.
    const counts = fake.roleCallCounts();
    expect(counts['quality-controller']).toBe(4);
    expect(counts['article-author']).toBe(4);
    expect(counts['factchecker']).toBe(4);
    expect(counts['seo-reviewer']).toBe(4);
    expect(counts['humanizer']).toBeUndefined();
    for (const roleId of ALL_ROLE_IDS.filter((id) => !QUALITY_RESET_ROLE_IDS.includes(id))) {
      expect(counts[roleId], `число вызовов роли «${roleId}»`).toBe(1);
    }

    // В журнале видно все четыре прогона контролёра качества.
    const qcRuns = await prisma.agentRun.findMany({
      where: { articleId: article.id, agentName: roleName('quality-controller') },
    });
    expect(qcRuns).toHaveLength(4);
    for (const run of qcRuns) {
      expect(run.status).toBe('completed');
      expect(JSON.parse(run.outputJson).structured.data.finalizationAllowed).toBe(false);
    }
  }, 30000);

  it('при 401 не маскирует ошибку шаблоном: статья failed, версия не создаётся', async () => {
    const outputs = buildRoleOutputs();
    const fake = await startProvider(({ roleId }) => {
      if (!roleId) return { json: FAQ_RESPONSE };
      if (roleId === 'article-author') {
        return { status: 401, json: { error: { message: 'invalid api key' } } };
      }
      return { json: outputs[roleId] };
    });

    const article = await createArticle();
    const job = createJob(article.id);

    // Auth-ошибка должна подниматься наружу как auth-ошибка, а не как шаблонная
    // статья и не как обезличенное «завершилась с ошибкой» (server/workers/article-generation.mjs:2106).
    await expect(processArticleGeneration(job)).rejects.toThrow(
      /Ошибка авторизации RouterAI \(401\)/,
    );

    const updated = await prisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('failed');

    const runs = await prisma.agentRun.findMany({ where: { articleId: article.id } });
    const authorRun = runs.find((run) => run.agentName === roleName('article-author'));
    expect(authorRun).toBeTruthy();
    expect(authorRun.status).toBe('failed');
    expect(authorRun.error).toContain('Ошибка авторизации RouterAI (401)');
    expect(authorRun.finishedAt).not.toBeNull();

    // Роли после article-author не запускались.
    for (const roleId of ['factchecker', 'seo-reviewer', 'quality-controller', 'humanizer']) {
      expect(runs.find((run) => run.agentName === roleName(roleId))).toBeUndefined();
    }

    // Финальная версия не создана.
    const versions = await prisma.articleVersion.findMany({ where: { articleId: article.id } });
    expect(versions).toHaveLength(0);

    // 401 не ретраится и не уходит в цепочку резервных моделей.
    expect(fake.roleCallCounts()['article-author']).toBe(1);
  }, 30000);
});
