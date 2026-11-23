// A consensus round that adds NO new links stops the expansion.
//
// The hole this file closes: Serper (and Tavily/Wikipedia/Wikidata) do not
// support pagination, yet the worker called searchWeb({page: round}) up to 5
// times — burning one provider credit per round for the SAME links and
// feeding duplicate URLs into buildConsensus (inflating supportCount).
//
// Contract pinned here (real worker + real SQLite test DB, mocked search/LLM,
// zero network):
//   - splitNewSources is a pure function: fresh = unseen signatures only;
//   - stable answer → searchWeb called exactly 2 times (initial + round 1),
//     not 6; the round's consensus facts are still built and persisted;
//   - control: an answer with NEW links every round → 6 calls, the
//     loop is NOT broken prematurely;
//   - mixed answer (old + new) → only the new sources are persisted/pushed;
//   - the list handed to buildConsensus carries no duplicate search-source
//     signatures (compared by canonicalSignature, not raw URL).
import { vi, test, expect, beforeAll, afterAll, describe, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { canonicalSignature } from '../../server/lib/url-normalize.mjs';

// ── vi.hoisted: mock fns shared by the vi.mock factories and the tests ─────
const { callRouterAIMock, broadcastProgressMock, searchWebMock, consensusSourceSnapshots } = vi.hoisted(() => ({
  callRouterAIMock: vi.fn(),
  broadcastProgressMock: vi.fn(),
  searchWebMock: vi.fn(),
  // Every sources list handed to buildConsensus, captured verbatim.
  consensusSourceSnapshots: [],
}));

// ── Mock agent-role-execution.mjs (same seam as article-generation.test) ───
vi.mock('../../server/agent-role-execution.mjs', async (importOriginal) => ({
  resolveEnvNumber: (await importOriginal()).resolveEnvNumber,
  buildSemanticCoreContext: (await importOriginal()).buildSemanticCoreContext,
  callRouterAI: callRouterAIMock,
  callRouterAIWithFallbackChain: async (payload, { chainInfo } = {}) => {
    const result = await callRouterAIMock(payload);
    if (chainInfo) chainInfo.model = payload.model;
    return result;
  },
  buildRoleExecutionPayload: (opts) => ({
    model: 'deepseek-v3.2',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: JSON.stringify({ roleId: opts?.roleId }) },
    ],
    temperature: 0.7,
    max_tokens: 2000,
  }),
  parseRoleExecutionResult: ({ roleId, response }) => {
    const content = response?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    return {
      roleId,
      content,
      parsed,
      structured: { hasContract: true, ok: true, data: parsed, summaryRu: 'summary' },
      structuredSummaryRu: 'summary',
      finishReason: 'stop',
      usage: response?.usage ?? null,
    };
  },
}));

vi.mock('../../server/websocket.mjs', () => ({
  broadcastProgress: broadcastProgressMock,
  createWebSocketServer: vi.fn(),
}));

vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
  articleGenerationQueue: { add: vi.fn() },
  sourceCrawlQueue: { add: vi.fn() },
  publicationQueue: { add: vi.fn() },
  addJob: vi.fn(),
}));

// ── Web-search: scenario-driven, deterministic, zero network ───────────────
const BASE_BATCH = [
  { url: 'https://alpha.example.com/overview', title: 'Alpha overview', snippet: 'Alpha snippet.' },
  { url: 'https://beta.example.com/guide', title: 'Beta guide', snippet: 'Beta snippet.' },
  { url: 'https://gamma.example.com/review', title: 'Gamma review', snippet: 'Gamma snippet.' },
  { url: 'https://delta.example.com/faq', title: 'Delta faq', snippet: 'Delta snippet.' },
  { url: 'https://epsilon.example.com/pricing', title: 'Epsilon pricing', snippet: 'Epsilon snippet.' },
];

/** A batch of five NEVER-seen links for call number n. */
function freshBatch(n) {
  return Array.from({ length: 5 }, (_, i) => ({
    url: `https://round${n}-source${i + 1}.example.com/page`,
    title: `Round ${n} source ${i + 1}`,
    snippet: `Snippet ${n}-${i + 1}.`,
  }));
}

