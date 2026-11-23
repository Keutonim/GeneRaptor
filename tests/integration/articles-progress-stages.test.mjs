/**
 * Integration test: GET /api/articles/:id/progress — per-stage timeline.
 *
 * Contract:
 *   data.articleId — id of the requested article
 *   data.overall   — aggregate view of the run (status/percent/currentStage/…)
 *   data.stages[]  — the 11 pipeline stages in catalogue order:
 *                    { key, label, status, startedAt, finishedAt, durationMs }
 *
 * The timeline is derived from the AgentRun ledger — the existing single source
 * of truth. No second bookkeeping table is introduced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  autoGenerationQueue: { add: vi.fn(), removeRepeatable: vi.fn() },
  addJob: vi.fn(),
}));

import { createTestApp, startServer, testPrisma, truncateAll } from '../helpers.mjs';
import { agentRoleData } from '../../server/agent-role-data.mjs';

const T0 = new Date('2026-02-10T09:00:00.000Z');
const at = (offsetMs) => new Date(T0.getTime() + offsetMs);

let server;
let baseUrl;

beforeAll(async () => {
  const app = createTestApp();
  ({ server, baseUrl } = await startServer(app));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
});

async function call(method, path, { body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

async function seedArticle(status, runs = []) {
  const article = await testPrisma.article.create({
    data: { topic: 'Timeline', targetLength: 1000, status },
  });
  if (runs.length > 0) {
    await testPrisma.agentRun.createMany({
      data: runs.map((run) => ({ ...run, articleId: article.id })),
    });
  }
  return article;
}

describe('GET /api/articles/:id/progress — per-stage timeline', () => {
  it('returns 11 stages in catalogue order with per-stage durations taken from the AgentRun ledger', async () => {
    const article = await seedArticle('quality_control', [
      {
        agentName: 'Агент выбора темы',
        status: 'completed',
        startedAt: at(0),
        finishedAt: at(1200),
      },
      {
        agentName: 'Агент подготовки задания',
        status: 'completed',
        startedAt: at(5000),
        finishedAt: at(9000),
      },
      {
        agentName: 'Агент базы знаний',
        status: 'running',
        startedAt: at(10000),
      },
    ]);

    const { status, body } = await call('GET', `/api/articles/${article.id}/progress`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data;

    expect(data.articleId).toBe(article.id);
    expect(Array.isArray(data.stages)).toBe(true);
    expect(data.stages).toHaveLength(11);
    expect(data.stages.map((stage) => stage.key)).toEqual(agentRoleData.map((role) => role.id));
    expect(data.stages.map((stage) => stage.label)).toEqual(agentRoleData.map((role) => role.nameRu));

    // Stage 1 — finished run: duration is finishedAt - startedAt.
    expect(data.stages[0]).toEqual({
      key: 'topic-selector',
      label: 'Агент выбора темы',
      status: 'completed',
      startedAt: at(0).toISOString(),
      finishedAt: at(1200).toISOString(),
      durationMs: 1200,
    });

    // Stage 2 — finished run: duration is finishedAt - startedAt.
    expect(data.stages[1].status).toBe('completed');
    expect(data.stages[1].durationMs).toBe(4000);

    // Stage 3 — running run: no finishedAt yet, so no duration.
    expect(data.stages[2].status).toBe('running');
    expect(data.stages[2].startedAt).toBe(at(10000).toISOString());
    expect(data.stages[2].finishedAt).toBeNull();
    expect(data.stages[2].durationMs).toBeNull();

    // Stages 4..11 — never started.
    for (const stage of data.stages.slice(3)) {
      expect(stage.status).toBe('pending');
      expect(stage.startedAt).toBeNull();
      expect(stage.finishedAt).toBeNull();
      expect(stage.durationMs).toBeNull();
    }
  });

  it('marks the failed stage as failed and keeps the ledger error visible', async () => {
    const article = await seedArticle('failed', [
      {
        agentName: 'Агент фактчекинга',
        status: 'failed',
        error: 'Фактчекер упал',
        startedAt: at(0),
        finishedAt: at(700),
      },
    ]);

    const { status, body } = await call('GET', `/api/articles/${article.id}/progress`);

    expect(status).toBe(200);
    const failedStage = body.data.stages.find((stage) => stage.key === 'factchecker');
    expect(failedStage.status).toBe('failed');
    expect(failedStage.durationMs).toBe(700);
    expect(body.data.overall.status).toBe('failed');
    expect(body.data.overall.percent).toBeNull();
  });

  it('keeps the legacy flat progress fields intact (client contract) and adds the aggregate view', async () => {
    const article = await seedArticle('quality_control', [
      {
        agentName: 'Агент контроля качества',
        status: 'running',
        startedAt: at(0),
      },
    ]);

    const { status, body } = await call('GET', `/api/articles/${article.id}/progress`);

    expect(status).toBe(200);
    const data = body.data;

    // Legacy flat fields (src/hooks/useWebSocketProgress.ts reads these).
    expect(data.status).toBe('quality_control');
    expect(data.currentStage).toBe(10);
    expect(data.totalStages).toBe(11);
    expect(data.stageName).toBe('Агент контроля качества');
    expect(data.percent).toBe(82);
    expect(typeof data.message).toBe('string');

    // New aggregate view.
    expect(data.overall).toBeTruthy();
    expect(data.overall.status).toBe('quality_control');
    expect(data.overall.percent).toBe(82);
    expect(data.overall.currentStage).toBe(10);
    expect(data.overall.totalStages).toBe(11);
    expect(data.overall.completedStages).toBe(0);
    expect(data.overall.totalDurationMs).toBeNull();
  });

  it('reports an empty timeline for an article without agent runs', async () => {
    const article = await seedArticle('draft');

    const { status, body } = await call('GET', `/api/articles/${article.id}/progress`);

    expect(status).toBe(200);
    expect(body.data.stages).toHaveLength(11);
    expect(body.data.stages.every((stage) => stage.status === 'pending')).toBe(true);
    expect(body.data.overall.completedStages).toBe(0);
    expect(body.data.overall.totalDurationMs).toBeNull();
  });
});
