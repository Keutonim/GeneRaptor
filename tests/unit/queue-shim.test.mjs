/**
 * Unit tests for the in-process queue shim.
 *
 * The shim replaces BullMQ+Redis with an in-memory, concurrency-1 runner
 * exposing the surface the engine already consumes:
 *   - add(jobName, data, opts) -> job record
 *   - process(jobName, handler) (or '*' catch-all)
 *   - job.updateProgress(n), job.remove(), job.attemptsMade, job.opts
 *   - getJobs(states), close() (graceful drain), removeRepeatable() (no-op)
 *   - UnrecoverableError (failed without retry)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createShimQueue, UnrecoverableError } from '../../server/lib/queue-shim.mjs';

/** Deferred promise helper. */
function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('queue shim: add + process', () => {
  it('runs the handler with the added job data and records completion', async () => {
    const q = createShimQueue('test');
    const seen = [];
    q.process('generate', async (job) => {
      seen.push({ id: job.id, data: job.data });
      return 'done-' + job.data.articleId;
    });
    const job = await q.add('generate', { articleId: 'a1' });
    await q.close();
    expect(seen).toHaveLength(1);
    expect(seen[0].data).toEqual({ articleId: 'a1' });
    expect(job.state).toBe('completed');
    expect(job.returnvalue).toBe('done-a1');
  });

  it('dispatches jobs added BEFORE a processor was registered', async () => {
    const q = createShimQueue('test');
    const handled = [];
    const job = await q.add('generate', { articleId: 'late' });
    expect(job.state).toBe('waiting');
    q.process('generate', async (j) => { handled.push(j.data.articleId); });
    await q.close();
    expect(handled).toEqual(['late']);
  });

  it('routes each job to the handler registered for its name; "*" catches all', async () => {
    const q = createShimQueue('test');
    const handled = [];
    q.process('a', async () => { handled.push('a'); });
    q.process('b', async () => { handled.push('b'); });
    await q.add('a', {});
    await q.add('b', {});
    await q.close();
    expect(handled.sort()).toEqual(['a', 'b']);

    const q2 = createShimQueue('test2');
    const caught = [];
    q2.process('*', async (j) => { caught.push(j.name); });
    await q2.add('anything', {});
    await q2.add('whatever', {});
    await q2.close();
    expect(caught.sort()).toEqual(['anything', 'whatever']);
  });
});

describe('queue shim: updateProgress', () => {
  it('exposes progress updates on the job record', async () => {
    const q = createShimQueue('test');
    let progressSeen;
    q.process('generate', async (job) => {
      await job.updateProgress(37);
      progressSeen = job.progress;
      await job.updateProgress(100);
    });
    const job = await q.add('generate', { articleId: 'p1' });
    await q.close();
    expect(progressSeen).toBe(37);
    expect(job.progress).toBe(100);
  });
});

describe('queue shim: concurrency 1', () => {
  it('never runs two handlers at the same time (FIFO order)', async () => {
    const q = createShimQueue('test');
    let active = 0;
    let maxActive = 0;
    const order = [];
    q.process('generate', async (job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      order.push(job.data.articleId);
      active--;
    });
    await q.add('generate', { articleId: 'first' });
    await q.add('generate', { articleId: 'second' });
    // Wait for the queue to become idle (close() drains only the in-flight job;
    // queued jobs are dropped at shutdown and handled by the boot sweep).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pending = (await q.getJobs(['waiting', 'active'])).length;
      if (pending === 0) break;
      await sleep(10);
    }
    await q.close();
    expect(maxActive).toBe(1);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('queue shim: failure semantics', () => {
  it('marks the job failed with failedReason and keeps processing later jobs', async () => {
    const q = createShimQueue('test');
    q.process('generate', async (job) => {
      if (job.data.articleId === 'boom') throw new Error('kaboom');
    });
    const bad = await q.add('generate', { articleId: 'boom' });
    const good = await q.add('generate', { articleId: 'fine' });
    await q.close();
    expect(bad.state).toBe('failed');
    expect(bad.failedReason).toBe('kaboom');
    expect(good.state).toBe('completed');
  });

  it('UnrecoverableError fails the job without any retry attempt', async () => {
    const q = createShimQueue('test');
    let calls = 0;
    q.process('generate', async () => {
      calls++;
      throw new UnrecoverableError('wall clock exhausted');
    });
    const job = await q.add('generate', { articleId: 'x' });
    await q.close();
    expect(job.state).toBe('failed');
    expect(job.failedReason).toBe('wall clock exhausted');
    expect(job.attemptsMade).toBe(1); // single execution, no retries
    expect(calls).toBe(1);
  });
});

describe('queue shim: getJobs + remove (surface used by /start and /stop)', () => {
  it('lists waiting jobs with data and lets them be removed', async () => {
    const q = createShimQueue('test');
    const started = defer();
    const release = defer();
    q.process('generate', async (job) => {
      if (job.data.articleId === 'running') {
        started.resolve();
        await release.promise;
      }
    });
    await q.add('generate', { articleId: 'running' });
    await started.promise; // first job is active now

    const waitingJob = await q.add('generate', { articleId: 'waiting-1' });
    await q.add('generate', { articleId: 'waiting-2' });

    const waiting = await q.getJobs(['waiting']);
    expect(waiting.map((j) => j.data.articleId).sort()).toEqual(['waiting-1', 'waiting-2']);

    await waitingJob.remove();
    const afterRemove = await q.getJobs(['waiting']);
    expect(afterRemove.map((j) => j.data.articleId)).toEqual(['waiting-2']);

    release.resolve();
    await q.close();
  });
});

describe('queue shim: graceful shutdown drain', () => {
  it('close() waits for the active job to finish and stops accepting work', async () => {
    const q = createShimQueue('test');
    const started = defer();
    const release = defer();
    let finished = false;
    q.process('generate', async () => {
      started.resolve();
      await release.promise;
      finished = true;
    });
    const job = await q.add('generate', { articleId: 'drain-me' });
    await started.promise;

    const closing = q.close();
    release.resolve();
    await closing;
    expect(finished).toBe(true);
    expect(job.state).toBe('completed');
    // After close the queue no longer dispatches.
    const orphan = await q.add('generate', { articleId: 'after-close' });
    expect(orphan.state).toBe('waiting');
    await sleep(10);
    expect(orphan.state).toBe('waiting');
  });
});

describe('queue shim: BullMQ-compat no-ops', () => {
  it('removeRepeatable resolves false (repeatables are out of GeneRaptor scope)', async () => {
    const q = createShimQueue('test');
    await expect(
      q.removeRepeatable('tick', { pattern: '* * * * *', tz: 'UTC' })
    ).resolves.toBe(false);
    await q.close();
  });
});