// Mixed: three already-seen links + two new ones; every later call repeats it.
const MIXED_BATCH = [
  BASE_BATCH[0],
  BASE_BATCH[1],
  BASE_BATCH[2],
  { url: 'https://zeta.example.com/new-one', title: 'Zeta new one', snippet: 'Zeta snippet.' },
  { url: 'https://eta.example.com/new-two', title: 'Eta new two', snippet: 'Eta snippet.' },
];

let searchScenario = 'stable';
let searchCallCount = 0;

searchWebMock.mockImplementation(async () => {
  searchCallCount += 1;
  let results;
  if (searchScenario === 'fresh') results = freshBatch(searchCallCount);
  else if (searchScenario === 'mixed') results = searchCallCount === 1 ? BASE_BATCH : MIXED_BATCH;
  else results = BASE_BATCH;
  return {
    results,
    backend: 'wikipedia',
    degraded: false,
    reason: null,
    lang: 'ru',
    limit: 5,
    attempts: [],
  };
});

vi.mock('../../server/lib/web-search/index.mjs', () => ({
  searchWeb: searchWebMock,
}));

// ── buildConsensus: REAL implementation, wrapped only to record its input ──
vi.mock('../../server/lib/consensus-builder.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildConsensus: (sources, opts) => {
      consensusSourceSnapshots.push(
        (sources || []).map((s) => ({
          provider: s.provider,
          sourceUrl: s.sourceUrl,
          normalizedUrl: s.normalizedUrl,
        })),
      );
      return actual.buildConsensus(sources, opts);
    },
  };
});

// ── Real Prisma client → the per-run SQLite test DB (global-setup env) ─────
const prisma = new PrismaClient();

// ── Canned LLM outputs ──────────────────────────────────────────────────────
const FAQ_SYSTEM_MARKER_RE = /SEO-копирайтер/iu;
const CONSENSUS_SYSTEM_MARKER_RE = /строгий аналитик/iu;
const CANNED_FAQ_ITEMS = Array.from({ length: 10 }, (_, i) => ({
  question: `Неочевидный вопрос №${i + 1}?`,
  answer: `Краткий ответ ${i + 1}. Обоснование из двух предложений.`,
}));
// ONE fact (support 2) — below TARGET_FACTS=10, so the fact-goal stop never
// fires and the round-termination behaviour is what ends the loop.
const CANNED_CONSENSUS = {
  consensusFacts: [
    {
      factRu: 'Подтверждённый факт из двух независимых источников.',
      supportCount: 2,
      supportingSourceUrls: [
        'https://alpha.example.com/overview',
        'https://beta.example.com/guide',
      ],
    },
  ],
};

