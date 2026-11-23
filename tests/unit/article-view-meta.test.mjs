/**
 * P1b + P1c (2026-09-18): deterministic presentation meta of the
 * final article — the visible «Обновлено: DD.MM.YYYY» line (house pattern of
 * the author signature) and the JSON-LD (Article + FAQPage) script attached
 * to the rendered HTML after postcheck input assembly.
 *
 * Everything here is a pure DB-free unit: the worker seam itself is covered
 * 1:1 by tests/unit/article-tail-smoke.test.mjs (replica of saveFinalVersion
 * tail steps) — the pattern approved for buildAuthorSignature coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  formatRuDate,
  appendUpdatedDateLine,
  extractFaqEntries,
  buildArticleJsonLd,
  attachArticleJsonLd,
} from '../../server/lib/article-view-meta.mjs';
import { runArticlePostcheck } from '../../server/lib/article-postcheck.mjs';
import { reduceKeySpam, trimOverlongArticleBody } from '../../server/article-post-processor.mjs';

/** Noon-local dates: the date component is stable in any timezone (offsets < 12h). */
const D_SEP_18 = new Date(2026, 8, 18, 12, 0, 0);
const D_SEP_01 = new Date(2026, 8, 1, 12, 0, 0);
const D_JAN_02 = new Date(2026, 0, 2, 12, 0, 0);

/** Representative article tail: body section → FAQ «10 необычных вопросов» → signature. */
const FAQ_SECTION = [
  '## 10 необычных вопросов: Имплантация зубов',
  '',
  ...Array.from({ length: 10 }, (_, i) => [
    `### Неочевидный вопрос про имплантацию №${i + 1}?`,
    '',
    `Краткий ответ №${i + 1}. **Обоснование** из двух предложений [со ссылкой](https://example.com/s).`,
    '',
  ]).flat(),
].join('\n').replace(/\n+$/, '');

const SIGNATURE = '\n\n---\n\n**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог\n';

function buildArticleMarkdown(withLine = false) {
  const head = [
    '# Имплантация зубов: полное руководство',
    '',
    'Имплантация зубов — метод восстановления утраченных зубов титановым корнем.',
    '',
    '## Виды имплантации',
    '',
    'Одноэтапная и двухэтапная имплантация зубов, а также протокол All-on-4.',
    'Имплантация зубов нижней челюсти отличается по плотности кости.',
    '',
    '## Цены на имплантацию зубов',
    '',
    'Стоимость складывается из количества имплантов и типа коронки.',
  ].join('\n');
  const tail = [
    FAQ_SECTION,
    withLine ? '*Обновлено: 18.09.2026*' : '',
    SIGNATURE.replace(/^\n+/, '').replace(/\n+$/, ''),
  ]
    .filter(Boolean)
    .join('\n\n');
  return `${head}\n\n${tail}`;
}

/** Mirrors the worker seam: content → appendUpdatedDateLine → += signature. */
function buildViaSeam(date = D_SEP_18, withSignature = true) {
  const content = [
    '# Имплантация зубов: полное руководство',
    '',
    'Имплантация зубов — метод восстановления утраченных зубов титановым корнем.',
    '',
    '## Виды имплантации',
    '',
    'Одноэтапная и двухэтапная имплантация зубов, а также протокол All-on-4.',
    'Имплантация зубов нижней челюсти отличается по плотности кости.',
    '',
    '## Цены на имплантацию зубов',
    '',
    'Стоимость складывается из количества имплантов и типа коронки.',
    '',
    FAQ_SECTION,
  ].join('\n');
  const withLine = appendUpdatedDateLine(content, date);
  return withSignature ? `${withLine}${SIGNATURE}` : withLine;
}

