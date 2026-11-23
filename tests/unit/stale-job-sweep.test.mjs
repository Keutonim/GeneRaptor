/**
 * Boot-time stale-job sweep unit tests.
 *
 * Contract: on startup, before the runner accepts jobs, every Article still
 * in `queued` or `running` transitions to `failed` — no in-process job
 * survives a restart, and /start does not accept queued|running
 * (allowedStartStatuses = draft|failed|stopped|needs_review), so after the
 * sweep such articles become restartable. All other statuses are untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { sweepStaleJobs } from '../../server/lib/stale-job-sweep.mjs';

const prisma = new PrismaClient({ log: ['error'] });

async function createArticle(topic, status) {
  return prisma.article.create({ data: { topic, targetLength: 5000, status } });
}

describe('sweepStaleJobs', () => {
  beforeEach(async () => {
    await prisma.agentRun.deleteMany();
    await prisma.article.deleteMany();
  });

  it('transitions queued and running articles to failed', async () => {
    const queued = await createArticle('queued one', 'queued');
    const running = await createArticle('running one', 'running');

    const result = await sweepStaleJobs(prisma);

    expect(result.swept).toBe(2);
    const q = await prisma.article.findUnique({ where: { id: queued.id } });
    const r = await prisma.article.findUnique({ where: { id: running.id } });
    expect(q.status).toBe('failed');
    expect(r.status).toBe('failed');
  });

  it('leaves every other status untouched', async () => {
    const draft = await createArticle('draft one', 'draft');
    const failed = await createArticle('failed one', 'failed');
    const stopped = await createArticle('stopped one', 'stopped');
    const ready = await createArticle('ready one', 'ready');
    const needsReview = await createArticle('review one', 'needs_review');

    const result = await sweepStaleJobs(prisma);

    expect(result.swept).toBe(0);
    for (const a of [draft, failed, stopped, ready, needsReview]) {
      const row = await prisma.article.findUnique({ where: { id: a.id } });
      expect(row.status).toBe(a.status);
    }
  });

  it('is idempotent: running the sweep twice ends in the same state', async () => {
    await createArticle('idem', 'queued');

    const first = await sweepStaleJobs(prisma);
    const second = await sweepStaleJobs(prisma);

    expect(first.swept).toBe(1);
    expect(second.swept).toBe(0);
    const remaining = await prisma.article.findMany({ where: { topic: 'idem' } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('failed');
  });
});
