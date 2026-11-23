/**
 * Option A (2026-09-17, autoresearch P1 "single ground-truth metric"):
 * grounding score — deterministic, report-only measure of how well the final
 * article text is supported by the crawled ground-truth sources.
 *
 * Pure module unit test: no DB, no mocks. The worker seam (attachGroundingScore)
 * is covered separately in tests/unit/grounding-hook.test.mjs.
 */
import { describe, it, expect } from 'vitest';

import {
  computeGroundingScore,
  sourcesFromResearchRows,
} from '../../server/lib/grounding-score.mjs';

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const CANON_TEXT =
  'Гиалуроновая кислота удерживает влагу в тканях кожи и стимулирует выработку коллагена';

// Every content token (>= 4 chars, exact-match — no stemming) of the article
// is present in CANON_TEXT → coverage exactly 1.
const SUPPORTED_ARTICLE =
  'Кислота удерживает влагу в тканях кожи и стимулирует выработку коллагена.';

function canonSource(text) {
  return { text, evidenceLevel: 'canon', provider: 'duckduckgo' };
}

/* ── Shape and determinism ─────────────────────────────────────────────── */

describe('grounding-score — shape & determinism', () => {
  it('returns a plain JSON-safe object with the documented fields', () => {
    const g = computeGroundingScore({
      articleText: SUPPORTED_ARTICLE,
      sources: [canonSource(CANON_TEXT)],
    });
    expect(g).toBeDefined();
    expect(typeof g.score).toBe('number');
    expect(Number.isInteger(g.score)).toBe(true);
    expect(g.score).toBeGreaterThanOrEqual(0);
    expect(g.score).toBeLessThanOrEqual(100);
    expect(g.coverage).toBeGreaterThanOrEqual(0);
    expect(g.coverage).toBeLessThanOrEqual(1);
    expect(g.evidenceMix).toBeGreaterThanOrEqual(0);
    expect(g.evidenceMix).toBeLessThanOrEqual(1);
    expect(g.flags).toEqual(
      expect.objectContaining({ noSources: false, emptyCorpus: false, emptyArticle: false })
    );
    expect(g.details).toEqual(
      expect.objectContaining({
        articleTokens: expect.any(Number),
        matchedTokens: expect.any(Number),
        sourceCount: 1,
        corpusChars: expect.any(Number),
        consensusSourceCount: 0,
      })
    );
    // JSON-safe (persisted inside AgentRun.outputJson postcheck report).
    expect(() => JSON.stringify(g)).not.toThrow();
  });

  it('deterministic: same inputs → deep-equal output', () => {
    const args = {
      articleText: SUPPORTED_ARTICLE,
      sources: [canonSource(CANON_TEXT), { text: 'другой текст', evidenceLevel: 'low', provider: 'yandex' }],
    };
    expect(computeGroundingScore(args)).toStrictEqual(computeGroundingScore(args));
  });

  it('never throws on garbage input (report-only: score can never break the pipeline)', () => {
    expect(() => computeGroundingScore({ articleText: null, sources: null })).not.toThrow();
    expect(() => computeGroundingScore({})).not.toThrow();
    expect(() => computeGroundingScore(undefined)).not.toThrow();
  });
});

/* ── Score formula: score = round(100 * (0.7 * coverage + 0.3 * evidenceMix)) ── */

