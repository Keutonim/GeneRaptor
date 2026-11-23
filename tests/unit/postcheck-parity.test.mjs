/**
 * Parity of the article postcheck after the wordstat strip — the verdict on the
 * generated fixture and on the golden topic must stay identical before and
 * after the fixture change.
 *
 * What the strip changed (verified by running the pre-strip version of
 * server/lib/article-postcheck.mjs against the current module on the same
 * fixtures):
 *
 *  - the keyword SOURCE moved from «wordstat keywords» to the semantic core
 *    (clusters + LSI). Two rules that used the removed source
 *    (KEYS-COUNT-BY-LENGTH, FAQ-KEYS-SHARE) are now evaluated against the
 *    semantic core instead of being skipped;
 *  - the numeric NORMS did not move: they still come from the single
 *    seo-standards.mjs module (KEY_DENSITY, PER_KEY_DENSITY, FAQ_KEYS_SHARE_MIN,
 *    FAQ_KEYS_SHARE_WARN, KEYS_IN_TEXT_SHARE_MIN, SEO_MIN_NORM_CHARS, and the
 *    volume-dependent keysTargetByLength anchors);
 *  - on the GENERATED fixture (the mocked pipeline body) the pre-strip and the
 *    post-strip modules produce the identical verdict, summary and per-rule
 *    statuses — full parity;
 *  - the removed source is inert: collectKeywords() ignores a legacy
 *    `wordstatKeywords` input, so no old code path can inject keywords.
 *
 * The tests below pin that behaviour as a golden regression: the rule-status
 * snapshot of both fixtures, the norms, and the single keyword source.
 */
import { test, expect, describe } from 'vitest';

import {
  runArticlePostcheck,
  collectKeywords,
} from '../../server/lib/article-postcheck.mjs';
import {
  KEY_DENSITY,
  PER_KEY_DENSITY,
  FAQ_KEYS_SHARE_MIN,
  FAQ_KEYS_SHARE_WARN,
  KEYS_IN_TEXT_SHARE_MIN,
  SEO_MIN_NORM_CHARS,
  keysTargetByLength,
} from '../../server/lib/seo-standards.mjs';
import {
  GOLDEN_TOPIC_BODY,
  GENERATED_BODY,
  GOLDEN_CONTEXT,
  GOLDEN_SEMANTIC_CORE,
} from '../fixtures/postcheck-golden.mjs';

/** rule id → status (golden snapshot) */
const statusMap = (report) =>
  Object.fromEntries(report.rules.map((rule) => [rule.id, rule.status]));

const rule = (report, id) => report.rules.find((r) => r.id === id);

/** The semantic core of the golden topic — the only keyword source after M2. */
const GOLDEN_KEYS = [
  'имплантация зубов',
  'имплантация зубов цена',
  'как выбрать имплант для зуба',
  'этапы имплантации',
  'этапы установки импланта зуба',
  'сколько длится имплантация зубов',
  'имплантолог',
  'остеоинтеграция',
  'синус лифтинг',
  'абатмент',
];

describe('M2 postcheck parity — the norms are the single source of truth', () => {
  test('the thresholds did not move in the strip', () => {
    expect(KEY_DENSITY).toEqual({ warn: 0.03, fail: 0.045 });
    expect(PER_KEY_DENSITY).toEqual({ warn: 0.015, fail: 0.025 });
    expect(FAQ_KEYS_SHARE_MIN).toBe(0.4);
    expect(FAQ_KEYS_SHARE_WARN).toBe(0.3);
    expect(KEYS_IN_TEXT_SHARE_MIN).toBe(0.6);
    expect(SEO_MIN_NORM_CHARS).toBe(8000);
  });

  test('the volume-dependent keyword norm keeps its anchors', () => {
    expect(keysTargetByLength(10_000).min).toBe(8);
    expect(keysTargetByLength(30_000).min).toBe(15);
    expect(keysTargetByLength(50_000).min).toBe(20);
  });

  test('the keyword-count rule takes its minimum from seo-standards', () => {
    const report = runArticlePostcheck({ markdown: GOLDEN_TOPIC_BODY, context: GOLDEN_CONTEXT });
    const keysCount = rule(report, 'KEYS-COUNT-BY-LENGTH');
    expect(keysCount.details.min).toBe(keysTargetByLength(keysCount.details.plainChars).min);
  });
});

