/**
 * Cover budget arithmetic (step 6, cases 14-16).
 *
 * - Month window is Europe/Moscow (repo default timezone).
 * - Price table holds ONLY flat published per-image prices
 *   (qwen/qwen-image-2.1-pro is 4,82₽ at 1K and 2K, no 512/4K tiers).
 *   Token-priced Gemini models have no upfront price → null → only the
 *   spent >= cap rule applies for them.
 * - AgentRun.startedAt is nullable (schema :229): rows with null startedAt are
 *   attributed via finishedAt when present, otherwise conservatively to the
 *   current month (an unknown-date spend is never free).
 */

import { prisma } from '../db.mjs';

/** Ledger name for cover agent runs (pinned; cover-service re-exports it). */
export const COVER_AGENT_NAME = 'Генерация обложки';

/**
 * Flat per-image prices in RUB by model id and resolution.
 * Only published tiers — anything else estimates as null (unknown).
 */
const COVER_IMAGE_PRICES = Object.freeze({
  'qwen/qwen-image-2.1-pro': Object.freeze({ '1K': 4.82, '2K': 4.82 }),
});

/**
 * UTC-offset of a timezone at a given instant, in ms (local - UTC).
 * @param {number} msDate instant to measure at
 * @param {string} timeZone IANA timezone
 * @returns {number}
 */
function tzOffsetMs(msDate, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(msDate)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - msDate;
}

/**
 * Epoch ms of the first instant of `now`'s month in `timeZone`.
 * Two offset iterations converge even across DST transitions (MSK has none).
 * @param {Date} now
 * @param {string} [timeZone] IANA timezone, default Europe/Moscow
 * @returns {number}
 */
export function monthStartMs(now, timeZone = 'Europe/Moscow') {
  const d = new Date(now);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const naiveUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, 1, 0, 0, 0);

  let guess = naiveUtc;
  for (let i = 0; i < 2; i += 1) {
    guess = naiveUtc - tzOffsetMs(guess, timeZone);
  }
  return guess;
}

/**
 * Upfront per-image price estimate, or null when unknown (token-priced models,
 * unpublished tiers, unknown model ids). quality:'auto' is unknown by
 * definition (checkbox wave): the provider price is then not
 * fixed upfront even for a flat-listed model — the UI hint degrades to
 * «Цена зависит от модели».
 * @param {string} model
 * @param {string} resolution
 * @param {string} [quality] effective settings quality; 'auto' → null
 * @returns {number | null}
 */
export function estimateImageCostRub(model, resolution, quality) {
  if (quality === 'auto') return null;
  const tiers = COVER_IMAGE_PRICES[model];
  if (!tiers) return null;
  const price = tiers[resolution];
  return typeof price === 'number' ? price : null;
}

/**
 * Budget gate: spent >= cap always exceeds (cap 0 blocks everything); for
 * known-price models spent + estimate > cap also exceeds the budget.
 * @param {{spentRub: number, capRub: number, estimateRub: number | null}} input
 * @returns {boolean}
 */
export function isBudgetExceeded({ spentRub, capRub, estimateRub }) {
  if (spentRub >= capRub) return true;
  if (typeof estimateRub === 'number' && Number.isFinite(estimateRub)) {
    return spentRub + estimateRub > capRub;
  }
  return false;
}

function toNumber(value) {
  if (value !== null && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return Number(value);
}

/**
 * Sum of cover ledger spend attributed to `now`'s MSK month.
 * Rows with null startedAt are counted when finishedAt falls in the window,
 * or conservatively when finishedAt is null too.
 * @param {Date} now
 * @returns {Promise<number>}
 */
export async function spentThisMonthRub(now) {
  const monthStart = monthStartMs(now);

  const rows = await prisma.agentRun.findMany({
    where: {
      agentName: COVER_AGENT_NAME,
      costRub: { not: null },
      OR: [{ startedAt: { gte: new Date(monthStart) } }, { startedAt: null }],
    },
    select: { costRub: true, startedAt: true, finishedAt: true },
  });

  let total = 0;
  for (const row of rows) {
    if (row.startedAt === null || row.startedAt === undefined) {
      // Attribute via finishedAt; unknown dates are charged to the current month.
      if (row.finishedAt !== null && row.finishedAt !== undefined) {
        const finishedMs = new Date(row.finishedAt).getTime();
        if (finishedMs < monthStart) continue; // belongs to a previous month
      }
    }
    total += toNumber(row.costRub) || 0;
  }
  return total;
}
