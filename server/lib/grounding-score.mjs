/**
 * Option A (2026-09-17, task 20260917-openresearch-integration): grounding
 * score — a single deterministic ground-truth metric (autoresearch principle
 * P1, karpathy/autoresearch "val_bpb" analogue) measuring how well the final
 * article text is supported by the crawled ground-truth sources.
 *
 * PURE module: no LLM, no Prisma, no I/O, no clock, no randomness — same
 * inputs always produce the same score. The worker (saveFinalVersion →
 * runPostcheckAndPersist) is the sole data supplier; it attaches the result
 * as the ADDITIVE report-only key `summary.grounding` of the postcheck
 * report persisted in the AgentRun "Пост-проверка качества" outputJson.
 *
 * Report-only contract (frozen in this module): the score is NOT a postcheck rule
 * (the 39-rule pinned set is untouched), carries no severity/status, and can
 * never fail an article. Thresholds are intentionally uncalibrated — the
 * report-only observation period (D1 pattern) calibrates them later.
 *
 * Score definition (formula):
 *   coverage   = |articleTokens ∩ corpusTokens| / |articleTokens|
 *                — share of the article's unique content tokens (lowercased
 *                letter/digit runs of >= 4 chars, markdown-stripped; filters
 *                out nearly all RU function words) present in the merged
 *                crawled-source corpus (title+snippet+extractedText).
 *   evidenceMix = mean evidence weight of the crawled sources
 *                (canon 1.0 > high 0.8 > medium 0.5 > low 0.25; unknown
 *                counts as medium). Synthetic consensus sources
 *                (provider 'consensus', LLM-derived per consensus-builder)
 *                are capped at 0.4 and flagged — they must not overstate
 * grounding (FACT-EVIDENCE-MIX).
 *   score = round(100 * (0.7 * coverage + 0.3 * evidenceMix)) ∈ 0..100
 *   Coverage is dominant because it is the direct "text supported by
 *   sources" signal; evidenceMix is a source-quality adjustment.
 *
 * Honest nulls: no sources / empty corpus / empty article → score null with
 * an explanatory flag (fallback finalization paths may have no sources; a
 * fake 0 would be dishonest telemetry).
 *
 * Known limits (documented for the report-only period):
 *   - exact-token matching, no stemming/lemmatization (paraphrases do not
 *     count as supported — the metric under-reports, never over-reports);
 *   - coverage is unique-token-based, not term-frequency-based;
 *   - evidenceMix covers ALL gathered sources, not only cited ones
 *     (citation markers are stripped before publication, so the final text
 *     cannot attribute tokens to specific sources);
 *   - computed from the FINAL article text (post-strip, post-mutators).
 */

/* Evidence weights on an integer scale ×20 (exact binary-friendly math;
 * 20/16/10/5 == 1.0/0.8/0.5/0.25). */
const EVIDENCE_WEIGHT_SCALE = 20;
const EVIDENCE_WEIGHTS = { canon: 20, high: 16, medium: 10, low: 5 };
const UNKNOWN_EVIDENCE_WEIGHT = 10; // schema default is 'medium'
const CONSENSUS_WEIGHT_CAP = 8; // 0.4 — synthetic LLM-derived source
const CONSENSUS_PROVIDER = 'consensus';

/* Composite weights: coverage 70%, evidence mix 30%. The score is computed
 * as (20*70*m*n + 30*S*A) / (20*A*n) over integers (m=matched tokens,
 * A=article tokens, S=integer weight sum, n=sources) — algebraically equal
 * to 100*(0.7*m/A + 0.3*S/(20n)) but avoids float drift at .5 boundaries. */
const COVERAGE_WEIGHT_PCT = 70;
const EVIDENCE_MIX_WEIGHT_PCT = 30;

/* Content token: a lowercased run of >= 4 letters/digits (Unicode). */
const TOKEN_RE = /[\p{L}\p{N}]{4,}/gu;
const MIN_TOKEN_LEN = 4;

/**
 * Reduce markdown to comparable plain text: drop code fences, keep link
 * anchors and image alts, neutralize leftover markup characters.
 * @param {string} text
 * @returns {string}
 */
