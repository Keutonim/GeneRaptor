/**
 * Option A (2026-09-17): worker seam of the grounding score — attachGroundingScore.
 *
 * DB-free unit (pattern: tests/unit/author-signature.test.mjs): heavy worker
 * imports (redis queue, prisma, websocket) are mocked; attachGroundingScore is
 * exported from the worker exactly for this test.
 *
 * Contract under test: the score lands as the ADDITIVE summary key `grounding`
 * of the postcheck report; verdict / rules / pass-fail-skipped are untouched;
 * any failure leaves the report unchanged (report-only — can never fail an
 * article); saveFinalVersion mutator order is not this function's business
 * (it runs after render, inside runPostcheckAndPersist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findManyMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    researchSource: { findMany: findManyMock },
  },
}));
vi.mock('../../server/queue.mjs', () => ({
  redisConnection: {},
}));
vi.mock('../../server/websocket.mjs', () => ({
  broadcastProgress: vi.fn(),
  createWebSocketServer: vi.fn(),
}));

import { attachGroundingScore } from '../../server/workers/article-generation.mjs';

const MARKDOWN = 'Кислота удерживает влагу в тканях кожи.';
const CANON_ROW = {
  provider: 'duckduckgo',
  evidenceLevel: 'canon',
  title: 'Рекомендации: кислота удерживает влагу в тканях кожи',
  snippet: null,
  extractedText: null,
};

function makeReport() {
  // Frozen-contract-shaped report (as returned by runArticlePostcheck).
  return {
    version: 1,
    verdict: 'warn',
    rules: [{ id: 'FAQ-PRESENT', block: 'faq', severity: 'minor', status: 'fail', message: 'x' }],
    summary: { pass: 1, fail: 1, skipped: 1 },
  };
}

describe('Option A — attachGroundingScore (worker hook, report-only)', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('attaches summary.grounding computed from final markdown + ResearchSource rows', async () => {
    findManyMock.mockResolvedValueOnce([CANON_ROW]);
    const report = makeReport();

    const out = await attachGroundingScore(report, 'a1', MARKDOWN);

    expect(out).toBe(report); // same object, additive only
    const g = report.summary.grounding;
    expect(g).toBeDefined();
    expect(g.score).toBe(100); // every article token present in the canon row
    expect(g.coverage).toBe(1);
    expect(g.details.sourceCount).toBe(1);
  });

  it('additive only: verdict/rules/pass-fail-skipped unchanged, no text data leaked into report', async () => {
    findManyMock.mockResolvedValueOnce([CANON_ROW]);
    const report = makeReport();

    await attachGroundingScore(report, 'a1', MARKDOWN);

    expect(report.verdict).toBe('warn');
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0].id).toBe('FAQ-PRESENT');
    expect(report.summary.pass).toBe(1);
    expect(report.summary.fail).toBe(1);
    expect(report.summary.skipped).toBe(1);
  });

  it('queries ResearchSource narrowly (articleId + needed columns only)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await attachGroundingScore(makeReport(), 'a1', MARKDOWN);
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { articleId: 'a1' },
      select: {
        provider: true,
        evidenceLevel: true,
        title: true,
        snippet: true,
        extractedText: true,
      },
    });
  });

  it('no sources → honest null score with flags.noSources (fallback-finalization safe)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const report = makeReport();
    await attachGroundingScore(report, 'a1', MARKDOWN);
    expect(report.summary.grounding.score).toBe(null);
    expect(report.summary.grounding.flags.noSources).toBe(true);
  });

  it('DB failure → fail-safe: report unchanged, no grounding key, no throw', async () => {
    findManyMock.mockRejectedValueOnce(new Error('connection refused'));
    const report = makeReport();
    await expect(attachGroundingScore(report, 'a1', MARKDOWN)).resolves.toBe(report);
    expect(report.summary.grounding).toBeUndefined();
    expect(report.verdict).toBe('warn');
  });

  it('defensive: non-object report / missing summary returned as-is', async () => {
    await expect(attachGroundingScore(null, 'a1', MARKDOWN)).resolves.toBe(null);
    const noSummary = { verdict: 'ok' };
    await expect(attachGroundingScore(noSummary, 'a1', MARKDOWN)).resolves.toBe(noSummary);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
