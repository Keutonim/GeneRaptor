/**
 * GeneRaptor queue facade — in-process runner shim (M1).
 *
 * Replaces BullMQ + Redis: single Node process, concurrency 1, no external
 * services. The exported names match the old surface so engine imports keep
 * working (server/routes/articles.mjs, workers, libs). The 'sourceCrawl' /
 * 'publication' / 'autoGeneration' / 'autoPublish' queues exist only for
 * import compatibility — their stripped-scope producers are removed in M2.
 *
 * No persistence across restart: Article.status in SQLite is the source of
 * truth; boot-time stale-job sweep (lib/stale-job-sweep.mjs) marks
 * queued/running articles failed on startup so /start accepts them again.
 */
import { createShimQueue } from './lib/queue-shim.mjs';

export const articleGenerationQueue = createShimQueue('articleGeneration');
export const sourceCrawlQueue = createShimQueue('sourceCrawl');
export const publicationQueue = createShimQueue('publication');
export const autoGenerationQueue = createShimQueue('autoGeneration');
export const autoPublishQueue = createShimQueue('autoPublish');

const queues = {
  articleGeneration: articleGenerationQueue,
  sourceCrawl: sourceCrawlQueue,
  publication: publicationQueue,
  autoGeneration: autoGenerationQueue,
  autoPublish: autoPublishQueue,
};

/**
 * Add a job to a named queue (compat helper; the article route adds via the
 * queue object directly).
 */
export async function addJob(queueName, jobName, data, opts = {}) {
  const queue = queues[queueName];
  if (!queue) {
    throw new Error(`Unknown queue: ${queueName}`);
  }
  return queue.add(jobName, data, opts);
}

/**
 * Graceful shutdown helper: drain every queue's in-flight job.
 */
export async function closeQueues() {
  for (const [name, queue] of Object.entries(queues)) {
    await queue.close();
    console.log(`[Queue] Closed queue: ${name}`);
  }
}
