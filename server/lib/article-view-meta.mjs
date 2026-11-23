/**
 * P1b + P1c (2026-09-18): deterministic presentation
 * metadata of the final article.
 *
 * Two independent pure helpers, both consumed by the late tail of
 * saveFinalVersion (server/workers/article-generation.mjs):
 *
 *  1. Visible «Обновлено: DD.MM.YYYY» line — house pattern of the author
 *     signature block (buildAuthorSignature): a short neutral string appended
 *     at the very same late stage (AFTER reduceKeySpam / trim / merge passes),
 *     so it carries the same "untouchable" guarantees. Idempotent: a previous
 *     occurrence is stripped before the new one is inserted, so re-saving the
 *     version never duplicates the line.
 *
 *  2. JSON-LD structured data (schema.org @graph: Article + FAQPage) —
 *     attached to the rendered article HTML AFTER the postcheck input is
 *     assembled (the postcheck must never see the JSON-LD text — it would
 *     corrupt density/phrase/link counts). Deterministic serialization:
 *     fixed key order, no clock/Date.now inside, `</` escaped so the JSON
 *     payload can never close the host <script> tag prematurely.
 *
 * No DB, no LLM, no clock reads: every function is a pure transform
 * (the worker supplies article data and the version timestamp).
 */
import { POSTCHECK_FAQ_HEADING_RE } from './article-postcheck.mjs';

/* ── Document scan primitives (shared by both parts) ── */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SIGNATURE_MARKER = '**Автор статьи:**';
const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_LINE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/* ════════════════════════════════════════════════════════════════════════
 * Part 1 — «Обновлено: DD.MM.YYYY» date line
 * ═══════════════════════════════════════════════════════════════════════ */

/** Whole-line marker of an updated-date line (our italic form plus defensive
 *  plain/bold variants the model could emit). Matches ONLY full lines. */
const UPDATED_LINE_RE = /^ {0,3}\*{0,2}Обновлено:[ \t]*\d{1,2}\.\d{1,2}\.\d{4}\*{0,2}[ \t]*$/;

/** Local Date components as a two-digit-padded pair (DD.MM.YYYY). */
function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.trim()) return new Date(value);
  return null;
}

/**
 * Date → 'DD.MM.YYYY' (RU reader-facing convention, local components — the
 * same clock the server audience lives in; the visible line and the ISO
 * dates in JSON-LD below share this convention).
 * Invalid/absent input → '' (caller decides how to fail-safe).
 *
 * @param {Date|string} value
 * @returns {string}
 */
export function formatRuDate(value) {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Append (idempotently) the «Обновлено: DD.MM.YYYY» line to the article tail.
 *
 * Contract:
 *  - strips every existing updated-line OUTSIDE code fences first (re-save of
 *    the same version → exactly one line, date rollover → single new line);
 *  - placement: signature-aware — when the markdown already carries the
 *    author signature block, the line is re-inserted immediately BEFORE its
 *    horizontal rule, otherwise it is appended at the end. Either way the
 *    line lands directly above the signature, so the frozen postcheck rule
 *    SIG-PRESENT (signature = last non-empty line) keeps passing under ANY
 *    call order — f(md + signature) === f(md) + signature;
 *  - the worker calls it at the signature stage, i.e. after every
 *    reduce/trim/merge mutator has run — the same "untouchable" guarantees
 *    as the signature itself;
 *  - invalid date → markdown returned unchanged (fail-safe, no broken line);
 *  - pure: no clock inside, the caller passes the version timestamp.
 *
 * @param {string} markdown final article markdown (with or without signature)
 * @param {Date|string} date updatedAt of the version being saved
 * @returns {string}
 */
export function appendUpdatedDateLine(markdown, date) {
  const safeMd = typeof markdown === 'string' ? markdown : '';
  const ru = formatRuDate(date);
  if (!ru) return safeMd;

  // Strip previous occurrences (fence-aware: code blocks are never touched)
  // and collapse blank-line runs OUTSIDE fences left by the removal — keeps
  // the helper a strict projection: f(f(md)) === f(md) byte-for-byte.
  const kept = [];
  let inFence = false;
  for (const line of safeMd.split('\n')) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (!inFence && UPDATED_LINE_RE.test(line)) continue;
    if (!inFence && line.trim() === '' && kept.length && kept[kept.length - 1].trim() === '') continue;
    kept.push(line);
  }
  const base = kept.join('\n').replace(/\n+$/, '');
  if (!base) return `*Обновлено: ${ru}*`;

  // No signature below → plain tail append (worker's primary flow appends
  // the signature block AFTER this call).
  const lines = base.split('\n');
  let sigIdx = -1;
  inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_LINE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (lines[i].trim().startsWith(SIGNATURE_MARKER)) {
      sigIdx = i;
      break;
    }
  }
  if (sigIdx === -1) {
    return `${base}\n\n*Обновлено: ${ru}*`;
  }

  // Signature present: insert above the hr of its block (house format
  // '\n\n---\n\n**Автор статьи:** …') — or above the marker when no hr.
  let insertAt = sigIdx;
  for (let i = sigIdx - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === '') continue;
    if (HR_LINE_RE.test(lines[i])) insertAt = i;
    break;
  }
  lines.splice(insertAt, 0, `*Обновлено: ${ru}*`, '');
  return lines.join('\n');
}

