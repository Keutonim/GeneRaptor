/**
 * P2-2: deterministic objection-section guards + form/button
 * recommendation block. Pure lib: no LLM, no Prisma,
 * no I/O, no text mutation. Single import — findForbiddenPromises from
 * article-postcheck.mjs (P1a): the forbidden-promise registry has ONE source,
 * no lexicon copy lives here.
 *
 * Import direction (important, no cycles):
 *   objection-block → article-postcheck (P1a lexicon).
 *   article-postcheck and internal-linker do NOT import this module — they
 *   keep their own 1-line copies of the «возражени|миф» stem with a sync note
 *   (precedent: AI_PHRASE_RES copy in postcheck; FAQ detector in linker).
 *
 * Consumers: tests/unit/objection-block.test.mjs (this contract),
 * article-post-processor.mjs (injectFormRecommendationBlock — B→I handoff),
 * the worker (generation stage) and KNOWLEDGE docs.
 */

import { findForbiddenPromises } from './article-postcheck.mjs';

/* ── Objection section detection (heading stem) ───────────────────────── */

/**
 * Stems «возражени» (возражения/возражений/возражениям…) and «миф»
 * (миф/мифы/мифов…) at word START: left \p{L} guard (NOT \b — it does not
 * work for Cyrillic; internal-linker convention). «Превозражения…» never
 * matches. Product strings around it stay RU (headings are RU).
 */
export const OBJECTION_HEADING_STEM_RE = /(?<![\p{L}])(?:возражени|миф)/iu;

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;

/**
 * Whether the document has an objection-section heading (ATX, outside code
 * fences). Idempotency guard (hasUnusualFaqSection pattern): ANY heading
 * level counts — an author H3/H1 leak also means "already present".
 * @param {string} markdown
 * @returns {boolean}
 */
export function hasObjectionSection(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return false;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_HEADING_RE.exec(line);
    if (m && m[2].trim() && OBJECTION_HEADING_STEM_RE.test(m[2])) return true;
  }
  return false;
}

/**
 * Validity of the FIRST objection H2 section (deterministic P2-2 guard):
 *   - section found by heading stem (H2, outside code fences);
 *   - ≥2 H3 items in question form (heading text ends with «?»);
 *   - no forbidden promises/pseudoscience inside the section (P1a lexicon,
 *     findForbiddenPromises; the negated professional-voice form «не может
 *     гарантировать» is suppressed by the detector itself — legit disclaimer).
 *
 * @param {string} markdown
 * @returns {{ valid: boolean, reason: 'ok'|'not-found'|'too-few-questions'|'promise-lexicon',
 *            questionItems: number, promiseHits: Array, sectionHeading: string|null }}
 */
export function objectionSectionValid(markdown) {
  const base = { questionItems: 0, promiseHits: [], sectionHeading: null };
  if (typeof markdown !== 'string' || !markdown) {
    return { valid: false, reason: 'not-found', ...base };
  }
  const lines = markdown.split('\n');

  // First objection H2 section: body runs until the next heading of level ≤2.
  let inFence = false;
  let secStart = -1;
  let secEnd = lines.length;
  let heading = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_HEADING_RE.exec(line);
    if (!m || !m[2].trim()) continue;
    if (secStart === -1) {
      if (m[1].length === 2 && OBJECTION_HEADING_STEM_RE.test(m[2])) {
        secStart = i;
        heading = m[2].trim();
      }
    } else if (m[1].length <= 2) {
      secEnd = i;
      break;
    }
  }
  if (secStart === -1) return { valid: false, reason: 'not-found', ...base };

  const sectionLines = lines.slice(secStart, secEnd);
  let questionItems = 0;
  inFence = false;
  for (const line of sectionLines) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_HEADING_RE.exec(line);
    if (m && m[1].length === 3 && m[2].trim().endsWith('?')) questionItems += 1;
  }
  if (questionItems < 2) {
    return { valid: false, reason: 'too-few-questions', questionItems, promiseHits: [], sectionHeading: heading };
  }
  // P1a lexicon check — INSIDE the section only (a promise in a neighbor
  // section is BODY-NO-PROMISES' business, not objection-section validity).
  const promiseHits = findForbiddenPromises(sectionLines.join('\n'));
  if (promiseHits.length) {
    return { valid: false, reason: 'promise-lexicon', questionItems, promiseHits, sectionHeading: heading };
  }
  return { valid: true, reason: 'ok', questionItems, promiseHits: [], sectionHeading: heading };
}

/* ── Deterministic «Как записаться» block (form/button) ───────────────── */

// Two heading variants (risk R2 — not templated; parity with
// EXPERTS_BLOCK_HEADING_TEMPLATES of the post-processor). Detection below
// covers BOTH variants — idempotency.
const FORM_REC_HEADING_TEMPLATES = [
  () => 'Как записаться на консультацию',
  () => 'Как записаться на приём',
];

/** Block detection by the «как записаться…» heading stem (both variants). */
export const FORM_REC_HEADING_STEM_RE = /^как\s+записаться/iu;

/**
 * Whether a form/button block is already present (idempotency guard,
 * hasUnusualFaqSection pattern): any ATX heading outside code fences with the
 * «как записаться» stem — an injected block OR an author leak both count as
 * "already present".
 * @param {string} markdown
 * @returns {boolean}
 */
export function hasFormRecommendationBlock(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return false;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_HEADING_RE.exec(line);
    if (m && m[2].trim() && FORM_REC_HEADING_STEM_RE.test(m[2])) return true;
  }
  return false;
}

/** Deterministic hash of a seed string (heading rotation from articleId). */
function seedHash(seed) {
  const s = String(seed ?? '');
  if (!s) return 0;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Deterministic appointment-booking recommendation block: how and
 * where to book + advice on button/lead-form placement on the page. Pure
 * markdown (no HTML), the P1a lexicon is not touched (no result promises),
 * the company name keeps its original form (not inflected).
 *
 * @param {string} companyName company name ('' → impersonal wording)
 * @param {string|number} [seedId] articleId — heading rotation (deterministic)
 * @returns {{ markdown: string, heading: string }}
 */
export function buildFormRecommendationBlock(companyName, seedId = '') {
  const brand = typeof companyName === 'string' ? companyName.trim() : '';
  const heading =
    FORM_REC_HEADING_TEMPLATES[seedHash(`formrec:${seedId ?? ''}`) % FORM_REC_HEADING_TEMPLATES.length]();
  const where = brand ? `в компанию ${brand}` : 'в нашу компанию';
  const phoneTail = brand ? `компании ${brand}` : 'компании';
  const markdown = [
    `## ${heading}`,
    '',
    `Записаться на приём ${where} можно через форму обратной связи на сайте: менеджер перезвонит, уточнит удобное время и ответит на организационные вопросы. Второй способ — телефон компании ${phoneTail}.`,
    '',
    'Рекомендуемое размещение кнопки записи и формы заявки на странице статьи — сразу после этого блока и в закреплённой шапке страницы: читатель принимает решение о записи ближе к концу материала, форма рядом снижает лишние шаги.',
    '',
    'План работ и их объём специалист определяет на консультации после уточнения задачи; консультант подскажет стоимость и подготовку к первому обращению.',
    '',
  ].join('\n');
  return { markdown, heading };
}
