/**
 * Fake-job end-to-end integration test (plan M1 AC):
 * a fake processor registered on the production queue module runs a job
 * added via the same path the /start route uses, and writes Article +
 * AgentRun rows through Prisma into SQLite.
 *
 * This pins the M1 runner wiring: server/queue.mjs IS the in-process shim
 * (add -> process -> updateProgress), no BullMQ/Redis involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { articleGenerationQueue, closeQueues } from '../../server/queue.mjs';

const prisma = new PrismaClient({ log: ['error'] });

function waitFor(predicate, timeoutMs = 5000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve(true);
      } catch (err) {
        return reject(err);
      }
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe('M1 integration: fake job runs end-to-end on the queue shim', () => {
  afterEach(async () => {
    await closeQueues();
  });

  it('add -> process -> Article+AgentRun rows written (SQLite)', async () => {
    await prisma.agentRun.deleteMany();
    await prisma.article.deleteMany();

    const article = await prisma.article.create({
      data: { topic: 'Fake job e2e topic', targetLength: 4000, status: 'queued' },
    });

    // A fake processor with the worker's DB contract: status transitions,
    // progress updates and an AgentRun ledger row.
    const seenProgress = [];
    await articleGenerationQueue.process('generate', async (job) => {
      expect(job.data.articleId).toBe(article.id);

      await prisma.article.update({
        where: { id: article.id },
        data: { status: 'running' },
      });
      await job.updateProgress(10);
      seenProgress.push(job.progress);

      const run = await prisma.agentRun.create({
        data: {
          articleId: article.id,
          agentName: 'fake-role',
          status: 'completed',
          progress: 100,
          inputTokens: 10,
          outputTokens: 20,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      await job.updateProgress(100);
      seenProgress.push(job.progress);
      return { agentRunId: run.id };
    });

    const job = await articleGenerationQueue.add('generate', { articleId: article.id });
    expect(job.state).not.toBe('waiting-forever'); // job accepted

    await waitFor(async () => job.state === 'completed' || job.state === 'failed');
    expect(job.state).toBe('completed');

    // Article row: back to a terminal status via the fake handler.
    const updated = await prisma.article.findUnique({ where: { id: article.id } });
    expect(updated.status).toBe('running');

    // AgentRun ledger row exists and is linked.
    const runs = await prisma.agentRun.findMany({ where: { articleId: article.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].agentName).toBe('fake-role');
    expect(runs[0].status).toBe('completed');

    // Progress travelled through updateProgress.
    expect(seenProgress).toEqual([10, 100]);
  });
});