describe('grounding-score — formula', () => {
  it('fully supported text over a canon source → coverage 1, evidenceMix 1, score 100', () => {
    const g = computeGroundingScore({
      articleText: SUPPORTED_ARTICLE,
      sources: [canonSource(CANON_TEXT + ' дополнительные слова')],
    });
    expect(g.coverage).toBe(1);
    expect(g.evidenceMix).toBe(1);
    expect(g.score).toBe(100);
  });

  it('zero lexical overlap + medium sources → score 15 (evidence-only component)', () => {
    const g = computeGroundingScore({
      articleText: 'Гиалуроновая кислота удерживает влагу в тканях кожи',
      sources: [
        { text: 'Аэродинамическая труба измеряла турбулентность потока', evidenceLevel: 'medium', provider: 'yandex' },
      ],
    });
    expect(g.coverage).toBe(0);
    expect(g.evidenceMix).toBe(0.5);
    expect(g.score).toBe(15); // round(100 * (0.7*0 + 0.3*0.5))
  });

  it('partial coverage 0.5 over canon → score 65', () => {
    // 10 distinct RU content words (>= 4 chars); corpus contains exactly 5.
    const words = ['лазерная', 'эпиляция', 'уничтожает', 'фолликулы', 'навсегда', 'болезненность', 'процедуры', 'минимальная', 'противопоказания', 'ограничения'];
    const g = computeGroundingScore({
      articleText: words.join(' '),
      sources: [canonSource(words.slice(0, 5).join(' '))],
    });
    expect(g.details.articleTokens).toBe(10);
    expect(g.details.matchedTokens).toBe(5);
    expect(g.coverage).toBe(0.5);
    expect(g.score).toBe(65); // round(100 * (0.7*0.5 + 0.3*1))
  });

  it('evidence weights ordered: canon(1.0) > high(0.8) > medium(0.5) > low(0.25)', () => {
    const mk = (level) =>
      computeGroundingScore({
        articleText: SUPPORTED_ARTICLE,
        sources: [{ text: CANON_TEXT, evidenceLevel: level, provider: 'duckduckgo' }],
      });
    expect(mk('canon').evidenceMix).toBe(1);
    expect(mk('high').evidenceMix).toBe(0.8);
    expect(mk('medium').evidenceMix).toBe(0.5);
    expect(mk('low').evidenceMix).toBe(0.25);
    expect(mk('canon').score).toBe(100);
    expect(mk('high').score).toBe(94); // round(100 * (0.7 + 0.24))
    expect(mk('medium').score).toBe(85); // round(100 * (0.7 + 0.15))
    expect(mk('low').score).toBe(78); // round(100 * (0.7 + 0.075))
  });

  it('unknown evidenceLevel counted as medium-equivalent (0.5) and reported as other', () => {
    const g = computeGroundingScore({
      articleText: SUPPORTED_ARTICLE,
      sources: [{ text: CANON_TEXT, evidenceLevel: 'weird', provider: 'x' }],
    });
    expect(g.evidenceMix).toBe(0.5);
    expect(g.details.byEvidenceLevel).toEqual({ canon: 0, high: 0, medium: 0, low: 0, other: 1 });
  });

  it('TL-1: prototype-key evidenceLevel never yields NaN (falls back to unknown path)', () => {
    // A DB row whose evidenceLevel lowercases/trims onto a prototype-chain key
    // ('__proto__', 'constructor') must NOT resolve EVIDENCE_WEIGHTS[level]
    // through the prototype chain: the "weight" would be an object, weightSum
    // would coerce to a string and the score would become NaN (JSON-persists
    // as null — dishonest telemetry). Guarded behavior = same fallback as any
    // other unknown level: bucket other, medium-equivalent weight, finite score.
    for (const level of ['__proto__', 'constructor', 'Constructor', ' __PROTO__ ']) {
      const g = computeGroundingScore({
        articleText: SUPPORTED_ARTICLE,
        sources: [{ text: CANON_TEXT, evidenceLevel: level, provider: 'duckduckgo' }],
      });
      expect(Number.isNaN(g.score), `score is NaN for level ${JSON.stringify(level)}`).toBe(false);
      expect(Number.isFinite(g.score), `score not finite for level ${JSON.stringify(level)}`).toBe(
        true
      );
      expect(g.score).toBe(85); // round(100 * (0.7*1 + 0.3*0.5)) — same as medium
      expect(g.evidenceMix).toBe(0.5);
      expect(g.details.byEvidenceLevel).toEqual({ canon: 0, high: 0, medium: 0, low: 0, other: 1 });
      // Telemetry hygiene: no stray own keys leaked onto byEvidenceLevel.
      expect(JSON.parse(JSON.stringify(g.details.byEvidenceLevel))).toEqual({
        canon: 0,
        high: 0,
        medium: 0,
        low: 0,
        other: 1,
      });
    }
  });
});

/* ── Consensus cap (synthetic LLM-derived sources must not overstate grounding) ── */

describe('grounding-score — consensus cap', () => {
  it('provider=consensus capped at 0.4 even with evidenceLevel high', () => {
    const g = computeGroundingScore({
      articleText: SUPPORTED_ARTICLE,
      sources: [{ text: CANON_TEXT, evidenceLevel: 'high', provider: 'consensus' }],
    });
    expect(g.evidenceMix).toBe(0.4);
    expect(g.details.consensusSourceCount).toBe(1);
    expect(g.score).toBe(82); // round(100 * (0.7 + 0.3*0.4))
  });

  it('same text via a real provider scores higher than via consensus', () => {
    const args = (provider) => ({
      articleText: SUPPORTED_ARTICLE,
      sources: [{ text: CANON_TEXT, evidenceLevel: 'high', provider }],
    });
    expect(computeGroundingScore(args('consensus')).score).toBeLessThan(
      computeGroundingScore(args('duckduckgo')).score
    );
  });
});

