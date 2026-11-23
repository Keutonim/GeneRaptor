/**
 * Boot-time stale-job sweep (P1 — M1).
 *
 * On startup, BEFORE the in-process runner accepts jobs, every Article still
 * in `queued` or `running` transitions to `failed`: no in-process job
 * survives a process restart, and /start does not accept queued|running
 * (allowedStartStatuses = draft|failed|stopped|needs_review), so after the
 * sweep such articles become restartable.
 *
 * Called from createExpressApp() before the HTTP server starts listening —
 * no request can enqueue a fresh job before the sweep has settled.
 */
import { prisma } from '../db.mjs';

/** Statuses that cannot survive a restart in an in-process runner. */
export const STALE_JOB_STATUSES = ['queued', 'running'];

/**
 * Mark every queued/running article as failed.
 *
 * @param {import('@prisma/client').PrismaClient} [db]
 * @returns {Promise<{swept: number}>} number of articles transitioned
 */
export async function sweepStaleJobs(db = prisma) {
  const result = await db.article.updateMany({
    where: { status: { in: STALE_JOB_STATUSES } },
    data: { status: 'failed' },
  });
  if (result.count > 0) {
    console.log(
      `[BootSweep] Marked ${result.count} stale article(s) (queued|running) as failed — restartable via /start`
    );
  }
  return { swept: result.count };
}