describe('M2 postcheck parity — golden topic fixture', () => {
  const report = runArticlePostcheck({ markdown: GOLDEN_TOPIC_BODY, context: GOLDEN_CONTEXT });

  test('reproduces the golden rule-status snapshot', () => {
    expect(statusMap(report)).toEqual({
      'HEAD-ONE-H1': 'pass',
      'HEAD-NO-SKIPS': 'pass',
      'HEAD-NO-DUPLICATES': 'pass',
      'HEAD-TOPIC-AS-H2': 'pass',
      'HEAD-SECTION-COVERAGE': 'skipped',
      'SEO-H1-MAINQUERY': 'pass',
      'SEO-HEADINGS-KEYWORDS': 'pass',
      'SEO-HEADINGS-SPAM': 'pass',
      'BODY-NO-CJK': 'pass',
      'BODY-NO-CITATIONS': 'pass',
      'BODY-NO-AI-PHRASES': 'pass',
      'BODY-NO-PROMISES': 'pass',
      'BODY-NO-TECH-SECTIONS': 'pass',
      'BODY-NO-DUP-PARAGRAPHS': 'fail',
      'BODY-NO-EMPTY-SECTIONS': 'pass',
      'BODY-NO-CHUNK-ARTIFACTS': 'pass',
      'BODY-LENGTH-RANGE': 'skipped',
      'TBL-FORMAT-HONORED': 'skipped',
      'OBJ-FORMAT-HONORED': 'skipped',
      'FAQ-PRESENT': 'skipped',
      'FAQ-UNIQUENESS': 'pass',
      'FAQ-QA-FORMAT': 'pass',
      'FORM-REC-PRESENT': 'fail',
      'SIG-PRESENT': 'skipped',
      'SIG-NO-SPECIALIST': 'pass',
      'LINKS-PRESENT': 'fail',
      'LINKS-NOT-IN-FAQ-SIGNATURE': 'pass',
      'LINKS-SPECIALIST-PRESENT': 'skipped',
      'PROCESS-FINALIZATION': 'fail',
      'FACTCHECK-COVERAGE': 'fail',
      'TIMING-ANOMALY': 'skipped',
      'KEYS-COUNT-BY-LENGTH': 'pass',
      'KEYS-IN-TEXT-SHARE': 'pass',
      'KEYS-DENSITY': 'fail',
      'SEO-DENSITY-PER-KEY': 'fail',
      'LINKS-SITE-COUNT': 'skipped',
      'CANONICAL-LINK-ZONE': 'skipped',
      'MENTIONS-SITE-COUNT': 'skipped',
      'FAQ-KEYS-SHARE': 'pass',
    });
    expect(report.summary).toEqual({ pass: 21, fail: 7, skipped: 11 });
    expect(report.verdict).toBe('fail');
  });

  test('the keyword rules are evaluated against the semantic core', () => {
    const keysCount = rule(report, 'KEYS-COUNT-BY-LENGTH');
    expect(keysCount.status).toBe('pass');
    expect(keysCount.details.totalCore).toBe(GOLDEN_KEYS.length);
    expect(keysCount.details.keysUsed).toBe(GOLDEN_KEYS.length);

    const keysShare = rule(report, 'KEYS-IN-TEXT-SHARE');
    expect(keysShare.status).toBe('pass');
    expect(keysShare.details.total).toBe(GOLDEN_KEYS.length);
    expect(keysShare.details.found).toBe(GOLDEN_KEYS.length);

    const faqShare = rule(report, 'FAQ-KEYS-SHARE');
    expect(faqShare.status).toBe('pass');
    expect(faqShare.details.total).toBe(8);
    expect(faqShare.details.withKeys).toBe(7);
  });
});

describe('M2 postcheck parity — generated fixture (mocked pipeline body)', () => {
  const report = runArticlePostcheck({ markdown: GENERATED_BODY, context: GOLDEN_CONTEXT });

  test('reproduces the generated rule-status snapshot', () => {
    expect(statusMap(report)).toEqual({
      'HEAD-ONE-H1': 'pass',
      'HEAD-NO-SKIPS': 'pass',
      'HEAD-NO-DUPLICATES': 'pass',
      'HEAD-TOPIC-AS-H2': 'pass',
      'HEAD-SECTION-COVERAGE': 'skipped',
      'SEO-H1-MAINQUERY': 'pass',
      'SEO-HEADINGS-KEYWORDS': 'fail',
      'SEO-HEADINGS-SPAM': 'pass',
      'BODY-NO-CJK': 'pass',
      'BODY-NO-CITATIONS': 'pass',
      'BODY-NO-AI-PHRASES': 'pass',
      'BODY-NO-PROMISES': 'pass',
      'BODY-NO-TECH-SECTIONS': 'pass',
      'BODY-NO-DUP-PARAGRAPHS': 'pass',
      'BODY-NO-EMPTY-SECTIONS': 'pass',
      'BODY-NO-CHUNK-ARTIFACTS': 'pass',
      'BODY-LENGTH-RANGE': 'skipped',
      'TBL-FORMAT-HONORED': 'skipped',
      'OBJ-FORMAT-HONORED': 'skipped',
      'FAQ-PRESENT': 'skipped',
      'FAQ-UNIQUENESS': 'pass',
      'FAQ-QA-FORMAT': 'pass',
      'FORM-REC-PRESENT': 'fail',
      'SIG-PRESENT': 'skipped',
      'SIG-NO-SPECIALIST': 'pass',
      'LINKS-PRESENT': 'fail',
      'LINKS-NOT-IN-FAQ-SIGNATURE': 'pass',
      'LINKS-SPECIALIST-PRESENT': 'skipped',
      'PROCESS-FINALIZATION': 'fail',
      'FACTCHECK-COVERAGE': 'fail',
      'TIMING-ANOMALY': 'skipped',
      'KEYS-COUNT-BY-LENGTH': 'skipped',
      'KEYS-IN-TEXT-SHARE': 'fail',
      'KEYS-DENSITY': 'skipped',
      'SEO-DENSITY-PER-KEY': 'skipped',
      'LINKS-SITE-COUNT': 'skipped',
      'CANONICAL-LINK-ZONE': 'skipped',
      'MENTIONS-SITE-COUNT': 'skipped',
      'FAQ-KEYS-SHARE': 'skipped',
    });
    expect(report.summary).toEqual({ pass: 18, fail: 6, skipped: 15 });
    expect(report.verdict).toBe('fail');
  });
});

describe('M2 postcheck parity — one keyword source', () => {
  test('collectKeywords returns the semantic core only', () => {
    expect(collectKeywords(GOLDEN_CONTEXT)).toEqual(GOLDEN_KEYS);
    expect(collectKeywords({ semanticCore: GOLDEN_SEMANTIC_CORE })).toEqual(GOLDEN_KEYS);
  });

  test('the removed keyword source is inert', () => {
    const withLegacy = collectKeywords({
      ...GOLDEN_CONTEXT,
      wordstatKeywords: ['старая частотность', 'ещё одна тема'],
    });
    expect(withLegacy).toEqual(GOLDEN_KEYS);
  });
});