/* ════════════════════════════════════════════════════════════════════════
 * Part 2 — JSON-LD (Article + FAQPage)
 * ═══════════════════════════════════════════════════════════════════════ */

/** Marker attribute: identifies OUR schema script for idempotent re-attach. */
const JSONLD_SCRIPT_OPEN = '<script type="application/ld+json" data-generaptor="article-schema">';
const JSONLD_SCRIPT_RE =
  /<script type="application\/ld\+json" data-generaptor="article-schema">[\s\S]*?<\/script>/g;

/**
 * Date → ISO 'YYYY-MM-DD' (schema.org expects ISO 8601 dates). Local
 * components, shared convention with formatRuDate above. Invalid → ''.
 *
 * @param {Date|string} value
 * @returns {string}
 */
function toIsoDate(value) {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Plain text of answer lines: fences dropped, links → anchors, md stripped. */
function plainTextOfLines(lines) {
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push(line);
  }
  return out
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+/gm, '')
    .replace(/[|`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the FAQ Q/A pairs from the FINAL article markdown (single source of
 * truth: the rendered «10 необычных вопросов» section, NOT the dormant
 * seo-reviewer contract field faqSchemaRu — rationale: see the module header
 * above).
 *
 * Detection reuses POSTCHECK_FAQ_HEADING_RE (the single FAQ-section detector
 * shared with the postcheck and the post-processor); questions are H3
 * headings inside the first FAQ section (the current pipeline format; the
 * legacy bold format is intentionally ignored — it no longer exists in the
 * pipeline output). Answers are whitespace-collapsed plain text.
 *
 * @param {string} markdown
 * @returns {{question: string, answer: string}[]} entries with BOTH fields
 *   non-empty (a schema.org Question without acceptedAnswer is invalid).
 */
export function extractFaqEntries(markdown) {
  if (typeof markdown !== 'string' || !markdown) return [];
  const lines = markdown.split('\n');

  // Locate the first FAQ H2 outside code fences; H3s inside it are questions.
  // Q/A zone terminators (checked BEFORE the heading gate — the meta tail is
  // plain non-heading lines): next H2, the signature block (marker or its
  // horizontal rule) or the P1b updated-date line — the meta tail must never
  // leak into the last machine answer.
  const entries = [];
  let inFence = false;
  let faqStart = -1;
  let faqEnd = lines.length;
  const h3s = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (
      faqStart !== -1 &&
      (line.trim().startsWith(SIGNATURE_MARKER) || UPDATED_LINE_RE.test(line) || HR_LINE_RE.test(line))
    ) {
      faqEnd = i;
      break;
    }
    const m = ATX_HEADING_RE.exec(line);
    if (!m || !m[2].trim()) continue;
    const level = m[1].length;
    if (faqStart === -1) {
      if (level === 2 && POSTCHECK_FAQ_HEADING_RE.test(m[2])) faqStart = i;
      continue;
    }
    if (level <= 2) {
      faqEnd = i;
      break;
    }
    if (level === 3) h3s.push({ question: m[2].trim(), line: i });
  }
  if (faqStart === -1) return [];

  for (let q = 0; q < h3s.length; q += 1) {
    const from = h3s[q].line + 1;
    const to = q + 1 < h3s.length ? h3s[q + 1].line : faqEnd;
    const answer = plainTextOfLines(lines.slice(from, Math.min(to, lines.length)));
    if (h3s[q].question && answer) entries.push({ question: h3s[q].question, answer });
  }
  return entries;
}

/**
 * Build the JSON-LD script for the published article.
 *
 * Shape: one <script type="application/ld+json"> carrying a @graph with
 *   - Article: headline, datePublished, dateModified, inLanguage 'ru',
 *     author Person{name, jobTitle} + affiliation Organization — the author
 *     node exists ONLY in specialist mode (no ghost organization author);
 *   - FAQPage: mainEntity from the article's FAQ questions/answers; the node
 *     is OMITTED entirely when the article has no FAQ.
 *
 * Deterministic: object literals fix the key order (JSON.stringify keeps
 * string-key insertion order), no clock reads, `</` is escaped as `<\/`
 * inside the payload so RU strings can never close the script tag early.
 *
 * @param {{articleId?: string, headline?: string, datePublished?: Date|string,
 *          dateModified?: Date|string, specialist?: {fullName?: string,
 *          position?: string}|null, siteName?: string,
 *          faq?: {question: string, answer: string}[]}} input
 * @returns {string} full '<script …>…</script>' tag, or '' when the required
 *   headline is empty (no broken schema is ever emitted).
 */
export function buildArticleJsonLd(input) {
  const headline = typeof input?.headline === 'string' ? input.headline.trim() : '';
  if (!headline) return '';

  const articleId = typeof input?.articleId === 'string' ? input.articleId.trim() : '';

  const article = { '@type': 'Article' };
  if (articleId) article['@id'] = `urn:generaptor:article:${articleId}#article`;
  article.headline = headline;
  const published = toIsoDate(input?.datePublished);
  if (published) article.datePublished = published;
  const modified = toIsoDate(input?.dateModified);
  if (modified) article.dateModified = modified;
  article.inLanguage = 'ru';

  // Author ONLY in specialist mode — the same source of truth as the visible
  // signature (specialist.fullName + position); affiliation = company name.
  const specialist = input?.specialist || null;
  const fullName = typeof specialist?.fullName === 'string' ? specialist.fullName.trim() : '';
  if (fullName) {
    const person = { '@type': 'Person', name: fullName };
    const position = typeof specialist?.position === 'string' ? specialist.position.trim() : '';
    if (position) person.jobTitle = position;
    // Нейтральный ключ siteName (воркер передаёт его) — имя компании.
    const companyName = typeof input?.siteName === 'string' ? input.siteName.trim() : '';
    if (companyName) person.affiliation = { '@type': 'Organization', name: companyName };
    article.author = person;
  }

  const graph = [article];
  const faq = Array.isArray(input?.faq) ? input.faq : [];
  const mainEntity = faq
    .filter((e) => typeof e?.question === 'string' && e.question.trim() && typeof e?.answer === 'string' && e.answer.trim())
    .map((e) => ({
      '@type': 'Question',
      name: e.question.trim(),
      acceptedAnswer: { '@type': 'Answer', text: e.answer.trim() },
    }));
  if (mainEntity.length) {
    graph.push({ '@type': 'FAQPage', mainEntity });
  }

  const payload = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
    /<\//g,
    '<\\/'
  );
  return `${JSONLD_SCRIPT_OPEN}${payload}</script>`;
}

/**
 * Attach the JSON-LD script to the rendered article HTML (idempotent).
 *
 * The ONLY delivery seam: called by the worker AFTER the postcheck input is
 * assembled (postcheck blindness) and BEFORE the ArticleVersion row is
 * persisted, so the stored contentHtml carries the structured data for every
 * consumer (API export, future site render). contentText/characterCount are
 * computed by the caller BEFORE this call and never see the script.
 *
 * Idempotency: previously attached schema scripts (same data-generaptor marker)
 * are stripped first — re-saving an article replaces stale markup instead of
 * stacking a second script.
 *
 * @param {string} html sanitized article HTML (renderMarkdownToHtml output)
 * @param {string} script buildArticleJsonLd() output
 * @returns {string} '' for empty input, else html + '\n' + script
 */
export function attachArticleJsonLd(html, script) {
  const safeHtml = typeof html === 'string' ? html : '';
  if (!safeHtml.trim()) return '';
  const safeScript = typeof script === 'string' ? script.trim() : '';
  if (!safeScript) return safeHtml;

  const base = safeHtml.replace(JSONLD_SCRIPT_RE, '').replace(/\s+$/, '');
  return `${base}\n${safeScript}`;
}