callRouterAIMock.mockImplementation(async (payload) => {
  const systemMsg = payload?.messages?.find((m) => m.role === 'system')?.content || '';
  if (CONSENSUS_SYSTEM_MARKER_RE.test(systemMsg)) {
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify(CANNED_CONSENSUS) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    };
  }
  if (FAQ_SYSTEM_MARKER_RE.test(systemMsg)) {
    return {
      status: 200,
      data: {
        choices: [{ message: { content: JSON.stringify({ items: CANNED_FAQ_ITEMS }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      },
    };
  }
  const { roleOutputs } = await import('../fixtures/role-outputs.mjs');
  let roleId = null;
  try {
    const userMsg = payload?.messages?.find((m) => m.role === 'user');
    if (userMsg) roleId = JSON.parse(userMsg.content).roleId;
  } catch {
    // ignore parse errors
  }
  const output = roleOutputs[roleId] || { stub: true };
  return {
    status: 200,
    data: {
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    },
  };
});

// ── Import the worker AFTER the mocks are in place ─────────────────────────
const { processArticleGeneration, splitNewSources } = await import('../../server/workers/article-generation.mjs');

async function createArticle(topic) {
  const id = crypto.randomUUID();
  await prisma.article.create({ data: { id, topic, targetLength: 50000 } });
  return id;
}

function jobFor(id, suffix) {
  return { data: { articleId: id }, id: `test-job-${suffix}`, updateProgress: vi.fn() };
}

/** Signatures of the SEARCH sources (consensus synthetics reference a support URL by design). */
function searchSignatures(snapshot) {
  return snapshot
    .filter((s) => s.provider !== 'consensus')
    .map((s) => s.normalizedUrl || canonicalSignature(s.sourceUrl));
}

beforeAll(async () => {
  await prisma.$connect();
  // Existing env names only — no new variables (I-9).
  process.env.CONSENSUS_MAX_ROUNDS = '5';
  process.env.CONSENSUS_MIN_FACTS = '10';
  process.env.CONSENSUS_MIN_SUPPORT = '2';
  await prisma.researchSource.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.articleVersion.deleteMany();
  await prisma.article.deleteMany();
  await prisma.companyProfile.deleteMany();
  await prisma.companyProfile.create({
    data: { name: 'Тестовая компания', activeText: 'Профиль компании для тестов.' },
  });
});

afterAll(async () => {
  delete process.env.CONSENSUS_MAX_ROUNDS;
  delete process.env.CONSENSUS_MIN_FACTS;
  delete process.env.CONSENSUS_MIN_SUPPORT;
  await prisma.$disconnect();
});

beforeEach(() => {
  searchCallCount = 0;
  consensusSourceSnapshots.length = 0;
  searchWebMock.mockClear();
  callRouterAIMock.mockClear();
});

describe('splitNewSources (pure function)', () => {
  const sig = (url) => canonicalSignature(url);

  test('empty candidates → empty fresh, signatures copy the seen set', () => {
    const seen = new Set([sig('https://a.example.com/1')]);
    const { fresh, signatures } = splitNewSources([], seen);
    expect(fresh).toEqual([]);
    expect([...signatures]).toEqual([sig('https://a.example.com/1')]);
  });

  test('all candidates new → all fresh, signatures extended', () => {
    const candidates = [
      { sourceUrl: 'https://a.example.com/1' },
      { sourceUrl: 'https://b.example.com/2' },
    ];
    const { fresh, signatures } = splitNewSources(candidates, new Set());
    expect(fresh).toHaveLength(2);
    expect(signatures.has(sig('https://a.example.com/1'))).toBe(true);
    expect(signatures.has(sig('https://b.example.com/2'))).toBe(true);
  });

  test('all candidates seen → nothing fresh', () => {
    const candidates = [{ sourceUrl: 'https://a.example.com/1' }];
    const { fresh } = splitNewSources(candidates, new Set([sig('https://a.example.com/1')]));
    expect(fresh).toEqual([]);
  });

  test('mixed candidates → only the unseen ones, in order', () => {
    const candidates = [
      { sourceUrl: 'https://a.example.com/1' },
      { sourceUrl: 'https://b.example.com/2' },
      { sourceUrl: 'https://c.example.com/3' },
    ];
    const { fresh } = splitNewSources(candidates, new Set([sig('https://a.example.com/1')]));
    expect(fresh.map((c) => c.sourceUrl)).toEqual([
      'https://b.example.com/2',
      'https://c.example.com/3',
    ]);
  });

  test('a candidate without a valid signature is never "new"', () => {
    const candidates = [
      { sourceUrl: 'javascript:alert(1)' },
      { sourceUrl: '' },
      {},
      { sourceUrl: 'https://ok.example.com/page' },
    ];
    const { fresh } = splitNewSources(candidates, new Set());
    expect(fresh).toHaveLength(1);
    expect(fresh[0].sourceUrl).toBe('https://ok.example.com/page');
  });

  test('normalizedUrl wins over sourceUrl; www/trailing-slash variants collapse', () => {
    const candidates = [
      { normalizedUrl: sig('https://x.example.com/canon'), sourceUrl: 'https://x.example.com/canon?ref=1' },
      { sourceUrl: 'https://www.x.example.com/canon/' },
      { sourceUrl: 'https://y.example.com/other' },
    ];
    const { fresh } = splitNewSources(candidates, new Set());
    expect(fresh).toHaveLength(2);
    expect(fresh[0].normalizedUrl).toBe(sig('https://x.example.com/canon'));
    expect(fresh[1].sourceUrl).toBe('https://y.example.com/other');
  });

  test('does not mutate the input array or the seen set', () => {
    const candidates = [{ sourceUrl: 'https://a.example.com/1' }];
    const seen = new Set([sig('https://b.example.com/2')]);
    const candidatesBefore = [...candidates];
    const seenBefore = [...seen];
    splitNewSources(candidates, seen);
    expect(candidates).toEqual(candidatesBefore);
    expect([...seen]).toEqual(seenBefore);
  });
});

describe('Consensus round termination (real worker, real SQLite)', () => {
  test('stable answer: searchWeb called 2 times (initial + round 1), facts still built and saved', async () => {
    searchScenario = 'stable';
    const id = await createArticle('Обзор источников: стабильная выдача');
    await processArticleGeneration(jobFor(id, 'stop-stable'));

    const article = await prisma.article.findUnique({ where: { id } });
    expect(article.status).toBe('ready');

    // The stop is proven by the CALL COUNTER, not by a log line.
    expect(searchWebMock).toHaveBeenCalledTimes(2);

    // Only the initial five sources are stored — no duplicate rows.
    const rows = await prisma.researchSource.findMany({ where: { articleId: id, provider: 'wikipedia' } });
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.normalizedUrl)).size).toBe(5);

    // The round's consensus ran and its synthetic fact was persisted.
    expect(consensusSourceSnapshots.length).toBeGreaterThanOrEqual(1);
    const consensusRows = await prisma.researchSource.findMany({ where: { articleId: id, provider: 'consensus' } });
    expect(consensusRows.length).toBeGreaterThanOrEqual(1);

    // The list handed to buildConsensus has no duplicate signatures.
    for (const snapshot of consensusSourceSnapshots) {
      const signatures = searchSignatures(snapshot);
      expect(new Set(signatures).size).toBe(signatures.length);
    }
    expect(searchSignatures(consensusSourceSnapshots[0])).toHaveLength(5);
  }, 60000);

  test('control: new links every round → 6 calls, the loop is not broken prematurely', async () => {
    searchScenario = 'fresh';
    const id = await createArticle('Обзор источников: новые ссылки каждый раунд');
    await processArticleGeneration(jobFor(id, 'control-fresh'));

    const article = await prisma.article.findUnique({ where: { id } });
    expect(article.status).toBe('ready');

    // 1 initial gathering + 5 rounds — every round added new links.
    expect(searchWebMock).toHaveBeenCalledTimes(6);

    const rows = await prisma.researchSource.findMany({ where: { articleId: id, provider: 'wikipedia' } });
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.normalizedUrl)).size).toBe(30);

    // No duplicate search-source signatures in ANY consensus input.
    for (const snapshot of consensusSourceSnapshots) {
      const signatures = searchSignatures(snapshot);
      expect(new Set(signatures).size).toBe(signatures.length);
    }
  }, 60000);

  test('mixed answer: only the 2 new sources are stored; the next empty round stops the loop', async () => {
    searchScenario = 'mixed';
    const id = await createArticle('Обзор источников: смесь старых и новых');
    await processArticleGeneration(jobFor(id, 'mixed'));

    const article = await prisma.article.findUnique({ where: { id } });
    expect(article.status).toBe('ready');

    // initial + round 1 (2 new) + round 2 (0 new → stop).
    expect(searchWebMock).toHaveBeenCalledTimes(3);

    const rows = await prisma.researchSource.findMany({ where: { articleId: id, provider: 'wikipedia' } });
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.normalizedUrl)).size).toBe(7);
    expect(rows.some((r) => r.normalizedUrl === canonicalSignature('https://zeta.example.com/new-one'))).toBe(true);
    expect(rows.some((r) => r.normalizedUrl === canonicalSignature('https://eta.example.com/new-two'))).toBe(true);
  }, 60000);
});
