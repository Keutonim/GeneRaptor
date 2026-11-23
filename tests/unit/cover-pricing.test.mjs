// Unit tests for server/lib/cover-pricing.mjs (pricing rules + attribution).
// Prisma is mocked — no live DB. Month window is Europe/Moscow.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  agentRun: {
    findMany: vi.fn(),
  },
}));

vi.mock('../../server/db.mjs', () => ({
  prisma: { agentRun: dbMocks.agentRun },
}));

const {
  COVER_AGENT_NAME,
  monthStartMs,
  estimateImageCostRub,
  isBudgetExceeded,
  spentThisMonthRub,
} = await import('../../server/lib/cover-pricing.mjs');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('COVER_AGENT_NAME', () => {
  it('is the pinned ledger name', () => {
    expect(COVER_AGENT_NAME).toBe('Генерация обложки');
  });
});

// Case 14: MSK month window.
describe('monthStartMs', () => {
  it('returns the start of the Europe/Moscow month', () => {
    // 2026-10-24T12:00:00Z → MSK Oct 2026 starts 2026-10-01T00:00+03:00 = 2026-09-30T21:00Z.
    expect(monthStartMs(new Date('2026-10-24T12:00:00.000Z'))).toBe(
      Date.UTC(2026, 8, 30, 21, 0, 0),
    );
  });

  it('flips to the next month exactly at MSK midnight', () => {
    // 2026-10-31T20:59:59Z is still Oct 31 23:59:59 MSK.
    expect(monthStartMs(new Date('2026-10-31T20:59:59.000Z'))).toBe(
      Date.UTC(2026, 8, 30, 21, 0, 0),
    );
    // 2026-10-31T21:00:00Z is Nov 1 00:00:00 MSK.
    expect(monthStartMs(new Date('2026-10-31T21:00:00.000Z'))).toBe(
      Date.UTC(2026, 9, 31, 21, 0, 0),
    );
  });

  it('accepts an explicit timeZone override', () => {
    expect(monthStartMs(new Date('2026-10-24T12:00:00.000Z'), 'UTC')).toBe(
      Date.UTC(2026, 9, 1, 0, 0, 0),
    );
  });
});

// Case 15: per-image price estimates.
describe('estimateImageCostRub', () => {
  it('returns 4.82 for qwen/qwen-image-2.1-pro at 1K and 2K (flat published price)', () => {
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '1K')).toBeCloseTo(4.82, 10);
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '2K')).toBeCloseTo(4.82, 10);
  });

  it('returns null for token-priced Gemini models (unknown upfront price)', () => {
    expect(estimateImageCostRub('google/gemini-nano-banana-2.1', '1K')).toBeNull();
    expect(estimateImageCostRub('google/gemini-3.1-flash-image', '2K')).toBeNull();
  });

  it('returns null for unknown models or unpublished resolution tiers', () => {
    expect(estimateImageCostRub('qwen/qwen-image-3-pro', '1K')).toBeNull();
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '512')).toBeNull();
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '4K')).toBeNull();
    expect(estimateImageCostRub('bogus/model', '1K')).toBeNull();
  });

  // Cover checkbox wave: the «+~5 ₽» hint must degrade to
  // «Цена зависит от модели» when quality:auto — the provider price is then
  // not fixed upfront even for a flat-listed model. Back-compat: the
  // two-argument call (budget gate, cover-service) keeps its behaviour.
  it('quality:auto → null even for a flat-priced model', () => {
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '1K', 'auto')).toBeNull();
    expect(estimateImageCostRub('google/gemini-nano-banana-2.1', '1K', 'auto')).toBeNull();
  });

  it('fixed quality tiers keep the flat price; absent quality stays back-compatible', () => {
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '1K', 'high')).toBeCloseTo(4.82, 10);
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '1K', 'low')).toBeCloseTo(4.82, 10);
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '1K', undefined)).toBeCloseTo(4.82, 10);
    expect(estimateImageCostRub('qwen/qwen-image-2.1-pro', '1K')).toBeCloseTo(4.82, 10);
  });
});

