/**
 * Article AgentRuns classifier (task T4).
 *
 * Pure function — no Prisma, no DB. Consumes the narrow projection of
 * AgentRun rows ({ agentName, status, error, startedAt }) and decides:
 *
 *  - hasFallback        — legacy flag: any run whose error mentions
 *                         'fallback' (kept for old frontends; semantics are
 *                         identical to the old DB probe
 *                         `error: { contains: 'fallback', mode: 'insensitive' }`).
 *  - hasTemplateContent — the fixed badge: the article text is a fallback
 *                         template. True iff a fallback happened AND the
 *                         author role never produced a clean run.
 *  - generationStartedAt — min(startedAt) across runs (for the queue elapsed
 *                         timer, task T5); null when there are no runs.
 *
 * Worker conventions this is based on (server/workers/article-generation.mjs):
 *  - AgentRun.agentName stores role.nameRu; the author is «Агент автора»
 *    (agent-role-data.mjs: id 'article-author'). The roleKey form is accepted
 *    too for robustness.
 *  - Fallback runs are written with status 'completed' AND a non-null
 *    error 'fallback: <reason>' — both author fallback (worker ~:1309) and
 *    post-author-role fallback (worker ~:1361). Hence a "successful author
 *    run" must be status 'completed' AND error empty.
 *
 * Scenario matrix (A–F) is pinned by tests/unit/article-runs-classifier.test.mjs.
 */

/** AgentRun.agentName values that identify the article-author role. */
export const ARTICLE_AUTHOR_AGENT_NAMES = ['Агент автора', 'article-author'];

const FALLBACK_MARKER = 'fallback';

/** Does this error text mention the fallback marker? Case-insensitive substring. */
function isErrorWithFallback(error) {
  return typeof error === 'string' && error.toLowerCase().includes(FALLBACK_MARKER);
}

/**
 * A successful author run: author's agentName, status 'completed', and an
 * EMPTY error — null, undefined or '' (FIX-6: 'пусто-строчный' error is not
 * an error, aligned with the route's success filter `error: null`).
 * A completed-with-'fallback:'-error run does NOT count (that is scenario A).
 */
function isSuccessfulAuthorRun(run) {
  return (
    ARTICLE_AUTHOR_AGENT_NAMES.includes(run.agentName) &&
    run.status === 'completed' &&
    (run.error === null || run.error === undefined || run.error === '')
  );
}

/** Normalize startedAt (Date | ISO string | number) to a comparable timestamp. */
function toTimestamp(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Classify an article's AgentRuns.
 *
 * @param {Array<{agentName?: string, status?: string, error?: string | null,
 *                startedAt?: Date | string | null}> | null} runs
 * @returns {{hasFallback: boolean, hasTemplateContent: boolean,
 *            generationStartedAt: Date | string | null}}
 *   generationStartedAt preserves the original representation of the minimal
 *   startedAt (Date stays Date, ISO string stays string) so callers can pass
 *   Prisma rows through unchanged.
 */
export function classifyArticleRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];

  let hasFallback = false;
  let hasSuccessfulAuthorRun = false;
  let minStartedAtMs = null;
  let generationStartedAt = null;

  for (const run of list) {
    if (!run || typeof run !== 'object') continue;

    if (isErrorWithFallback(run.error)) {
      hasFallback = true;
    }
    if (isSuccessfulAuthorRun(run)) {
      hasSuccessfulAuthorRun = true;
    }

    const ts = toTimestamp(run.startedAt);
    if (ts !== null && (minStartedAtMs === null || ts < minStartedAtMs)) {
      minStartedAtMs = ts;
      generationStartedAt = run.startedAt;
    }
  }

  return {
    hasFallback,
    hasTemplateContent: hasFallback && !hasSuccessfulAuthorRun,
    generationStartedAt,
  };
}