function plainTextOf(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`|_~\[\]()!-]/g, ' ');
}

/**
 * Set of unique content tokens of a text.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenSet(text) {
  const out = new Set();
  const matches = plainTextOf(text).toLowerCase().match(TOKEN_RE);
  if (matches) {
    for (const token of matches) out.add(token);
  }
  return out;
}

/**
 * Compute the grounding score of an article against its crawled sources.
 * Never throws — garbage input degrades to { score: null, flags: … }.
 *
 * @param {object} args
 * @param {string} args.articleText final article markdown (post-strip).
 * @param {Array<{text: string, evidenceLevel?: string, provider?: string}>} args.sources
 *   crawled sources (see sourcesFromResearchRows).
 * @returns {{
 *   score: number|null, coverage: number|null, evidenceMix: number|null,
 *   flags: { noSources: boolean, emptyCorpus: boolean, emptyArticle: boolean },
 *   details: {
 *     articleTokens: number, matchedTokens: number, sourceCount: number,
 *     corpusChars: number, consensusSourceCount: number,
 *     byEvidenceLevel: { canon: number, high: number, medium: number, low: number, other: number },
 *   },
 * }}
 */
export function computeGroundingScore({ articleText, sources } = {}) {
  const srcList = Array.isArray(sources)
    ? sources.filter((s) => s && typeof s === 'object' && !Array.isArray(s))
    : [];

  const articleTokens = tokenSet(articleText);
  const corpusTokens = new Set();
  const byEvidenceLevel = { canon: 0, high: 0, medium: 0, low: 0, other: 0 };
  let corpusChars = 0;
  let weightSum = 0;
  let consensusSourceCount = 0;

  for (const source of srcList) {
    const text = typeof source.text === 'string' ? source.text : '';
    corpusChars += text.length;
    for (const token of tokenSet(text)) corpusTokens.add(token);

    const level =
      typeof source.evidenceLevel === 'string' ? source.evidenceLevel.trim().toLowerCase() : '';
    let weight = EVIDENCE_WEIGHTS[level];
    // TL-1 hardening: a level that lands on a prototype-chain key ('__proto__',
    // 'constructor') resolves through EVIDENCE_WEIGHTS' prototype as an object
    // (not undefined), coercing weightSum to a string → NaN score (JSON-persists
    // as null). Only own keys count; anything else falls to the unknown path.
    if (!Object.hasOwn(EVIDENCE_WEIGHTS, level)) weight = undefined;
    if (weight !== undefined) {
      byEvidenceLevel[level] += 1;
    } else {
      byEvidenceLevel.other += 1;
      weight = UNKNOWN_EVIDENCE_WEIGHT;
    }

    const provider =
      typeof source.provider === 'string' ? source.provider.trim().toLowerCase() : '';
    if (provider === CONSENSUS_PROVIDER) {
      consensusSourceCount += 1;
      if (weight > CONSENSUS_WEIGHT_CAP) weight = CONSENSUS_WEIGHT_CAP;
    }
    weightSum += weight;
  }

  const sourceCount = srcList.length;
  const emptyArticle = articleTokens.size === 0;
  const emptyCorpus = sourceCount > 0 && corpusTokens.size === 0;
  const noSources = sourceCount === 0;

  let matchedTokens = 0;
  if (!emptyArticle && corpusTokens.size > 0) {
    for (const token of articleTokens) {
      if (corpusTokens.has(token)) matchedTokens += 1;
    }
  }

  const coverage =
    !emptyArticle && corpusTokens.size > 0 ? matchedTokens / articleTokens.size : null;
  const evidenceMix =
    sourceCount > 0 ? weightSum / (EVIDENCE_WEIGHT_SCALE * sourceCount) : null;

  const score =
    coverage !== null && evidenceMix !== null
      ? Math.round(
          (EVIDENCE_WEIGHT_SCALE * COVERAGE_WEIGHT_PCT * matchedTokens * sourceCount +
            EVIDENCE_MIX_WEIGHT_PCT * weightSum * articleTokens.size) /
            (EVIDENCE_WEIGHT_SCALE * articleTokens.size * sourceCount)
        )
      : null;

  return {
    score,
    coverage,
    evidenceMix,
    flags: { noSources, emptyCorpus, emptyArticle },
    details: {
      articleTokens: articleTokens.size,
      matchedTokens,
      sourceCount,
      corpusChars,
      consensusSourceCount,
      byEvidenceLevel,
    },
  };
}

/**
 * Map ResearchSource DB rows (prisma.researchSource) to module sources:
 * text = title + snippet + extractedText (trimmed, empty parts dropped).
 * Tolerates any garbage input (returns []).
 *
 * @param {Array<{provider?: string, evidenceLevel?: string, title?: string,
 *   snippet?: string, extractedText?: string}>|null} rows
 * @returns {Array<{text: string, evidenceLevel: string, provider: string}>}
 */
export function sourcesFromResearchRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const text = [row.title, row.snippet, row.extractedText]
      .filter((part) => typeof part === 'string')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n');
    out.push({
      text,
      evidenceLevel: typeof row.evidenceLevel === 'string' ? row.evidenceLevel : '',
      provider: typeof row.provider === 'string' ? row.provider : '',
    });
  }
  return out;
}