// Case 16: budget gate rules.
describe('isBudgetExceeded', () => {
  it('exceeds when spent >= cap (cap 0 blocks everything)', () => {
    expect(isBudgetExceeded({ spentRub: 300, capRub: 300, estimateRub: null })).toBe(true);
    expect(isBudgetExceeded({ spentRub: 301, capRub: 300, estimateRub: null })).toBe(true);
    expect(isBudgetExceeded({ spentRub: 0, capRub: 0, estimateRub: null })).toBe(true);
  });

  it('exceeds for known-price models when spent + estimate > cap', () => {
    // 297 + 4.82 = 301.82 > 300.
    expect(isBudgetExceeded({ spentRub: 297, capRub: 300, estimateRub: 4.82 })).toBe(true);
  });

  it('does not exceed when spent + estimate <= cap', () => {
    expect(isBudgetExceeded({ spentRub: 100, capRub: 300, estimateRub: 4.82 })).toBe(false);
    // Exact boundary: 295.18 + 4.82 = 300 <= 300.
    expect(isBudgetExceeded({ spentRub: 295.18, capRub: 300, estimateRub: 4.82 })).toBe(false);
  });

  it('applies only the spent >= cap rule when the estimate is unknown', () => {
    expect(isBudgetExceeded({ spentRub: 299.99, capRub: 300, estimateRub: null })).toBe(false);
    expect(isBudgetExceeded({ spentRub: 300, capRub: 300, estimateRub: null })).toBe(true);
  });
});

// §4 step 6 attribution: null startedAt rows counted via finishedAt, else current month.
describe('spentThisMonthRub', () => {
  const now = new Date('2026-10-24T12:00:00.000Z');
  const monthStart = new Date(Date.UTC(2026, 8, 30, 21, 0, 0));

  it('queries the ledger for cover rows in the MSK month (null startedAt included)', async () => {
    dbMocks.agentRun.findMany.mockResolvedValue([]);

    await spentThisMonthRub(now);

    expect(dbMocks.agentRun.findMany).toHaveBeenCalledTimes(1);
    const arg = dbMocks.agentRun.findMany.mock.calls[0][0];
    expect(arg.where.agentName).toBe(COVER_AGENT_NAME);
    expect(arg.where.OR).toEqual([{ startedAt: { gte: monthStart } }, { startedAt: null }]);
    expect(arg.where.costRub).toEqual({ not: null });
  });

  it('sums in-month rows and skips pre-month null-startedAt rows via finishedAt', async () => {
    dbMocks.agentRun.findMany.mockResolvedValue([
      // In-month startedAt rows → counted.
      { costRub: { toNumber: () => 4.82 }, startedAt: new Date('2026-10-02T09:00:00Z'), finishedAt: new Date('2026-10-02T09:01:00Z') },
      { costRub: 2.5, startedAt: new Date('2026-10-20T09:00:00Z'), finishedAt: null },
      // Null startedAt, finishedAt in-month → counted (previous month attribution).
      { costRub: 1.25, startedAt: null, finishedAt: new Date('2026-10-05T09:00:00Z') },
      // Null startedAt, finishedAt in September → NOT counted.
      { costRub: 9.99, startedAt: null, finishedAt: new Date('2026-09-15T09:00:00Z') },
      // Null startedAt, null finishedAt → conservative inclusion.
      { costRub: 0.5, startedAt: null, finishedAt: null },
    ]);

    const spent = await spentThisMonthRub(now);

    expect(spent).toBeCloseTo(4.82 + 2.5 + 1.25 + 0.5, 10);
  });

  it('returns 0 when the ledger is empty', async () => {
    dbMocks.agentRun.findMany.mockResolvedValue([]);
    expect(await spentThisMonthRub(now)).toBe(0);
  });
});