/* ── Markdown noise handling (final article text IS markdown) ───────────── */

describe('grounding-score — markdown-aware tokenization', () => {
  it('link anchors count, link URLs and markup do not pollute tokens', () => {
    const corpus = 'Заголовок раздела: эффективность чистки лица подтверждена исследованиями';
    const g = computeGroundingScore({
      articleText:
        '## Заголовок раздела\n\nЭффективность [чистки лица](https://example.com/very/long/path) **подтверждена**.',
      sources: [canonSource(corpus)],
    });
    // All 4 content words of the article are present in the corpus.
    expect(g.coverage).toBe(1);
    expect(g.score).toBe(100);
  });

  it('code fences are excluded from article tokens', () => {
    const g = computeGroundingScore({
      articleText:
        'Эффективность чистки лица подтверждена\n\n```\nабракадабрифенсвнутритолько\n```\n',
      sources: [canonSource('Эффективность чистки лица подтверждена')],
    });
    expect(g.details.matchedTokens).toBe(g.details.articleTokens);
    expect(g.coverage).toBe(1); // fenced pseudo-word must not leak into tokens
  });

  it('short tokens (< 4 chars) are ignored — RU function words filtered', () => {
    const g = computeGroundingScore({
      articleText: 'для и или как при это не но',
      sources: [canonSource('совершенно другой словарный набор')],
    });
    expect(g.flags.emptyArticle).toBe(true);
    expect(g.score).toBe(null);
  });
});

/* ── Honest nulls (QA-2 advisory: fallback paths without sources/factcheck) ── */

describe('grounding-score — null paths', () => {
  it('no sources → score null, flags.noSources', () => {
    const g = computeGroundingScore({ articleText: SUPPORTED_ARTICLE, sources: [] });
    expect(g.score).toBe(null);
    expect(g.coverage).toBe(null);
    expect(g.evidenceMix).toBe(null);
    expect(g.flags.noSources).toBe(true);
    expect(g.details.sourceCount).toBe(0);
  });

  it('sources without any text → emptyCorpus flag, score null (honest, no fake 0)', () => {
    const g = computeGroundingScore({
      articleText: SUPPORTED_ARTICLE,
      sources: [{ text: '   ', evidenceLevel: 'canon', provider: 'duckduckgo' }],
    });
    expect(g.flags.emptyCorpus).toBe(true);
    expect(g.score).toBe(null);
  });

  it('empty article text → emptyArticle flag, score null', () => {
    const g = computeGroundingScore({ articleText: '', sources: [canonSource(CANON_TEXT)] });
    expect(g.flags.emptyArticle).toBe(true);
    expect(g.score).toBe(null);
  });

  it('garbage input → no throw, score null', () => {
    const g = computeGroundingScore({ articleText: null, sources: null });
    expect(g.score).toBe(null);
    expect(g.flags.noSources).toBe(true);
  });
});

/* ── Row mapper (ResearchSource DB rows → module sources) ───────────────── */

describe('sourcesFromResearchRows', () => {
  it('joins title/snippet/extractedText with newline, trims, drops empties', () => {
    const out = sourcesFromResearchRows([
      { provider: 'duckduckgo', evidenceLevel: 'high', title: ' Заголовок ', snippet: 'Фрагмент', extractedText: null },
      { provider: 'yandex', evidenceLevel: 'medium' },
    ]);
    expect(out).toEqual([
      { text: 'Заголовок\nФрагмент', evidenceLevel: 'high', provider: 'duckduckgo' },
      { text: '', evidenceLevel: 'medium', provider: 'yandex' },
    ]);
  });

  it('tolerates null/undefined rows input → []', () => {
    expect(sourcesFromResearchRows(null)).toEqual([]);
    expect(sourcesFromResearchRows(undefined)).toEqual([]);
    expect(sourcesFromResearchRows([null, 5, 'x'])).toEqual([]);
  });

  it('rows flow end-to-end into the score', () => {
    const g = computeGroundingScore({
      articleText: SUPPORTED_ARTICLE,
      sources: sourcesFromResearchRows([
        { provider: 'duckduckgo', evidenceLevel: 'canon', title: CANON_TEXT },
      ]),
    });
    expect(g.score).toBe(100);
  });
});
