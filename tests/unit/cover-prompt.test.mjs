/**
 * Cover prompt: server/lib/cover-prompt.mjs — pure
 * prompt-assembly unit tests — the nine prompt cases enumerated below.
 *
 * Contract under test:
 *   - DEFAULT_COVER_SYSTEM_PROMPT is the brand-neutral default text,
 *     byte-identical, and free of the brand constants (M5, D1/P2);
 *   - {title} / {articleBrief} / {refinement} token substitution;
 *   - missing {articleBrief} → brief appended as «Содержание статьи: …»;
 *   - missing {refinement} + refinement present → appended as
 *     «Дополнительные указания: …»; absent refinement → section omitted
 *     (no dangling header line);
 *   - title is NEVER auto-appended when its token is absent;
 *   - unknown {tokens} stay verbatim, logged once, never throw;
 *   - whitespace collapse (no 3+ consecutive newlines) + trimmed result;
 *   - COMPRESSION_PROMPT pins the ≤120-word limit and ≥5 required aspects;
 *   - buildCompressionRequest → { system, user } for callRouterAI.
 *
 * No DB, no network — the module is pure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  DEFAULT_COVER_SYSTEM_PROMPT,
  COMPRESSION_PROMPT,
  buildCoverPrompt,
  buildCompressionRequest,
} from '../../server/lib/cover-prompt.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

// M5 (D1/P2) — the default template is BRAND-NEUTRAL: the face description,
// the Montserrat typeface, the #ed1c24/#c3ab7a palette and the 8px radius
// are gone. Case 1 pins the neutral wording; case 1b keeps a brand constant
// from creeping back in.
const NEUTRAL_TEXT =
  'Создай обложку-баннер для статьи. Текст на изображении — на русском языке, читаемый sans-serif шрифт. Изображение должно выделять главные темы статьи и быть пригодным для публикации в интернете. Используй нейтральную цветовую гамму с высоким контрастом текста и фона. Все внутренние элементы и блоки должны иметь аккуратные скругления краёв.';

const FORBIDDEN_BRAND_FRAGMENTS = [
  'славянск',
  'Montserrat',
  '#ed1c24',
  '#c3ab7a',
  '8px',
];

describe('DEFAULT_COVER_SYSTEM_PROMPT', () => {
  it('1. is the brand-neutral default text byte-for-byte', () => {
    expect(DEFAULT_COVER_SYSTEM_PROMPT).toBe(NEUTRAL_TEXT);
  });

  it('1b. carries no brand constants', () => {
    const lower = DEFAULT_COVER_SYSTEM_PROMPT.toLowerCase();
    for (const fragment of FORBIDDEN_BRAND_FRAGMENTS) {
      expect(lower).not.toContain(fragment.toLowerCase());
    }
  });
});

describe('buildCoverPrompt — token substitution', () => {
  it('2. replaces {articleBrief} with the brief', () => {
    const out = buildCoverPrompt({
      template: 'STYLE.\n\n{articleBrief}',
      brief: 'Чистка лица — процедура для кожи.',
      refinement: null,
      title: null,
    });
    expect(out).toContain('Чистка лица — процедура для кожи.');
    expect(out).not.toContain('{articleBrief}');
    // Substituted in place — no duplicated auto-appended section.
    expect(out.match(/Чистка лица — процедура для кожи\./g)).toHaveLength(1);
    expect(out).not.toContain('Содержание статьи:');
  });

  it('3. appends the brief as «Содержание статьи: …» when the token is absent (brief never lost)', () => {
    const out = buildCoverPrompt({
      template: DEFAULT_COVER_SYSTEM_PROMPT, // no tokens at all
      brief: 'Лазерная шлифовка: курс из 3 процедур.',
      refinement: null,
      title: null,
    });
    expect(out).toContain('Содержание статьи: Лазерная шлифовка: курс из 3 процедур.');
    // Neutral default text preserved intact.
    expect(out.startsWith(NEUTRAL_TEXT)).toBe(true);
  });

  it('4. replaces {refinement} when a refinement exists', () => {
    const out = buildCoverPrompt({
      template: 'STYLE.\n\n{refinement}',
      brief: 'brief',
      refinement: 'Больше золота в палитре.',
      title: null,
    });
    expect(out).toContain('Больше золота в палитре.');
    expect(out).not.toContain('{refinement}');
    expect(out).not.toContain('Дополнительные указания:');
  });

  it('4b. omits the refinement section entirely (no empty header) when no refinement exists', () => {
    const out = buildCoverPrompt({
      template: 'STYLE.\n\nУточнения: {refinement}',
      brief: 'brief',
      refinement: null,
      title: null,
    });
    expect(out).not.toContain('{refinement}');
    // The dangling header line is dropped with the token; the brief section
    // is auto-appended (the template has no {articleBrief} token).
    expect(out).not.toContain('Уточнения:');
    expect(out).toBe('STYLE.\n\nСодержание статьи: brief');
  });

  it('5. appends «Дополнительные указания: …» when the token is absent and a refinement exists', () => {
    const out = buildCoverPrompt({
      template: 'STYLE.\n\n{articleBrief}',
      brief: 'brief-text',
      refinement: 'Не делать текст мелким.',
      title: null,
    });
    expect(out).toContain('Дополнительные указания: Не делать текст мелким.');
  });

  it('6. replaces {title}; never appends the title when the token is absent', () => {
    const withToken = buildCoverPrompt({
      template: 'Обложка для статьи «{title}».\n\n{articleBrief}',
      brief: 'brief',
      refinement: null,
      title: 'Чистка лица',
    });
    expect(withToken).toContain('Обложка для статьи «Чистка лица».');
    expect(withToken).not.toContain('{title}');

    const withoutToken = buildCoverPrompt({
      template: 'STYLE.\n\n{articleBrief}',
      brief: 'brief',
      refinement: null,
      title: 'Чистка лица',
    });
    // Title appears nowhere: not substituted, not appended.
    expect(withoutToken).not.toContain('Чистка лица');
  });

  it('7. leaves unknown {tokens} verbatim, logs once, never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const template = 'STYLE {unknownToken} and {anotherOne}.\n\n{articleBrief}';
    const first = buildCoverPrompt({ template, brief: 'b', refinement: null, title: null });
    expect(first).toContain('{unknownToken}');
    expect(first).toContain('{anotherOne}');
    const callsAfterFirst = warn.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    // Same unknown token in a second call is not logged again (logged once).
    const second = buildCoverPrompt({ template, brief: 'b2', refinement: null, title: null });
    expect(second).toContain('{unknownToken}');
    const newCalls = warn.mock.calls.slice(callsAfterFirst);
    expect(newCalls.some((c) => String(c[0]).includes('unknownToken'))).toBe(false);
  });
});

describe('buildCoverPrompt — whitespace', () => {
  it('8. collapses blank runs to a single \\n\\n and trims the result', () => {
    const out = buildCoverPrompt({
      template: '  STYLE.  \n\n\n\n{articleBrief}\n\n\n{refinement}\n\n  ',
      brief: 'brief',
      refinement: 'ref-text',
      title: null,
    });
    expect(out).toBe(out.trim());
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain('STYLE.');
    expect(out).toContain('brief');
    expect(out).toContain('ref-text');
  });

  it('8b. default template + brief + refinement → exactly three blocks separated by \\n\\n', () => {
    const out = buildCoverPrompt({
      template: DEFAULT_COVER_SYSTEM_PROMPT,
      brief: 'Краткое описание статьи.',
      refinement: 'Акцент на цене.',
      title: null,
    });
    expect(out).toBe(
      [
        NEUTRAL_TEXT,
        'Содержание статьи: Краткое описание статьи.',
        'Дополнительные указания: Акцент на цене.',
      ].join('\n\n'),
    );
  });
});

describe('COMPRESSION_PROMPT + buildCompressionRequest', () => {
  it('9. pins the ≤120-word limit and mentions ≥5 required aspects', () => {
    expect(COMPRESSION_PROMPT).toContain('120');
    const aspects = [
      /процедур/i, // procedure
      /(польз|эффект)/i, // benefits
      /аудитор/i, // audience
      /показани/i, // indications
      /длительн/i, // duration & course
      /цен[аыу]/i, // price / special offer
      /(CTA|призыв)/i, // call to action
      /условия/i, // key terms
    ];
    const hits = aspects.filter((re) => re.test(COMPRESSION_PROMPT)).length;
    expect(hits).toBeGreaterThanOrEqual(5);
  });

  it('buildCompressionRequest → system = COMPRESSION_PROMPT, user carries title + text', () => {
    const req = buildCompressionRequest({ title: 'Чистка лица', text: 'Текст статьи про чистку.' });
    expect(req.system).toBe(COMPRESSION_PROMPT);
    expect(req.user).toContain('Чистка лица');
    expect(req.user).toContain('Текст статьи про чистку.');
  });
});
