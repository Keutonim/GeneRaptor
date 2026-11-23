/**
 * Per-stage timeline of the generation pipeline.
 *
 * Single source of truth: the AgentRun ledger (table `agent_run`). The worker
 * writes one row per role execution with `agentName = role.nameRu`
 * (server/workers/article-generation.mjs), `status` in
 * {running, completed, failed}, `startedAt` and `finishedAt`.
 *
 * The stage list itself is derived from the role catalogue
 * (server/agent-role-data.mjs) — 11 roles in chain order — so the API can
 * never drift from the catalogue: no second table, no second status map.
 */

import { agentRoleData } from '../agent-role-data.mjs';

/**
 * role.id → article status while the role runs.
 * Moved here from server/routes/articles.mjs; the route re-exports it so the
 * existing contract (tests/unit/article-progress.test.mjs) keeps working.
 */
export const ROLE_STATUS_MAP = {
  'topic-selector': 'topic_generation',
  'brief-preparer': 'brief_preparation',
  'knowledge-base-curator': 'knowledge_base',
  'research-analyst': 'research',
  'semantic-strategist': 'semantic_strategy',
  'structure-architect': 'structure',
  'article-author': 'article_writing',
  factchecker: 'factcheck',
  'seo-reviewer': 'seo_review',
  'quality-controller': 'quality_control',
  humanizer: 'humanize',
};

/** The 11 pipeline stages, in catalogue (chain) order. */
export const ARTICLE_STAGES = agentRoleData.map((role) => ({
  key: role.id,
  label: role.nameRu,
  // null for a catalogue role that is not part of the generation chain.
  status: ROLE_STATUS_MAP[role.id] ?? null,
}));

/**
 * AgentRun.agentName → stage key.
 * The worker stores `role.nameRu`; the role id form is accepted as well
 * (same tolerance as server/lib/article-runs-classifier.mjs).
 */
const STAGE_KEY_BY_RUN_NAME = new Map(
  ARTICLE_STAGES.flatMap((stage) => [
    [stage.label, stage.key],
    [stage.key, stage.key],
  ]),
);

const KNOWN_STAGE_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

function toMs(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** AgentRun.status → stage status. Unknown values degrade to 'pending'. */
function normalizeStageStatus(status) {
  if (typeof status === 'string' && KNOWN_STAGE_STATUSES.has(status)) return status;
  if (status === 'error') return 'failed';
  if (status === 'success' || status === 'done') return 'completed';
  return 'pending';
}

/** True when `run` is newer than `prev` (latest startedAt wins). */
function isNewerRun(run, prev) {
  const a = toMs(run?.startedAt);
  const b = toMs(prev?.startedAt);
  if (a === null && b === null) return false;
  if (a === null) return false;
  if (b === null) return true;
  if (a !== b) return a > b;
  const fa = toMs(run?.finishedAt) ?? -Infinity;
  const fb = toMs(prev?.finishedAt) ?? -Infinity;
  return fa > fb;
}

/**
 * The most recent run of a set (latest startedAt wins).
 *
 * @param {Array<object>} runs
 * @returns {object|null}
 */
export function latestAgentRun(runs) {
  const list = Array.isArray(runs) ? runs : [];
  let latest = null;
  for (const run of list) {
    if (!run || typeof run !== 'object') continue;
    if (latest === null || isNewerRun(run, latest)) latest = run;
  }
  return latest;
}

/**
 * Build the per-stage timeline from the AgentRun ledger.
 *
 * @param {Array<{agentName?:string,status?:string,startedAt?:Date|string|null,finishedAt?:Date|string|null}>} runs
 * @returns {Array<{key:string,label:string,status:string,startedAt:string|null,finishedAt:string|null,durationMs:number|null}>}
 */
export function buildStageTimeline(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const runByStage = new Map();

  for (const run of list) {
    if (!run || typeof run !== 'object') continue;
    const key = STAGE_KEY_BY_RUN_NAME.get(run.agentName);
    if (!key) continue; // runs of non-pipeline agents (postcheck, etc.) are not stages
    const known = runByStage.get(key);
    if (!known || isNewerRun(run, known)) runByStage.set(key, run);
  }

  return ARTICLE_STAGES.map((stage) => {
    const run = runByStage.get(stage.key);
    if (!run) {
      return {
        key: stage.key,
        label: stage.label,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      };
    }

    const startedAt = toIso(run.startedAt);
    const finishedAt = toIso(run.finishedAt);
    const startedMs = toMs(run.startedAt);
    const finishedMs = toMs(run.finishedAt);
    const durationMs =
      startedMs !== null && finishedMs !== null && finishedMs >= startedMs
        ? finishedMs - startedMs
        : null;

    return {
      key: stage.key,
      label: stage.label,
      status: normalizeStageStatus(run.status),
      startedAt,
      finishedAt,
      durationMs,
    };
  });
}

/**
 * Aggregates over a timeline: how many stages finished and how long the
 * finished part of the pipeline took (first start → last finish).
 *
 * @param {Array<{status:string,startedAt:string|null,finishedAt:string|null}>} stages
 * @returns {{completedStages:number, totalDurationMs:number|null}}
 */
export function stageTotals(stages) {
  const list = Array.isArray(stages) ? stages : [];
  const completedStages = list.filter((stage) => stage?.status === 'completed').length;
  const starts = list.map((stage) => toMs(stage?.startedAt)).filter((value) => value !== null);
  const ends = list.map((stage) => toMs(stage?.finishedAt)).filter((value) => value !== null);
  const totalDurationMs =
    starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : null;
  return { completedStages, totalDurationMs };
}
