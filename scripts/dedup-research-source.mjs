/**
 * Deduplicate research_source rows by canonical URL signature.
 *
 * Context (dedup round; the rules are frozen in this file):
 *   Consensus rounds and multiple providers produced duplicate research sources
 *   for the same page — identical URLs or near-identical shapes that differ only
 *   in www / trailing slash / http-vs-https / query / fragment. This script
 *   collapses those into a single surviving record BEFORE the
 *   `@@unique([articleId, normalizedUrl, provider])` constraint is applied via
 *   `prisma db push` (otherwise db push fails on the existing duplicates).
 *
 * Dedup key: canonicalSignature(sourceUrl) — see server/lib/url-normalize.mjs.
 *
 * Keeper selection within a duplicate group (richest / freshest wins):
 *   1. non-empty extractedText
 *   2. non-empty snippet
 *   3. newest fetchedAt
 *   4. highest id  (stable tiebreaker)
 *
 * FK integrity:
 *   No table references research_source (verified via information_schema: the
 *   research_source table has zero inbound foreign keys). AgentRun has no
 *   column linking a run to its sources. Therefore hard-deleting the losers
 *   cannot create
 *   dangling references — no relinking is needed.
 *
 * Idempotency:
 *   On a second run every duplicate group has a single survivor, so
 *   selectLoserIds returns [] for all groups and nothing is deleted.
 *
 * Usage:
 *   node scripts/dedup-research-source.mjs
 *   DRY_RUN=true node scripts/dedup-research-source.mjs   # no writes
 *   VERBOSE=true node scripts/dedup-research-source.mjs   # per-group detail
 */
import { prisma } from '../server/db.mjs';
import { canonicalSignature } from '../server/lib/url-normalize.mjs';

const DRY_RUN = process.env.DRY_RUN === 'true';
const VERBOSE = process.env.VERBOSE === 'true';

/**
 * Group research_source rows by their canonical URL signature.
 *
 * Rows with an empty signature (null/empty/invalid sourceUrl) are kept in their
 * OWN singleton groups — they have no dedup key and must not be merged into a
 * single bucket with each other (that would erase distinct empty-url sources).
 *
 * @param {Array<{id:string, sourceUrl:string|null, extractedText?:string, snippet?:string, fetchedAt?:string}>} rows
 * @returns {Map<string, Array<typeof rows[number]>>} signature → rows
 */
export function groupSourcesBySignature(rows) {
  const groups = new Map();
  let emptyCounter = 0;
  for (const row of rows) {
    const sig = canonicalSignature(row.sourceUrl);
    const key = sig || `__no_sig_${emptyCounter++}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/**
 * Pick the keeper of a duplicate group and return the ids of the losers.
 *
 * The keeper is the most complete / freshest record (see module header). The
 * losers are everything else. A single-row group yields no losers (idempotent).
 *
 * @param {Array<object>} group  rows sharing one signature (length >= 1)
 * @returns {string[]} ids to delete (all except the keeper)
 */
export function selectLoserIds(group) {
  if (!Array.isArray(group) || group.length < 2) return [];

  const sorted = [...group].sort((a, b) => {
    // 1. non-empty extractedText wins (empty sorts AFTER non-empty)
    const aText = a.extractedText ? 0 : 1;
    const bText = b.extractedText ? 0 : 1;
    if (aText !== bText) return aText - bText;
    // 2. non-empty snippet wins
    const aSnip = a.snippet ? 0 : 1;
    const bSnip = b.snippet ? 0 : 1;
    if (aSnip !== bSnip) return aSnip - bSnip;
    // 3. newest fetchedAt wins (desc)
    const ta = a.fetchedAt ? new Date(a.fetchedAt).getTime() : 0;
    const tb = b.fetchedAt ? new Date(b.fetchedAt).getTime() : 0;
    if (ta !== tb) return tb - ta;
    // 4. highest id wins (stable)
    return b.id.localeCompare(a.id);
  });

  const keeper = sorted[0];
  return sorted.slice(1).map((r) => r.id);
}

async function main() {
  console.log(`[Dedup] research_source by canonical URL${DRY_RUN ? ' (DRY_RUN)' : ''}`);

  const before = await prisma.researchSource.count();
  console.log(`[Dedup] research_source total before: ${before}`);

  const rows = await prisma.researchSource.findMany({
    select: {
      id: true,
      articleId: true,
      provider: true,
      sourceUrl: true,
      extractedText: true,
      snippet: true,
      fetchedAt: true,
    },
    orderBy: { id: 'asc' },
  });

  const groups = groupSourcesBySignature(rows);
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  console.log(`[Dedup] signature groups: ${groups.size}, duplicate groups: ${dupGroups.length}`);

  // Collect loser ids across all duplicate groups.
  const loserIds = [];
  for (const group of dupGroups) {
    const losers = selectLoserIds(group);
    loserIds.push(...losers);
    const keeper = group.find((g) => !losers.includes(g.id));
    if (VERBOSE || losers.length) {
      const head = group[0];
      console.log(
        `  [${head.provider}${head.articleId ? ` / ${head.articleId.slice(0, 8)}` : ''}] ` +
          `${head.sourceUrl || '(no url)'}: group=${group.length} → delete ${losers.length}`
      );
      if (VERBOSE && keeper) {
        console.log(`      keep id=${keeper.id} text=${keeper.extractedText ? 'yes' : 'no'}`);
      }
    }
  }

  console.log(`[Dedup] records to delete: ${loserIds.length}`);

  if (!loserIds.length) {
    console.log('[Dedup] nothing to do — already deduplicated.');
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('[Dedup] (DRY_RUN — no rows deleted)');
    await prisma.$disconnect();
    return;
  }

  // Hard delete the losers. Safe because research_source has no inbound FK
  // (verified via information_schema.referential_constraints).
  const result = await prisma.researchSource.deleteMany({
    where: { id: { in: loserIds } },
  });

  const after = await prisma.researchSource.count();
  console.log(`[Dedup] deleted: ${result.count}`);
  console.log(`[Dedup] research_source total after: ${after}`);
  console.log('[Dedup] Done');

  await prisma.$disconnect();
}

// Only run main() when executed directly, not when imported by a test.
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error('[Dedup] Error:', err);
    process.exit(1);
  });
}
