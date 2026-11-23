/**
 * Research Source REST routes.
 *
 * Exposes the external evidence-layer sources attached to an article. Mounted
 * under /api/articles by express-app.mjs so the final path is:
 *
 *   GET /api/articles/:articleId/research-sources
 *     → { success, data: sources }  // sorted: evidenceLevel then fetchedAt DESC
 */
import { Router } from 'express';
import { prisma } from '../db.mjs';
import { asyncHandler } from '../lib/async-handler.mjs';
import { parseResearchMetadata } from '../lib/research-source.mjs';

const router = Router();

/** evidence-level weight for ordering (lower = stronger evidence first). */
const EVIDENCE_RANK = {
  canon: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Compare two sources: strongest evidence first, then newest fetchedAt first.
 * Falls back to a stable order for unknown levels (treated as weakest).
 */
function compareSources(a, b) {
  const rankA = EVIDENCE_RANK[a.evidenceLevel] ?? EVIDENCE_RANK.low;
  const rankB = EVIDENCE_RANK[b.evidenceLevel] ?? EVIDENCE_RANK.low;
  if (rankA !== rankB) return rankA - rankB;
  const tA = a.fetchedAt ? new Date(a.fetchedAt).getTime() : 0;
  const tB = b.fetchedAt ? new Date(b.fetchedAt).getTime() : 0;
  return tB - tA;
}

/**
 * GET /:articleId/research-sources
 * Returns all ResearchSource rows attached to the article, ordered by
 * evidenceLevel (canon → high → medium → low) then fetchedAt DESC.
 */
router.get(
  '/:articleId/research-sources',
  asyncHandler(async (req, res) => {
    const { articleId } = req.params;

    if (!articleId || typeof articleId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Параметр articleId обязателен.',
      });
    }

    const sources = await prisma.researchSource.findMany({
      where: { articleId },
      orderBy: [{ fetchedAt: 'desc' }],
    });

    sources.sort(compareSources);

    // M1: metadata is a JSON-encoded string on SQLite — restore the
    // object shape at the API boundary so clients see the old contract.
    return res.json({
      success: true,
      data: sources.map((s) => ({ ...s, metadata: parseResearchMetadata(s.metadata) })),
    });
  })
);

export default router;