/** Postcheck context sufficient to activate the keyword/link rule families. */
function postcheckContext() {
  return {
    topic: 'Имплантация зубов',
    targetLength: 8000,
    specialistId: 's1',
    hasSuccessfulFactcheckRun: true,
    finalizedVia: 'normal',
    structuredOutputs: {},
    wordstatKeywords: [],
    semanticCore: {
      mainQueryRu: 'имплантация зубов',
      queryClustersRu: [{ clusterRu: 'имплантация зубов', queriesRu: ['имплантация зубов цена'] }],
    },
    formatRuSections: [],
    timings: {},
    mergedHeadings: [],
    siteDomains: ['example.com'],
    sourceSite: { name: 'Тестовая компания', baseUrl: 'https://example.com' },
    canonicalServiceUrl: '',
    sourceSpecialistsCount: 1,
    specialistPageUrls: ['https://example.com/vrachi/ivanov'],
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * Part 1 — «Обновлено: DD.MM.YYYY» date line
 * ═══════════════════════════════════════════════════════════════════════ */

describe('P1b — formatRuDate', () => {
  it('formats a Date as DD.MM.YYYY', () => {
    expect(formatRuDate(D_SEP_18)).toBe('18.09.2026');
    expect(formatRuDate(D_JAN_02)).toBe('02.01.2026');
  });

  it('accepts an ISO string and returns "" for invalid input', () => {
    expect(formatRuDate('2026-09-18T12:00:00')).toBe('18.09.2026');
    expect(formatRuDate('not-a-date')).toBe('');
    expect(formatRuDate(null)).toBe('');
    expect(formatRuDate(undefined)).toBe('');
  });
});

describe('P1b — appendUpdatedDateLine', () => {
  it('inserts the line at the tail; the SIGNATURE stays the last non-empty line (SIG-PRESENT contract)', () => {
    const out = buildViaSeam();

    const nonEmpty = out.split('\n').filter((l) => l.trim());
    expect(nonEmpty[nonEmpty.length - 1]).toBe('**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог');
    // Tail shape: … → updated line → signature hr (---) → signature marker.
    expect(nonEmpty[nonEmpty.length - 2]).toBe('---');
    expect(nonEmpty[nonEmpty.length - 3]).toBe('*Обновлено: 18.09.2026*');
    // Order: FAQ section → updated line → signature.
    const faqIdx = out.indexOf('## 10 необычных вопросов');
    const dateIdx = out.indexOf('*Обновлено: 18.09.2026*');
    const sigIdx = out.indexOf('**Автор статьи:**');
    expect(faqIdx).toBeGreaterThan(-1);
    expect(dateIdx).toBeGreaterThan(faqIdx);
    expect(sigIdx).toBeGreaterThan(dateIdx);
    // Exactly one occurrence.
    expect(out.match(/Обновлено:/g) || []).toHaveLength(1);
  });

  it('without a specialist the line itself closes the article (SIG rules are skipped then)', () => {
    const out = buildViaSeam(D_SEP_18, false);
    const nonEmpty = out.split('\n').filter((l) => l.trim());
    expect(nonEmpty[nonEmpty.length - 1]).toBe('*Обновлено: 18.09.2026*');
    expect(out).not.toContain('Автор статьи');
  });

  it('is idempotent: re-saving the same version does not duplicate the line', () => {
    const md = buildArticleMarkdown();
    const once = appendUpdatedDateLine(md, D_SEP_18);
    const twice = appendUpdatedDateLine(once, D_SEP_18);
    expect(twice).toBe(once);
    expect(twice.match(/Обновлено:/g) || []).toHaveLength(1);
  });

  it('re-dating strips the previous line first (date rollover → single line, new date)', () => {
    const withOld = appendUpdatedDateLine(buildArticleMarkdown(), D_SEP_01);
    const withNew = appendUpdatedDateLine(withOld, D_SEP_18);
    expect(withNew).toContain('*Обновлено: 18.09.2026*');
    expect(withNew).not.toContain('*Обновлено: 01.09.2026*');
    expect(withNew.match(/Обновлено:/g) || []).toHaveLength(1);
  });

  it('strips defensive variants emitted by the model (plain and bold forms)', () => {
    const md = [
      buildArticleMarkdown().replace(/\n+$/, ''),
      'Обновлено: 01.01.2020',
      '**Обновлено: 02.01.2020**',
      '',
    ].join('\n');
    const out = appendUpdatedDateLine(md, D_SEP_18);
    expect(out).not.toContain('01.01.2020');
    expect(out).not.toContain('02.01.2020');
    expect(out.match(/Обновлено:/g) || []).toHaveLength(1);
  });

  it('does not touch look-alike lines inside code fences', () => {
    const md = [
      buildArticleMarkdown().replace(/\n+$/, ''),
      '```',
      '*Обновлено: 01.01.2020*',
      '```',
      '',
    ].join('\n');
    const out = appendUpdatedDateLine(md, D_SEP_18);
    // Fenced copy survives, appended line exists → two occurrences total.
    expect(out).toContain('*Обновлено: 01.01.2020*');
    expect(out).toContain('*Обновлено: 18.09.2026*');
    expect(out.match(/Обновлено:/g) || []).toHaveLength(2);
  });

  it('invalid date → markdown unchanged (fail-safe, no broken line)', () => {
    const md = buildArticleMarkdown();
    expect(appendUpdatedDateLine(md, 'garbage')).toBe(md);
  });

  it('empty markdown → just the line, no leading blank separators', () => {
    expect(appendUpdatedDateLine('', D_SEP_18)).toBe('*Обновлено: 18.09.2026*');
  });

  it('mutator-safety: reduceKeySpam and trimOverlongArticleBody never touch the line', () => {
    const withLine = buildViaSeam();
    const seoCore = {
      mainQueryRu: 'имплантация зубов',
      queryClustersRu: [{ clusterRu: 'имплантация зубов', queriesRu: ['имплантация зубов цена'] }],
      wordstatKeywords: [],
    };

    const spam = reduceKeySpam(withLine, seoCore, { wordstatKeywords: [] });
    expect(spam.text).toContain('*Обновлено: 18.09.2026*');
    expect(spam.text.match(/Обновлено:/g) || []).toHaveLength(1);

    const trimmed = trimOverlongArticleBody(withLine, { targetLength: 500 });
    expect(trimmed.markdown).toContain('*Обновлено: 18.09.2026*');
    expect(trimmed.markdown.match(/Обновлено:/g) || []).toHaveLength(1);
  });

  it('postcheck neutrality: no rule flips status, verdict and summary unchanged', () => {
    const without = buildArticleMarkdown(false);
    const withLine = buildViaSeam();

    const r1 = runArticlePostcheck({ markdown: without, html: '', context: postcheckContext() });
    const r2 = runArticlePostcheck({ markdown: withLine, html: '', context: postcheckContext() });

    const triples = (r) => r.rules.map((x) => `${x.id}:${x.status}:${x.severity}`);
    expect(triples(r2)).toEqual(triples(r1));
    expect(r2.verdict).toBe(r1.verdict);
    expect(r2.summary).toEqual(r1.summary);
    // The frozen SIG-PRESENT contract keeps passing: signature stays last.
    const sig = r2.rules.find((x) => x.id === 'SIG-PRESENT');
    expect(sig.status).toBe('pass');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Part 2 — JSON-LD (Article + FAQPage)
 * ═══════════════════════════════════════════════════════════════════════ */

describe('P1c — extractFaqEntries', () => {
  it('extracts H3 question + plain-text answer pairs from the FAQ section', () => {
    const entries = extractFaqEntries(buildArticleMarkdown());
    expect(entries).toHaveLength(10);
    expect(entries[0].question).toBe('Неочевидный вопрос про имплантацию №1?');
    // Markdown is unwrapped: no ** / [anchor](url) leftovers in the answer text.
    expect(entries[0].answer).toBe(
      'Краткий ответ №1. Обоснование из двух предложений со ссылкой.'
    );
  });

  it('returns [] when the article has no FAQ section', () => {
    const md = '# Тема\n\n## Раздел\n\nТекст без FAQ.\n';
    expect(extractFaqEntries(md)).toEqual([]);
  });

  it('ignores legacy bold-format questions (only H3 Q/A, the current pipeline format)', () => {
    const md = [
      '## Часто задаваемые вопросы',
      '',
      '**Старый формат вопроса?**',
      '',
      'Ответ старого формата.',
      '',
      '### Новый формат вопроса?',
      '',
      'Ответ нового формата.',
    ].join('\n');
    const entries = extractFaqEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].question).toBe('Новый формат вопроса?');
  });

  it('stops at the next H2 section and drops entries with empty answers', () => {
    const md = [
      '## 10 необычных вопросов: Тема',
      '',
      '### Вопрос с ответом?',
      '',
      'Ответ есть.',
      '',
      '### Вопрос без ответа?',
      '',
      '## Заключение',
      '',
      'Текст заключения.',
    ].join('\n');
    const entries = extractFaqEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].answer).toBe('Ответ есть.');
  });

  it('the P1b updated-date line / signature hr never leak into the last answer', () => {
    const entries = extractFaqEntries(buildViaSeam()); // FAQ → «Обновлено» → --- → подпись
    expect(entries).toHaveLength(10);
    for (const e of entries) {
      expect(e.answer).not.toContain('Обновлено');
      expect(e.answer).not.toContain('Автор статьи');
    }
    expect(entries[9].answer).toBe(
      'Краткий ответ №10. Обоснование из двух предложений со ссылкой.'
    );
  });
});

describe('P1c — buildArticleJsonLd', () => {
  const FULL_INPUT = () => ({
    articleId: '0f4a3b2c-0000-4000-8000-000000000001',
    headline: 'Имплантация зубов: полное руководство',
    datePublished: D_JAN_02,
    dateModified: D_SEP_18,
    specialist: { fullName: 'Иванов Иван Иванович', position: 'Врач-имплантолог' },
    siteName: 'Тестовая компания',
    faq: extractFaqEntries(buildArticleMarkdown()),
  });

  function parseScript(script) {
    const open = '<script type="application/ld+json" data-generaptor="article-schema">';
    expect(script.startsWith(open)).toBe(true);
    expect(script.endsWith('</script>')).toBe(true);
    return JSON.parse(script.slice(open.length, -'</script>'.length));
  }

  it('produces @context + @graph [Article, FAQPage] with all required fields', () => {
    const parsed = parseScript(buildArticleJsonLd(FULL_INPUT()));

    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@graph']).toHaveLength(2);

    const article = parsed['@graph'][0];
    expect(article['@type']).toBe('Article');
    expect(article['@id']).toBe('urn:generaptor:article:0f4a3b2c-0000-4000-8000-000000000001#article');
    expect(article.headline).toBe('Имплантация зубов: полное руководство');
    expect(article.datePublished).toBe('2026-01-02');
    expect(article.dateModified).toBe('2026-09-18');
    expect(article.inLanguage).toBe('ru');
    expect(article.author).toEqual({
      '@type': 'Person',
      name: 'Иванов Иван Иванович',
      jobTitle: 'Врач-имплантолог',
      affiliation: { '@type': 'Organization', name: 'Тестовая компания' },
    });

    const faq = parsed['@graph'][1];
    expect(faq['@type']).toBe('FAQPage');
    expect(faq.mainEntity).toHaveLength(10);
    expect(faq.mainEntity[0]).toEqual({
      '@type': 'Question',
      name: 'Неочевидный вопрос про имплантацию №1?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Краткий ответ №1. Обоснование из двух предложений со ссылкой.',
      },
    });
  });

  it('siteName — единственный источник affiliation автора', () => {
    // Нейтральный контракт: имя компании приходит только под ключом siteName.
    const named = parseScript(
      buildArticleJsonLd({ ...FULL_INPUT(), siteName: 'New Company' }),
    );
    expect(named['@graph'][0].author.affiliation).toEqual({
      '@type': 'Organization',
      name: 'New Company',
    });

    const unnamed = parseScript(
      buildArticleJsonLd({ ...FULL_INPUT(), siteName: undefined }),
    );
    expect(unnamed['@graph'][0].author.affiliation).toBeUndefined();
  });

  it('omits the FAQPage node entirely when the article has no FAQ', () => {
    const parsed = parseScript(buildArticleJsonLd({ ...FULL_INPUT(), faq: [] }));
    expect(parsed['@graph']).toHaveLength(1);
    expect(parsed['@graph'][0]['@type']).toBe('Article');
    expect(JSON.stringify(parsed)).not.toContain('FAQPage');
  });

  it('no specialist → no author node (organization ghost author is forbidden)', () => {
    const parsed = parseScript(buildArticleJsonLd({ ...FULL_INPUT(), specialist: null }));
    expect(parsed['@graph'][0].author).toBeUndefined();
  });

  it('specialist without position → jobTitle omitted; пустое имя компании → affiliation omitted', () => {
    const noPosition = parseScript(
      buildArticleJsonLd({ ...FULL_INPUT(), specialist: { fullName: 'Иванов Иван Иванович' } })
    );
    expect(noPosition['@graph'][0].author).toEqual({
      '@type': 'Person',
      name: 'Иванов Иван Иванович',
      affiliation: { '@type': 'Organization', name: 'Тестовая компания' },
    });

    const noCompany = parseScript(buildArticleJsonLd({ ...FULL_INPUT(), siteName: '   ' }));
    expect(noCompany['@graph'][0].author).toEqual({
      '@type': 'Person',
      name: 'Иванов Иван Иванович',
      jobTitle: 'Врач-имплантолог',
    });
  });

  it('empty headline → "" (no broken schema emitted)', () => {
    expect(buildArticleJsonLd({ ...FULL_INPUT(), headline: '  ' })).toBe('');
  });

  it('deterministic serialization: identical input → byte-identical script, stable key order', () => {
    const a = buildArticleJsonLd(FULL_INPUT());
    const b = buildArticleJsonLd(FULL_INPUT());
    expect(b).toBe(a);

    // Spot-check stable key order (insertion order is the contract).
    expect(a.indexOf('"headline"')).toBeLessThan(a.indexOf('"datePublished"'));
    expect(a.indexOf('"datePublished"')).toBeLessThan(a.indexOf('"dateModified"'));
    expect(a.indexOf('"dateModified"')).toBeLessThan(a.indexOf('"inLanguage"'));
  });

  it('escapes </script> inside RU strings (no premature tag close) and still round-trips', () => {
    const script = buildArticleJsonLd({
      ...FULL_INPUT(),
      faq: [{ question: 'Опасный вопрос?</script>?', answer: 'Ответ со </script> внутри.' }],
    });
    // Only the single real closing tag — no premature close from RU strings.
    expect(script.match(/<\/script>/g) || []).toHaveLength(1);
    const open = '<script type="application/ld+json" data-generaptor="article-schema">';
    const payload = script.slice(open.length, -9);
    expect(payload).toContain('<\\/script>');
    const parsed = JSON.parse(payload);
    expect(parsed['@graph'][1].mainEntity[0].acceptedAnswer.text).toBe('Ответ со </script> внутри.');
  });
});

describe('P1c — attachArticleJsonLd', () => {
  const HTML = '<h1>Тема</h1>\n<p>Текст статьи.</p>';
  const SCRIPT = buildArticleJsonLd({
    articleId: 'a1',
    headline: 'Тема',
    datePublished: D_JAN_02,
    dateModified: D_SEP_18,
    specialist: null,
    siteName: '',
    faq: [],
  });

  it('appends the script at the end of the html body', () => {
    const out = attachArticleJsonLd(HTML, SCRIPT);
    expect(out.startsWith(HTML)).toBe(true);
    expect(out).toBe(`${HTML}\n${SCRIPT}`);
  });

  it('is idempotent: attaching twice leaves exactly one script', () => {
    const once = attachArticleJsonLd(HTML, SCRIPT);
    const twice = attachArticleJsonLd(once, SCRIPT);
    expect(twice).toBe(once);
    expect(twice.match(/application\/ld\+json/g) || []).toHaveLength(1);
  });

  it('replaces a stale schema script from a previous version (re-save)', () => {
    const stale = buildArticleJsonLd({
      articleId: 'old-id',
      headline: 'Старый заголовок',
      datePublished: D_JAN_02,
      dateModified: D_SEP_01,
      specialist: null,
      siteName: '',
      faq: [],
    });
    const withStale = attachArticleJsonLd(HTML, stale);
    const refreshed = attachArticleJsonLd(withStale, SCRIPT);
    expect(refreshed.match(/application\/ld\+json/g) || []).toHaveLength(1);
    expect(refreshed).not.toContain('urn:generaptor:article:old-id');
    expect(refreshed).toContain('dateModified');
  });

  it('empty html → "" (nothing to attach to)', () => {
    expect(attachArticleJsonLd('', SCRIPT)).toBe('');
    expect(attachArticleJsonLd(null, SCRIPT)).toBe('');
  });
});

describe('P1c — postcheck blindness: JSON-LD must be invisible to the postcheck', () => {
  it('runArticlePostcheck report is identical with and without the attached JSON-LD', () => {
    const markdown = buildArticleMarkdown();
    // The real pipeline passes html WITHOUT JSON-LD (attach happens after
    // postcheck input assembly); the invariant is proven by direct comparison.
    const baseHtml = '<h1>Тема</h1>\n<p>Текст. {{src:1}}</p>';

    const script = buildArticleJsonLd({
      articleId: 'a1',
      headline: 'Тема',
      datePublished: D_JAN_02,
      dateModified: D_SEP_18,
      specialist: { fullName: 'Иванов Иван Иванович', position: 'Врач-имплантолог' },
      siteName: 'Тестовая компания',
      faq: extractFaqEntries(markdown),
    });
    const attached = attachArticleJsonLd(baseHtml, script);

    const r1 = runArticlePostcheck({ markdown, html: baseHtml, context: postcheckContext() });
    const r2 = runArticlePostcheck({ markdown, html: attached, context: postcheckContext() });

    // Full deep equality: no rule, no message, no count may shift.
    expect(r2).toEqual(r1);
    expect(r2.verdict).toBe(r1.verdict);
    expect(r2.summary).toEqual(r1.summary);
  });
});
