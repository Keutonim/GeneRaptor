/**
 * GeneRaptor in-process queue shim (M1).
 *
 * Replaces BullMQ + Redis for a single-user local tool:
 *   - concurrency 1 (matches the effective local behavior);
 *   - NO persistence across process restart — Article.status in SQLite is the
 *     source of truth; the boot-time stale-job sweep
 *     (server/lib/stale-job-sweep.mjs) marks queued/running articles failed
 *     on startup so they become restartable via /start;
 *   - no retries: the article worker already has its own attempt loop and
 * wall-clock budget.
 *
 * Surface = what the engine already consumes:
 *   add(jobName, data, opts) / process(jobName|'*', handler) /
 *   job.updateProgress(n) / job.remove() / getJobs(states) / close() (drain) /
 *   removeRepeatable() (compat no-op) / UnrecoverableError.
 */
export class UnrecoverableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/**
 * Create an in-memory FIFO queue with a single concurrent runner.
 *
 * @param {string} name - queue name (logging only)
 * @returns {object} BullMQ-compatible queue + processor surface
 */
export function createShimQueue(name) {
  /** @type {Map<string, Function>} jobName -> handler ('*' = catch-all) */
  const handlers = new Map();
  /** @type {any[]} job records still in this process (waiting/active/terminal) */
  const records = [];
  /** @type {Promise|null} the currently running job's promise (concurrency 1) */
  let running = null;
  let closed = false;
  let nextId = 1;

  const log = (...args) => console.log(`[Queue:${name}]`, ...args);

  /**
   * Build a job record with the BullMQ-expected fields the engine touches.
   * @param {string} jobName
   * @param {object} data
   * @param {object} opts
   */
  function makeRecord(jobName, data, opts) {
    const record = {
      id: String(nextId++),
      name: jobName,
      data,
      opts: opts ?? {},
      progress: 0,
      state: 'waiting', // waiting | active | completed | failed
      attemptsMade: 0,
      failedReason: null,
      returnvalue: undefined,
      timestamp: Date.now(),
      queueName: name,
      async updateProgress(value) {
        record.progress = value;
        return record;
      },
      async remove() {
        if (record.state !== 'waiting') return; // only queued jobs can be cancelled
        const idx = records.indexOf(record);
        if (idx !== -1) records.splice(idx, 1);
        record.state = 'removed';
      },
    };
    return record;
  }

  /** Run the next waiting job if a handler exists, the runner is free and the queue is open. */
  function dispatch() {
    if (closed || running) return;
    const next = records.find((r) => r.state === 'waiting');
    if (!next) return;
    const handler = handlers.get(next.name) ?? handlers.get('*');
    if (!handler) return; // stays waiting until a processor registers

    next.state = 'active';
    next.attemptsMade = 1; // single execution, no retries in the shim
    running = (async () => {
      try {
        next.returnvalue = await handler(next);
        next.state = 'completed';
        log(`Job completed: ${next.name} (id=${next.id})`);
      } catch (err) {
        next.state = 'failed';
        next.failedReason = err?.message ?? String(err);
        log(`Job failed: ${next.name} (id=${next.id}):`, next.failedReason);
      } finally {
        running = null;
        dispatch();
      }
    })();
  }

  return {
    name,

    /** Enqueue a job. Mirrors BullMQ `queue.add(jobName, data, opts)`. */
    async add(jobName, data, opts = {}) {
      if (opts && opts.repeat) {
        // Repeatable jobs (auto-gen/auto-publish ticks) are out of GeneRaptor
        // scope; the stripped-scope callers are removed in M2. No-op, no crash.
        log(`Ignoring repeatable add (unsupported): ${jobName}`);
      }
      const record = makeRecord(jobName, data, opts);
      records.push(record);
      dispatch();
      return record;
    },

    /** Register a processor for a job name ('*' catches every name). */
    async process(jobName, handler) {
      handlers.set(jobName, handler);
      dispatch(); // waiting jobs may exist from before registration
      return { close: async () => {} };
    },

    /** Snapshot of job records filtered by state (shape used by /start, /stop). */
    async getJobs(states) {
      const wanted = new Set(states ?? ['waiting', 'active', 'completed', 'failed']);
      return records.filter((r) => wanted.has(r.state)).map((r) => r);
    },

    /** BullMQ compat no-op: no repeatable jobs in the shim. */
    async removeRepeatable() {
      return false;
    },

    /**
     * Graceful shutdown drain: stop dispatching new jobs and wait for any
     * in-flight job (and jobs it chains while closing) to settle. Waiting
     * jobs are dropped — the DB status plus boot sweep handle restart
     * semantics.
     */
    async close() {
      closed = true;
      while (running) {
        await running.catch(() => {});
      }
      log('closed');
    },

    /** Test/introspection helper. */
    stats() {
      const counts = {};
      for (const r of records) counts[r.state] = (counts[r.state] ?? 0) + 1;
      return { name, size: records.length, counts, closed };
    },
  };
}
