import { describe, expect, it } from 'vitest';
import {
  ARTICLE_AUTHOR_AGENT_NAMES,
  classifyArticleRuns,
} from '../../server/lib/article-runs-classifier.mjs';

/**
 * Unit tests for classifyArticleRuns — pure function, no DB.
 *
 * Worker conventions (server/workers/article-generation.mjs):
 * - AgentRun.agentName stores role.nameRu; the author role is «Агент автора»
 *   (agent-role-data.mjs, id 'article-author').
 * - A fallback run is written with status 'completed' AND error 'fallback: <reason>'
 *   (NOT status 'failed') — see worker lines ~1309-1317 (author) and ~1356-1371
 *   (post-author role). Both variants are covered below.
 *
 * Scenarios under test (per task T4):
 *   A — author failed with fallback → template content = true;
 *   B — author succeeded, later role fell back → template = false (the bug case);
 *   C — no author run at all, early role fell back → template = true;
 *   D — no fallbacks at all → both flags false;
 *   E — author fell back once, then a successful author retry → template = false;
 *   F — empty array / null input → everything false/null;
 *   + generationStartedAt = min(startedAt) across runs.
 */

const T0 = new Date('2026-08-14T10:00:00.000Z');
const T1 = new Date('2026-08-14T10:05:00.000Z');
const T2 = new Date('2026-08-14T10:20:00.000Z');
const T3 = new Date('2026-08-14T11:00:00.000Z');

/** Minimal AgentRun factory with the fields the classifier consumes. */
function mkRun(fields) {
  return {
    agentName: 'Агент автора',
    status: 'completed',
    error: null,
    startedAt: T1,
    ...fields,
  };
}

describe('ARTICLE_AUTHOR_AGENT_NAMES', () => {
  it('contains the exact nameRu the worker writes («Агент автора»)', () => {
    expect(ARTICLE_AUTHOR_AGENT_NAMES).toContain('Агент автора');
  });

  it('also accepts the roleKey form for robustness', () => {
    expect(ARTICLE_AUTHOR_AGENT_NAMES).toContain('article-author');
  });
});

describe('classifyArticleRuns — scenario A: author fell back → true template', () => {
  it('worker-realistic shape: author run completed with error "fallback: …"', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'Агент структуры', startedAt: T0 }),
      mkRun({ error: 'fallback: 502 Bad Gateway', startedAt: T1 }),
    ]);
    expect(result.hasFallback).toBe(true);
    expect(result.hasTemplateContent).toBe(true);
  });

  it('status "failed" author run with fallback error also counts as template', () => {
    const result = classifyArticleRuns([
      mkRun({ status: 'failed', error: 'fallback: fetch failed', startedAt: T1 }),
    ]);
    expect(result.hasTemplateContent).toBe(true);
  });
});

describe('classifyArticleRuns — scenario B: author OK, later role fell back (main bug case)', () => {
  it('template=false even though a fallback error exists', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'Агент выбора темы', startedAt: T0 }),
      mkRun({ error: null, startedAt: T1 }), // author completed cleanly
      mkRun({
        agentName: 'Агент очеловечивания',
        error: 'fallback: fetch failed',
        startedAt: T2,
      }),
    ]);
    expect(result.hasFallback).toBe(true); // legacy flag preserved
    expect(result.hasTemplateContent).toBe(false); // <-- the fix
  });

  it('author identified by roleKey "article-author" as well', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'article-author', error: null, startedAt: T1 }),
      mkRun({ agentName: 'SEO-агент', error: 'fallback: HTTP 502', startedAt: T2 }),
    ]);
    expect(result.hasTemplateContent).toBe(false);
  });
});

describe('classifyArticleRuns — scenario C: no author run, early role fell back', () => {
  it('template=true when the author never ran', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'Агент выбора темы', startedAt: T0 }),
      mkRun({
        agentName: 'Агент исследования',
        error: 'fallback: fetch failed',
        startedAt: T1,
      }),
    ]);
    expect(result.hasFallback).toBe(true);
    expect(result.hasTemplateContent).toBe(true);
  });

  it('template=true when the author run exists but is still running (not completed)', () => {
    const result = classifyArticleRuns([
      mkRun({ status: 'running', error: null, startedAt: T1 }),
      mkRun({ agentName: 'Агент семантики', error: 'fallback: HTTP 502', startedAt: T0 }),
    ]);
    expect(result.hasTemplateContent).toBe(true);
  });
});

describe('classifyArticleRuns — scenario D: no fallbacks at all', () => {
  it('normal successful article → both flags false', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'Агент выбора темы', startedAt: T0 }),
      mkRun({ error: null, startedAt: T1 }),
      mkRun({ agentName: 'Агент фактчекинга', error: null, startedAt: T2 }),
    ]);
    expect(result.hasFallback).toBe(false);
    expect(result.hasTemplateContent).toBe(false);
  });

  it('a non-fallback error (e.g. hard failure) does not set flags', () => {
    const result = classifyArticleRuns([
      mkRun({ status: 'failed', error: 'RouterAI 401 Unauthorized', startedAt: T1 }),
    ]);
    expect(result.hasFallback).toBe(false);
    expect(result.hasTemplateContent).toBe(false);
  });
});

describe('classifyArticleRuns — scenario E: author fallback + successful author retry', () => {
  it('template=false because a clean author run exists', () => {
    const result = classifyArticleRuns([
      mkRun({ error: 'fallback: fetch failed', startedAt: T1 }), // failed attempt
      mkRun({ error: null, startedAt: T2 }), // clean retry of the same role
    ]);
    expect(result.hasFallback).toBe(true);
    expect(result.hasTemplateContent).toBe(false);
  });
});

describe('classifyArticleRuns — FIX-6: empty-string error counts as no error', () => {
  it("author completed with error:'' + fallback run of another role → NOT a template", () => {
    const result = classifyArticleRuns([
      mkRun({ error: '', startedAt: T1 }),
      mkRun({ agentName: 'SEO-агент', error: 'fallback: HTTP 502', startedAt: T2 }),
    ]);
    expect(result.hasFallback).toBe(true);
    expect(result.hasTemplateContent).toBe(false);
  });

  it("author completed with error:'' and no other author run → still a success (template=false)", () => {
    const result = classifyArticleRuns([mkRun({ error: '', startedAt: T1 })]);
    expect(result.hasTemplateContent).toBe(false);
  });
});

describe('classifyArticleRuns — scenario F: empty / null input', () => {
  it('empty array → all false, generationStartedAt null', () => {
    expect(classifyArticleRuns([])).toEqual({
      hasFallback: false,
      hasTemplateContent: false,
      generationStartedAt: null,
    });
  });

  it('null and undefined → same neutral result', () => {
    const neutral = {
      hasFallback: false,
      hasTemplateContent: false,
      generationStartedAt: null,
    };
    expect(classifyArticleRuns(null)).toEqual(neutral);
    expect(classifyArticleRuns(undefined)).toEqual(neutral);
  });

  it('array of nulls / malformed entries does not crash', () => {
    const result = classifyArticleRuns([null, undefined, 42, { agentName: 'Агент автора' }]);
    expect(result.hasFallback).toBe(false);
    expect(result.hasTemplateContent).toBe(false);
    expect(result.generationStartedAt).toBeNull();
  });
});

describe('classifyArticleRuns — hasFallback legacy semantics', () => {
  it('matches "fallback" case-insensitively (parity with the DB probe, mode insensitive)', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'SEO-агент', error: 'FALLBACK: upstream reset' }),
    ]);
    expect(result.hasFallback).toBe(true);
  });

  it('an error that merely mentions fallback mid-string still counts (legacy substring probe)', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'SEO-агент', error: 'role aborted, used fallback path, see logs' }),
    ]);
    expect(result.hasFallback).toBe(true);
  });

  it('non-string error values are ignored', () => {
    const result = classifyArticleRuns([mkRun({ error: undefined }), mkRun({ error: 0 })]);
    expect(result.hasFallback).toBe(false);
  });
});

describe('classifyArticleRuns — generationStartedAt', () => {
  it('returns the minimum startedAt across runs (Date input)', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'Агент автора', startedAt: T2 }),
      mkRun({ agentName: 'Агент выбора темы', startedAt: T0 }),
      mkRun({ agentName: 'SEO-агент', startedAt: T1 }),
    ]);
    expect(result.generationStartedAt).toBe(T0);
  });

  it('supports ISO strings (Prisma JSON payloads) and preserves the representation', () => {
    const earliest = '2026-08-14T09:30:00.000Z';
    const result = classifyArticleRuns([
      mkRun({ startedAt: '2026-08-14T10:00:00.000Z' }),
      mkRun({ agentName: 'Агент выбора темы', startedAt: earliest }),
    ]);
    expect(result.generationStartedAt).toBe(earliest);
  });

  it('ignores null startedAt values', () => {
    const result = classifyArticleRuns([
      mkRun({ agentName: 'Агент выбора темы', startedAt: null }),
      mkRun({ startedAt: T1 }),
    ]);
    expect(result.generationStartedAt).toBe(T1);
  });

  it('is null when every startedAt is null', () => {
    const result = classifyArticleRuns([mkRun({ startedAt: null }), mkRun({ startedAt: null })]);
    expect(result.generationStartedAt).toBeNull();
  });

  it('is null for empty input', () => {
    expect(classifyArticleRuns([]).generationStartedAt).toBeNull();
    expect(classifyArticleRuns(null).generationStartedAt).toBeNull();
  });

  it('handles an unparseable string startedAt without crashing', () => {
    const result = classifyArticleRuns([
      mkRun({ startedAt: 'not-a-date' }),
      mkRun({ agentName: 'Агент выбора темы', startedAt: T3 }),
    ]);
    expect(result.generationStartedAt).toBe(T3);
  });
});
