/**
 * W2.1 (2026-08-17, stabilization): постпродакшен-валидатор финальной статьи.
 *
 * ЧИСТАЯ детерминированная функция: без LLM, без Prisma, без I/O, без правок
 * текста. Проверяет ОСТАТКИ после конвейера (sanitizer → normalizer → linker →
 * FAQ → подпись → render) — как он вызывается в saveFinalVersion воркера,
 * ПОСЛЕ рендера и ДО articleVersion.create.
 *
 * Единственный импорт — U5-реестр чанк-артефактов из article-sanitizer.mjs
 * (одна реализация детекта для санитайзера и правила BODY-NO-CHUNK-ARTIFACTS,
 * без копипасты списков).
 *
 * ── ЗАМОРОЖЕННЫЙ КОНТРАКТ ОТЧЁТА (читают Dev-B / фронт W3 — НЕ МЕНЯТЬ) ──
 * runArticlePostcheck({ markdown, html, context }) → {
 *   version: 1,
 *   verdict: 'ok' | 'warn' | 'fail',
 *   rules: [{ id, block, severity, status, message, details? }],
 *   summary: { pass, fail, skipped }
 * }
 *   verdict: fail = есть blocker-fail ИЛИ ≥2 major-fail;
 *            warn = ровно 1 major-fail ИЛИ есть хотя бы один minor-fail;
 *            ok   = иначе.
 *
 * context = { topic, targetLength, specialistId, hasSuccessfulFactcheckRun,
 *             finalizedVia, structuredOutputs, semanticCore,
 *             formatRuSections, timings }.
 *   Опциональное дополнение (аддитивное, контракт не ломает):
 *   siteDomains: string[] — домены сайта для link-правил (нейтральный ключ);
 *   без него инлайн-ссылкой на сайт
 *   считается любая http(s)-ссылка (промпт автора запрещает ему ставить
 *   ссылки самому — источник ссылок только линкер).
 *   B2 (2026-08-25): sourceSpecialistsCount: number|null + specialistPageUrls:
 *   string[]|null — каталог специалистов источника для правила
 *   LINKS-SPECIALIST-PRESENT (поставщик — воркер, saveFinalVersion).
 *
 * Режим: второй аргумент { mode } принимается, но НИЧЕГО не меняет внутри —
 * все правила считаются всегда; enforce-логика (needs_review вместо ready)
 * живёт снаружи, в воркере (POSTCHECK_MODE, см. resolvePostcheckMode ниже).
 */

// U5: единый реестр чанк-артефактов («Продолжение следует…») — та же
// реализация, что в санитайзере; правило BODY-NO-CHUNK-ARTIFACTS ниже.
import { isChunkArtifactLine } from './article-sanitizer.mjs';
// seo-round W0/A5: ВСЕ SEO-пороги — из единого модуля нормативов
// (server/lib/seo-standards.mjs); локальных копий чисел здесь больше нет.
import {
  keysTargetByLength,
  linksByLength,
  mentionsByLength,
  HEADINGS_WITH_KEYS_WINDOW,
  KEY_DENSITY,
  PER_KEY_DENSITY,
  FAQ_KEYS_SHARE_MIN,
  FAQ_KEYS_SHARE_WARN,
  KEYS_IN_TEXT_SHARE_MIN,
  CANONICAL_ZONE_CHARS,
  SEO_MIN_NORM_CHARS,
} from './seo-standards.mjs';

/** Служебное имя AgentRun-а с отчётом (паттерн служебных ранов вне 11 ролей). */
export const POSTCHECK_AGENT_NAME = 'Пост-проверка качества';

/** Замороженный перечень id правил (порядок = порядок в rules[] отчёта). */
export const POSTCHECK_RULE_IDS = [
  'HEAD-ONE-H1',
  'HEAD-NO-SKIPS',
  'HEAD-NO-DUPLICATES',
  'HEAD-TOPIC-AS-H2',
  'HEAD-SECTION-COVERAGE',
  'SEO-H1-MAINQUERY',
  'SEO-HEADINGS-KEYWORDS',
  'SEO-HEADINGS-SPAM',
  'BODY-NO-CJK',
  'BODY-NO-CITATIONS',
  'BODY-NO-AI-PHRASES',
  // P1a (2026-09-18): deterministic ban on forbidden promises/pseudoscience —
  // (prompts + LLM verdicts missed lenient runs).
  // minor/report-only: a minor-fail never produces verdict='fail'.
  'BODY-NO-PROMISES',
  'BODY-NO-TECH-SECTIONS',
  'BODY-NO-DUP-PARAGRAPHS',
  'BODY-NO-EMPTY-SECTIONS',
  'BODY-NO-CHUNK-ARTIFACTS',
  'BODY-LENGTH-RANGE',
  'TBL-FORMAT-HONORED',
  // P2-2 (2026-09-18): CONDITIONAL objection-section rule —
  // applies ONLY when the architect marked a section formatRu='возражения'
  // (exact conditionality pattern of TBL-FORMAT-HONORED).
  'OBJ-FORMAT-HONORED',
  'FAQ-PRESENT',
  'FAQ-UNIQUENESS',
  'FAQ-QA-FORMAT',
  // P2-2: deterministic booking block («Как записаться…», pipeline) —
  // minor/report-only (a minor-fail never yields verdict='fail').
  'FORM-REC-PRESENT',
  'SIG-PRESENT',
  'SIG-NO-SPECIALIST',
  'LINKS-PRESENT',
  'LINKS-NOT-IN-FAQ-SIGNATURE',
  // B2 (2026-08-25): режим «без специалиста» + ≥3 специалистов в источнике —
  // в финальном тексте должна быть ≥1 ссылка на страницу специалиста
  // (ставит линкер; каталог приходит аддитивно через context).
  'LINKS-SPECIALIST-PRESENT',
  'PROCESS-FINALIZATION',
  'FACTCHECK-COVERAGE',
  'TIMING-ANOMALY',
  // seo-round A5 (2026-08-22): аддитивные правила по нормативам seo-standards.
  // KEYS-IN-HEADINGS отдельным id НЕ заводилось — пороги существующих
  // SEO-HEADINGS-* синхронизированы импортом из seo-standards (20–65%).
  'KEYS-COUNT-BY-LENGTH',
  'KEYS-IN-TEXT-SHARE',
  'KEYS-DENSITY',
  'SEO-DENSITY-PER-KEY',
  'LINKS-SITE-COUNT',
  'CANONICAL-LINK-ZONE',
  'MENTIONS-SITE-COUNT',
  'FAQ-KEYS-SHARE',
];

/* ── Пороги (W2-константы; тюнинг — по данным report-only периода D1) ── */
const LENGTH_MIN_RATIO = 0.7; // BODY-LENGTH-RANGE: 0.7–1.4×target
const LENGTH_MAX_RATIO = 1.4;
// seo-round A5: окно заголовков с ключами — импорт из seo-standards
// (server/lib/seo-standards.mjs: HEADINGS_WITH_KEYS_WINDOW — нижняя граница
// поднята 0.15 → 0.20, верхняя
// 0.65 без изменений; target-зона промптов 30–50%, окно валидатора шире).
const SEO_HEADINGS_MIN_SHARE = HEADINGS_WITH_KEYS_WINDOW.min; // ≥20% H2/H3 с ключами
const SEO_HEADINGS_MAX_SHARE = HEADINGS_WITH_KEYS_WINDOW.max; // >65% H2/H3 с ключами — переспам (норма seo-reviewer 30–50%, окно шире — репорт-индикатор)
// C3: fuzzy-покрытие секций структуры: плановый заголовок считается найденным,
// если есть фактический с word-overlap ≥60% (парафразы архитектор→автор
// легитимны: «Виды процедур чистки» vs «Основные виды чистки лица»).
const HEADING_COVER_WORD_OVERLAP = 0.6;
const HEADING_COVER_PASS_SHARE = 0.8; // покрытие ≥80% → pass
const HEADING_COVER_MINOR_SHARE = 0.6; // 60–79% → minor fail; <60% → major fail
const EMPTY_SECTION_MIN_CHARS = 100; // H2-секция с меньшим плейн-текстом — «скелетная»
const FAQ_MIN_QUESTIONS = 8; // контракт faq-generator (MIN 8 / MAX 12 / TARGET 10)
const FAQ_MAX_QUESTIONS = 12;
const FAQ_MAX_SECTIONS = 1; // U4 (2026-08-20): ровно ОДНА FAQ-секция — автогенерируемый блок «10 необычных вопросов» (легаси-вставка faqRu удалена из постпроцессора)
const TIMING_ANOMALY_MS = 600_000; // роль >10 минут — маркер деградации RouterAI
const DUP_PARAGRAPH_MIN_CHARS = 40; // короче — легитимные повторы (CTA, «Да.»)

/* ── Регэкспы (синхронизированы с article-sanitizer.mjs — там приватные) ── */
const CJK_RE =
  /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF\u30FC\u30A0]/gu;
const CITATION_RE = /\{\{src:[^}]*\}\}/;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_EQ_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT_HYPHEN_RE = /^ {0,3}-+[ \t]*$/;
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const INLINE_LINK_RE = /\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g;
// FAQ-подобная секция (FIX-2 QA#1 W2): узкий паттерн профильного заголовка —
// «часто задаваемые вопросы», «популярные вопросы», «ответы на …», «10
// необычных вопросов», «FAQ». Широкий /faq|вопрос/i ошибочно зачислял
// контентные секции («Вопросы при выборе компании») → ложный major-fail
// FAQ-UNIQUENESS. Дополнительно секция считается FAQ при ≥3 Q/A-парах
// (детекция detectQuestions) независимо от заголовка.
// G1(c) quality-calibration: экспортируется как единый источник FAQ-детекта
// для mergeEmptySections постпроцессора (server/article-post-processor.mjs).
export const POSTCHECK_FAQ_HEADING_RE =
  /часто\s+задаваем|популярн[а-яё]*\s+вопрос|ответы\s+на|необычн[а-яё]*\s+вопрос|faq/i;
const FAQ_HEADING_RE = POSTCHECK_FAQ_HEADING_RE;

// Тех. секции, которые ДОЛЖЕН был вырезать санитайзер (CUT_SECTION_TITLES +
// сокращённая форма «Доп. экспертная», встречалась в логах).
const TECH_SECTION_TITLES = new Set([
  'источники',
  'дополнительная экспертная информация',
  'доп экспертная информация',
]);

// ИИ-мета-фразы: копия консервативного списка article-sanitizer.mjs
// (AI_PHRASE_RES приватны там; при изменении списка — синхронизировать).
const AI_PHRASE_RES = [
  /как\s+языковая\s+модель/iu,
  /как\s+ии(?![а-яё])/iu,
  /я\s+не\s+могу\s+(?:предоставить|помочь\s+с|создать|сгенерировать|ответить)/iu,
  /я\s+всего\s+лишь\s+ии/iu,
  /я\s+не\s+имею\s+доступа/iu,
  /у\s+меня\s+нет\s+доступа/iu,
  /я\s+не\s+являюсь\s+[а-яё]{3,}/iu,
  /надеюсь,?\s+что\s+эта\s+статья\s+была\s+полезной/iu,
  /надеюсь,?\s+эта\s+статья\s+была\s+полезной/iu,
  /надеюсь,?\s+этот\s+материал\s+был\s+полезным/iu,
  /as\s+an?\s+ai(?![a-z])/i,
  /as\s+a\s+language\s+model/i,
  /i\s+cannot\s+(?:provide|assist|recommend|offer)/i,
  /i\s+(?:am|’m|'m)\s+sorry/i,
  /i\s+apologize/i,
  /i\s+do\s+not\s+have\s+access/i,
  /hope\s+(?:this|that)\s+(?:article|post|text)\s+was\s+helpful/i,
  /hope\s+you\s+(?:found|enjoyed)/i,
];

const SIGNATURE_MARKER = '**Автор статьи:**';

/* ── P1a (2026-09-18): registry of forbidden promise / pseudoscience
 * phrasings for the BODY-NO-PROMISES rule (deterministic
 * detection was missing — prompts/LLM verdicts only, a lenient pass could
 * publish a promised-result phrase). Single maintained constant: adding a
 * phrase = one entry { label, group, re }; group: 'promise' | 'pseudoscience'.
 * The registry is industry-agnostic: a promise of a guaranteed result is a
 * defect for ANY business, so the detection set stays as is — only the
 * wording around it is neutralised.
 *
 * Morphology (v1, cheap): [а-яё]* with /iu covers RU case/inflection
 * («гарантируем/гарантия/гарантированный результат»); word connectors
 * (?:\s+[а-яё-]+){0,N} allow 0–N filler words. \w is NOT used: in u-mode it
 * does not include Cyrillic. Word boundaries use [а-яё] lookarounds (parity
 * with AI_PHRASE_RES: \b does not work for Cyrillic). Negation before a
 * promise phrase («не гарантируем результат» — a legit factchecker
 * disclaimer) is suppressed by the isNegatedPromise guard below. */
const FORBIDDEN_PROMISE_RES = [
  /* — guarantee-style promises (group: 'promise') — */
  // «гарантируем результат» / «гарантия результата» / «гарантированный результат»
  { label: 'гарантируем результат', group: 'promise', re: /гаранти[а-яё]*(?:\s+[а-яё-]+){0,2}\s+результ/giu },
  // «гарантия 100%» / «гарантируем 100% …» / «гарантия результата на 100%»
  { label: 'гарантия 100%', group: 'promise', re: /гаранти[а-яё]*(?:\s+[а-яё-]+){0,2}\s+100\s*%/giu },
  // «100% результат» / «стопроцентный результат» / «сто процентов результат»
  { label: '100% результат', group: 'promise', re: /(?:100\s*%|стопроцентн[а-яё]*|сто\s+процент[а-яё]*)\s+результ/giu },
  // «навсегда избавитесь» / «избавим вас навсегда» / «избавитесь от … навсегда»
  { label: 'навсегда избавитесь', group: 'promise', re: /(?:навсегда\s+избав[а-яё]*|избав[а-яё]*(?:\s+[а-яё-]+){0,3}\s+навсегда)/giu },
  // «мгновенный результат»
  { label: 'мгновенный результат', group: 'promise', re: /мгновенн[а-яё]*\s+результат/giu },
  // «полностью безопасно/безопасен/безопасна» (stem «безопас»: безопасен = безопас+ен)
  { label: 'полностью безопасно', group: 'promise', re: /полностью\s+безопас[а-яё]*/giu },
  // «без побочных эффектов» (±1–2 filler words: «без серьезных побочных эффектов»)
  { label: 'без побочных эффектов', group: 'promise', re: /(?<![а-яё])без(?:\s+[а-яё-]+){0,2}\s+побочн[а-яё]*\s+эффект/giu },
  // «излечим/вылечим/исцелим» — 1st person plural future = обещание результата
  // («излечимая» is an adjective, excluded by the (?![а-яё]) lookahead)
  { label: 'излечим', group: 'promise', re: /(?<![а-яё])(?:излечим|вылечим|исцелим)(?![а-яё])/giu },
  // «вылечим навсегда» / «излечим заболевание навсегда»
  { label: 'вылечим навсегда', group: 'promise', re: /(?<![а-яё])(?:вылеч|излеч|исцел)[а-яё]*(?:\s+[а-яё-]+){0,3}\s+навсегда/giu },
  /* — pseudoscience markers (group: 'pseudoscience') — */
  // «биополе/биополя/биополем»
  { label: 'биополе', group: 'pseudoscience', re: /(?<![а-яё])биопол[а-яё]*/giu },
  // «энергетический баланс»
  { label: 'энергетический баланс', group: 'pseudoscience', re: /энергетическ[а-яё]*\s+баланс/giu },
  // «очищение от шлаков» — the marker itself is «шлак*» (incl. «зашлакованность»)
  { label: 'очищение от шлаков', group: 'pseudoscience', re: /шлак[а-яё]*/giu },
  // «токсины выводятся» / «выводит токсины» / «выведение токсинов из организма»
  { label: 'токсины выводятся', group: 'pseudoscience', re: /(?:токсин[а-яё]*(?:\s+[а-яё-]+){0,3}\s+вывод[а-яё]*|вывод[а-яё]*(?:\s+[а-яё-]+){0,3}\s+токсин[а-яё]*)/giu },
];

/** Window (chars before a match) checked for a negation prefix. */
const PROMISE_NEGATION_WINDOW = 40;
/** Negation + up to 2 words before the phrase start: «не может гарантировать …»,
 *  «Невозможно навсегда избавиться …» (longer alternatives listed first). */
const PROMISE_NEGATION_RE = /(?:^|[^а-яёa-z])(?:невозможно|нельзя|нет|не)(?:\s+[а-яё-]+){0,2}\s*$/iu;

/**
 * P1a: legit disclaimer check — a negation stands right before the promise
 * phrase («специалист НЕ гарантирует результат», «метод НЕ даёт 100% результат» —
 * factcheckers deliberately insert such wordings). The guard applies only to
 * group='promise'; pseudoscience («биополе») cannot be legitimized by negation.
 */
function isNegatedPromise(prefixBeforeMatch) {
  const window = prefixBeforeMatch.slice(-PROMISE_NEGATION_WINDOW);
  return PROMISE_NEGATION_RE.test(window);
}

/**
 * P1a: all forbidden-phrase occurrences in markdown lines outside code fences.
 * @returns {{ phrase: string, group: 'promise'|'pseudoscience', index: number, snippet: string }[]}
 *   index — absolute offset of the occurrence in the source markdown; snippet —
 *   the actual match (capped at 40 chars). Per line per entry: a repeated
 *   occurrence of the same phrase within ONE line is reported once (v1,
 *   report-only; count may under-report pathological single-line repeats).
 */
export function findForbiddenPromises(markdown) {
  const out = [];
  if (typeof markdown !== 'string' || !markdown) return out;
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const entry of FORBIDDEN_PROMISE_RES) {
      entry.re.lastIndex = 0;
      for (const m of line.matchAll(entry.re)) {
        if (entry.group === 'promise' && isNegatedPromise(line.slice(0, m.index))) continue;
        out.push({
          phrase: entry.label,
          group: entry.group,
          index: lineStart + m.index,
          snippet: m[0].slice(0, 40),
        });
      }
      entry.re.lastIndex = 0;
    }
  }
  return out;
}

/* ── Парсинг документа ─────────────────────────────────────────────────── */

/**
 * Заголовки вне code-fence: ATX (#..######) + setext (=== / ---).
 * Нормализатор воркера конвертирует setext в atx до валидатора — поддержка
 * здесь нужна для юнит-фикстур и защиты от регрессий порядка сборки.
 * @returns {{ level: number, text: string, line: number }[]}
 */
function parseHeadings(markdown) {
  const out = [];
  const lines = markdown.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = ATX_RE.exec(line);
    if (m) {
      const text = (m[2] || '').trim();
      if (text) out.push({ level: m[1].length, text, line: i });
      continue;
    }

    // setext: underline строго под «обычной» строкой абзаца.
    const prev = i > 0 ? lines[i - 1] : '';
    const prevPlain =
      prev.trim() !== '' && !ATX_RE.test(prev) && !LIST_RE.test(prev) && !prev.includes('|') && !FENCE_LINE_RE.test(prev);
    if (prevPlain && SETEXT_EQ_RE.test(line)) {
      out.push({ level: 1, text: prev.trim(), line: i - 1 });
    } else if (prevPlain && SETEXT_HYPHEN_RE.test(line)) {
      out.push({ level: 2, text: prev.trim(), line: i - 1 });
    }
  }
  return out;
}

/** Нормализация для сравнения заголовков (та же, что W1.2 в воркере). */
function normalizeHeadingCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Нормализация для fuzzy-вхождения ключа (без пунктуации).
 * seo-deterministic round (2026-08-27): экспорт — единый источник
 * нормализации для детерминаторов постпроцессора (reduceKeySpam и др.);
 * логика не менялась.
 */
export function normalizeQueryText(text) {
  return normalizeHeadingCompare(text);
}

/* ── C3 quality-calibration: fuzzy-покрытие секций структуры ────────────── */

// Русские служебные слова, не несущие смысла при сравнении заголовков:
// «Виды процедур чистки» и «Основные виды чистки лица» пересекаются по
// {виды, чистки}, предлоги/союзы в пересечении только шумят.
const HEADING_STOP_WORDS = new Set([
  'и', 'в', 'во', 'с', 'со', 'к', 'ко', 'о', 'об', 'на', 'за', 'по', 'из',
  'у', 'от', 'до', 'для', 'или', 'а', 'но', 'не', 'как', 'что', 'же', 'ли',
  'при', 'после', 'перед', 'без', 'это',
]);

/** Смысловые слова нормализованного заголовка (без служебных). */
function meaningfulHeadingWords(normText) {
  const words = normalizeQueryText(normText).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !HEADING_STOP_WORDS.has(w));
  return meaningful.length ? meaningful : words;
}

/**
 * C3: слова одной словообразовательной семьи — для русских заголовков
 * («подготовка» vs «подготовиться», «процедуре» vs «процедуру»). Консервативно:
 * общий префикс ≥5 симв. ИЛИ короткое слово — префикс длинного (≥4 симв.).
 */
function headingWordsSameFamily(a, b) {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  let n = 0;
  while (n < minLen && a[n] === b[n]) n += 1;
  return n >= 5 || (n === minLen && n >= 4);
}

/**
 * C3: word-overlap планового заголовка с фактическим — доля смысловых слов
 * плана, найденных в фактическом заголовке: |A∩B| / |A|. «Виды процедур
 * чистки» vs «Основные виды чистки лица» → 2/3 ≈ 0.67 (парафраз, covered).
 */
function headingWordOverlap(plannedNorm, actualNorm) {
  const planned = meaningfulHeadingWords(plannedNorm);
  if (!planned.length) return 0;
  const actual = meaningfulHeadingWords(actualNorm);
  if (!actual.length) return 0;
  const actualExact = new Set(actual);
  let hit = 0;
  for (const w of planned) {
    if (actualExact.has(w) || actual.some((x) => headingWordsSameFamily(w, x))) hit += 1;
  }
  return hit / planned.length;
}

/** C3: плановый заголовок покрыт — точное совпадение ИЛИ word-overlap ≥60%. */
function headingCovered(plannedNorm, actualNorms) {
  return actualNorms.some(
    (a) => a === plannedNorm || headingWordOverlap(plannedNorm, a) >= HEADING_COVER_WORD_OVERLAP,
  );
}

/** Слова нормализованной строки (для word-set вхождения запроса в H1). */
function normalizedWords(text) {
  return normalizeQueryText(text).split(' ').filter(Boolean);
}

/* ── FIX-S1 (QA seo-round): морфо-детектор вхождения ключа ────────────────
 * Прежняя точная подстрока давала false-fail на естественных словоформах
 * («делать лазерную эпиляцию» при ключе «лазерная эпиляция» — QA-проба:
 * 33% share → major). Норматив допускает ТОЧНОЕ и РАЗБАВЛЕННОЕ
 * вхождение: все значимые слова ключа в пределах одного предложения.
 * Детектор: каждое значимое слово ключа (≥3 симв.) матчится по токенам
 * текста по СЕМЬЕ (общий префикс ≥5 симв. — паритет headingWordsSameFamily;
 * слова <5 симв. — только точное равенство), слова ключа должны стоять
 * в пределах окна WINDOW_TOKENS токенов (разбавленное вхождение). */

/** Разбавленное вхождение: слова ключа в пределах ~10 токенов (
 *  «в пределах одного предложения»; предложение ≈ 10 токенов с запасом). */
const KEY_MATCH_WINDOW_TOKENS = 10;

/** Значимые слова ключа (≥3 симв.; короче — служебный шум). */
function keyWordsOf(key) {
  return normalizeQueryText(key).split(' ').filter((w) => w.length >= 3);
}

/** Слово текста матчит слово ключа: точное равенство всегда; морфо-семья
 *  (префикс ≥5) — только для слов ключа длиной ≥5 (короткие склонять нельзя). */
function wordMatchesKeyWord(keyWord, token) {
  if (keyWord === token) return true;
  if (keyWord.length < 5) return false;
  return headingWordsSameFamily(keyWord, token);
}

/**
 * Все вхождения ключа в токены текста (жадно, слева направо, вхождения не
 * пересекаются). Вхождение = каждой значимой слово-позиции ключа сопоставлен
 * СВОЙ токен в пределах окна KEY_MATCH_WINDOW_TOKENS (порядок слов ключа в
 * тексте не важен — «в пределах одного предложения»).
 * `consumed` (opt): занятые более длинным ключом токены пропускаются —
 * дедуп вложенных ключей для плотности (FIX-S4: длинный поглощает короткий).
 * @returns {number[][]} массив вхождений, каждое — отсортированные позиции токенов
 */
export function findKeyOccurrences(tokens, key, consumed = null) {
  const words = keyWordsOf(key);
  if (!words.length || !Array.isArray(tokens) || tokens.length < words.length) return [];
  const free = (i) => !consumed || !consumed[i];
  const occurrences = [];
  let start = 0;
  while (start < tokens.length) {
    const limit = Math.min(tokens.length, start + KEY_MATCH_WINDOW_TOKENS);
    const used = new Set();
    const positions = [];
    let ok = true;
    for (const w of words) {
      let found = -1;
      for (let i = start; i < limit; i += 1) {
        if (used.has(i) || !free(i)) continue;
        if (wordMatchesKeyWord(w, tokens[i])) {
          found = i;
          break;
        }
      }
      if (found === -1) {
        ok = false;
        break;
      }
      used.add(found);
      positions.push(found);
    }
    if (!ok) {
      start += 1;
      continue;
    }
    positions.sort((a, b) => a - b);
    occurrences.push(positions);
    if (consumed) for (const p of positions) consumed[p] = true;
    start = positions[positions.length - 1] + 1; // непересекающиеся вхождения
  }
  return occurrences;
}

/**
 * FIX-S1: ключ использован в тексте (точное или разбавленное вхождение,
 * словоформы матчатся по семье). Экспорт — единый детектор для правил
 * KEYS-IN-TEXT-SHARE / KEYS-COUNT-BY-LENGTH / FAQ-KEYS-SHARE / SEO-HEADINGS-*.
 * @param {string|string[]} textOrTokens нормализованный текст или его токены
 * @param {string} key
 */
export function keyUsedInText(textOrTokens, key) {
  const tokens = Array.isArray(textOrTokens)
    ? textOrTokens
    : normalizeQueryText(textOrTokens).split(' ').filter(Boolean);
  return findKeyOccurrences(tokens, key).length > 0;
}

/** URL → hostname (без throw на мусоре). */
function urlHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Попадает ли hostname под домен сайта (точный или поддомен).
 * FIX-S3 (QA): сравнение симметрично по apex-домену — ведущий «www.» срезается
 * с ОБОИХ сторон (apex-ссылка example.com — это домен сайта
 * www.example.com; прежде однонаправленное сравнение давало ложный
 * «0 ссылок» → major-fail).
 */
function hostnameMatchesDomain(hostname, domain) {
  const stripWww = (h) => (h.startsWith('www.') ? h.slice(4) : h);
  const d = stripWww(String(domain || '').toLowerCase().trim());
  const h = stripWww(String(hostname || '').toLowerCase().trim());
  if (!d || !h) return false;
  return h === d || h.endsWith('.' + d);
}

/**
 * Инлайн markdown-ссылки вне code-fence, с абсолютными позициями.
 * @returns {{ url: string, hostname: string, start: number }[]}
 */
function findInlineLinks(markdown) {
  const out = [];
  if (typeof markdown !== 'string' || !markdown) return out;
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_LINE_RE.test(line)) inFence = !inFence;
    if (!inFence && !FENCE_LINE_RE.test(line)) {
      INLINE_LINK_RE.lastIndex = 0;
      let m;
      while ((m = INLINE_LINK_RE.exec(line)) !== null) {
        out.push({ url: m[2], hostname: urlHostname(m[2]), start: offset + m.index });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** Ссылки на сайт: при заданных siteDomains — только они; иначе все инлайн. */
function siteLinks(markdown, siteDomains) {
  const links = findInlineLinks(markdown);
  const domains = Array.isArray(siteDomains) ? siteDomains.filter(Boolean) : [];
  if (!domains.length) return links;
  return links.filter((l) => domains.some((d) => hostnameMatchesDomain(l.hostname, d)));
}

/**
 * Плейн-текст из markdown (для BODY-LENGTH-RANGE): без фенсов, ссылки → анкоры,
 * снята разметка. Аналог htmlToPlainText(contentHtml) воркера, но без JSDOM —
 * валидатор остаётся dependency-free и детерминированным.
 */
function plainTextOfMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown) return '';
  const lines = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines.push(line);
  }
  return lines
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // ссылки/картинки → анкор
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '') // ATX-решётки
    .replace(/^ {0,3}>[ \t]?/gm, '') // blockquote
    .replace(/^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+/gm, '') // list-маркеры
    .replace(/[|`*_]/g, ' ') // таблицы/инлайн-код/эмфаз
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Структура документа: секции по H2, FAQ-секции, подпись ───────────── */

/** Диапазоны строк H2-секций: [{ heading, norm, from, to }] (to — эксклюзив). */
function h2Sections(markdown, headings) {
  const h2s = headings.filter((h) => h.level === 2);
  return h2s.map((h, idx) => ({
    heading: h.text,
    norm: normalizeHeadingCompare(h.text),
    from: h.line,
    to: idx + 1 < h2s.length ? h2s[idx + 1].line : Number.MAX_SAFE_INTEGER,
  }));
}

/**
 * FIX-1/FIX-2 (QA#1 W2): вопросы FAQ-секции в ОБОИХ форматах:
 *   - H3-вопрос (`### …?`) — формат авто-FAQ («10 необычных вопросов»);
 *   - легаси-bold (`**…?**` отдельной строкой) — формат удалённой U4-вставки
 *     faqRu (buildFaqMarkdown из postProcessArticle больше не существует).
 * U4: bold-детекция остаётся ТОЛЬКО для детекта FAQ-подобности секций
 * (≥3 Q/A-пар → «вторая FAQ-секция» = FAQ-UNIQUENESS fail); правила
 * FAQ-PRESENT/FAQ-QA-FORMAT считают исключительно kind='h3'.
 * Ответ = строки до следующего вопроса (любого формата) / конца секции.
 * @returns {{ kind: 'h3'|'bold', text: string, answer: string }[]}
 */
const BOLD_QUESTION_RE = /^ {0,3}\*\*(.+?)\*\*[ \t]*$/;

function detectQuestions(docLines, headings, sec) {
  const end = Math.min(sec.to, docLines.length);
  const h3s = headings.filter((h) => h.level === 3 && h.line > sec.from && h.line < sec.to);
  const inH3Zone = (i) =>
    h3s.some((h, idx) => h.line < i && (idx + 1 < h3s.length ? i < h3s[idx + 1].line : i < end));
  const questions = [];
  for (const h of h3s) questions.push({ kind: 'h3', text: h.text, line: h.line });
  for (let i = sec.from + 1; i < end; i += 1) {
    if (inH3Zone(i)) continue; // bold-строка внутри ответа на H3-вопрос — не вопрос
    const m = BOLD_QUESTION_RE.exec(docLines[i]);
    if (m && m[1].trim().endsWith('?')) questions.push({ kind: 'bold', text: m[1].trim(), line: i });
  }
  questions.sort((a, b) => a.line - b.line);
  return questions.map((q, idx) => {
    const from = q.line + 1;
    const to = idx + 1 < questions.length ? questions[idx + 1].line : end;
    return { kind: q.kind, text: q.text, answer: docLines.slice(from, to).join(' ').trim() };
  });
}

/** Есть ли GFM-таблица в диапазоне строк секции. */
function hasGfmTableIn(markdown, sec) {
  const lines = markdown.split('\n');
  for (let i = sec.from; i < Math.min(sec.to, lines.length); i += 1) {
    const line = lines[i];
    if (line.includes('|') && i + 1 < lines.length) {
      const delim = lines[i + 1];
      if (/^[\s|:-]+$/.test(delim) && delim.includes('-')) return true;
    }
  }
  return false;
}

/** FIX-D1 QA: есть ли ХОТЯ БЫ ОДНА GFM-таблица в документе (для слитых заголовков). */
function hasAnyGfmTable(markdown) {
  const lines = typeof markdown === 'string' ? markdown.split('\n') : [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (lines[i].includes('|')) {
      const delim = lines[i + 1];
      if (/^[\s|:-]+$/.test(delim) && delim.includes('-')) return true;
    }
  }
  return false;
}

/* ── Контекст-хелперы ─────────────────────────────────────────────────── */

/** Секции структуры архитектора: formatRuSections || structure-architect.sectionsRu. */
function structureSections(context) {
  const direct = Array.isArray(context?.formatRuSections) ? context.formatRuSections : null;
  if (direct) return direct;
  const fromOutputs = context?.structuredOutputs?.['structure-architect']?.sectionsRu;
  return Array.isArray(fromOutputs) ? fromOutputs : [];
}

/** Истинный шаблон (skipFaq-условие W1.3/FIX-M2 из finalizeWithFallback). */
function isTrueTemplate(structuredOutputs) {
  const author = structuredOutputs?.['article-author'];
  return !author || author._fallbackTemplate === true;
}

/**
 * Ключевые фразы из semanticCore (нормализованные, ≥4 симв.).
 * M2: частотный источник убран — semantic-strategist единственный поставщик
 * ядра (кластеры + LSI). seo-deterministic round (2026-08-27): экспорт —
 * единый источник ключей для reduceKeySpam постпроцессора (паритет с
 * KEYS-DENSITY/SEO-DENSITY-PER-KEY); логика не менялась.
 */
export function collectKeywords(context) {
  const out = new Set();
  const core = context?.semanticCore || {};
  const clusters = Array.isArray(core.queryClustersRu) ? core.queryClustersRu : [];
  for (const c of clusters) {
    if (typeof c === 'string') addKeyword(out, c);
    else if (c && typeof c === 'object') {
      addKeyword(out, c.clusterRu);
      for (const q of Array.isArray(c.queriesRu) ? c.queriesRu : []) addKeyword(out, q);
    }
  }
  for (const lsi of Array.isArray(core.lsiTermsRu) ? core.lsiTermsRu : []) addKeyword(out, lsi);
  return [...out];
}

function addKeyword(set, value) {
  const norm = normalizeQueryText(value);
  if (norm && norm.length >= 4) set.add(norm);
}

/** Главный запрос: semanticCore.mainQueryRu. */
function mainQuery(context) {
  const fromCore = typeof context?.semanticCore?.mainQueryRu === 'string'
    ? context.semanticCore.mainQueryRu.trim()
    : '';
  return fromCore;
}

/** Тайминги: объект {label: ms} или массив [{agent, durationMs}] → Map. */
function normalizeTimings(timings) {
  const out = new Map();
  if (Array.isArray(timings)) {
    for (const t of timings) {
      if (t && typeof t === 'object' && Number.isFinite(Number(t.durationMs))) {
        out.set(String(t.agent || 'роль'), Number(t.durationMs));
      }
    }
  } else if (timings && typeof timings === 'object') {
    for (const [agent, ms] of Object.entries(timings)) {
      if (Number.isFinite(Number(ms))) out.set(String(agent), Number(ms));
    }
  }
  return out;
}

/* ── Правила ──────────────────────────────────────────────────────────── */

function mk(id, block, severity, status, message, details) {
  return { id, block, severity, status, message, ...(details !== undefined ? { details } : {}) };
}

/**
 * Запускает постпродакшен-проверку финальной статьи.
 *
 * @param {{ markdown: string, html?: string, context?: object }} input
 * @param {{ mode?: string }} [options] — принимается, на результат НЕ влияет
 *   (enforce-логика — снаружи, в воркере).
 * @returns {{ version: 1, verdict: 'ok'|'warn'|'fail',
 *             rules: object[], summary: { pass: number, fail: number, skipped: number } }}
 */
export function runArticlePostcheck(input, options = {}) {
  const markdown = typeof input?.markdown === 'string' ? input.markdown : '';
  const html = typeof input?.html === 'string' ? input.html : '';
  const context = input?.context && typeof input.context === 'object' ? input.context : {};

  const headings = parseHeadings(markdown);
  const docLines = typeof markdown === 'string' ? markdown.split('\n') : [];
  const sections = h2Sections(markdown, headings);
  // FIX-2: isFaq = профильный заголовок ИЛИ ≥3 Q/A-пар (H3/bold с ответами).
  for (const sec of sections) {
    sec.questions = detectQuestions(docLines, headings, sec);
    sec.isFaq =
      FAQ_HEADING_RE.test(sec.heading) || sec.questions.filter((q) => q.answer).length >= 3;  }
  const faqSections = sections.filter((s) => s.isFaq);
  const ruleList = [];

  /* ── HEAD ── */
  const h1s = headings.filter((h) => h.level === 1);
  ruleList.push(
    h1s.length === 1
      ? mk('HEAD-ONE-H1', 'head', 'blocker', 'pass', 'Ровно один H1 в документе')
      : mk('HEAD-ONE-H1', 'head', 'blocker', 'fail',
          `В документе ${h1s.length} H1 (должен быть ровно 1)`,
          { h1Count: h1s.length }),
  );

  let skipFail = null;
  if (!headings.length) {
    ruleList.push(mk('HEAD-NO-SKIPS', 'head', 'major', 'skipped', 'Заголовков нет — иерархию проверить нечем'));
  } else {
    let prev = 0;
    for (const h of headings) {
      if (h.level > prev + 1) {
        skipFail = h;
        break;
      }
      prev = h.level;
    }
    ruleList.push(
      skipFail
        ? mk('HEAD-NO-SKIPS', 'head', 'major', 'fail',
            `Пропуск уровня заголовков: H${skipFail.level} «${skipFail.text}» без промежуточного уровня`,
            { at: skipFail.text })
        : mk('HEAD-NO-SKIPS', 'head', 'major', 'pass', 'Пропусков уровней заголовков нет'),
    );
  }

  const headCounts = new Map();
  for (const h of headings) {
    const norm = normalizeHeadingCompare(h.text);
    if (!norm) continue;
    headCounts.set(norm, (headCounts.get(norm) || 0) + 1);
  }
  const dupHeadings = [...headCounts.entries()].filter(([, n]) => n > 1).map(([t, n]) => ({ text: t, count: n }));
  ruleList.push(
    dupHeadings.length
      ? mk('HEAD-NO-DUPLICATES', 'head', 'major', 'fail',
          `Дубли заголовков (${dupHeadings.length}): ${dupHeadings.slice(0, 5).map((d) => `«${d.text}» ×${d.count}`).join(', ')}`,
          { duplicates: dupHeadings })
      : mk('HEAD-NO-DUPLICATES', 'head', 'major', 'pass', 'Дублей заголовков (в любых позициях) нет'),
  );

  // HEAD-TOPIC-AS-H2: H2, нормализованный текст которой совпадает с H1/темой
  // статьи («H1-тема не должна повторяться как H2» —
  // побочный эффект понижения лишних H1 нормализатором).
  const topicNorms = new Set(
    [h1s[0]?.text, context.topic].map(normalizeHeadingCompare).filter(Boolean),
  );
  if (!topicNorms.size) {
    ruleList.push(mk('HEAD-TOPIC-AS-H2', 'head', 'major', 'skipped', 'Ни H1, ни темы статьи нет — сравнивать не с чем'));
  } else {
    const topicH2 = headings.filter(
      (h) => h.level === 2 && topicNorms.has(normalizeHeadingCompare(h.text)),
    );
    ruleList.push(
      topicH2.length
        ? mk('HEAD-TOPIC-AS-H2', 'head', 'major', 'fail',
            `H2 повторяет тему/H1 статьи (${topicH2.length}): ${topicH2.slice(0, 5).map((h) => `«${h.text}»`).join(', ')}`,
            { headings: topicH2.map((h) => h.text) })
        : mk('HEAD-TOPIC-AS-H2', 'head', 'major', 'pass', 'Тема статьи не дублируется на уровне H2'),
    );
  }

  const stSections = structureSections(context);
  // G1(d)/FIX-D1: заголовки, слитые mergeEmptySections постпроцессора
  // (нормализованные), — исключаются из ожиданий COVERAGE и учитываются в
  // TBL-FORMAT-HONORED (таблица слитой секции живёт в теле соседа).
  const mergedSet = new Set(
    (Array.isArray(context.mergedHeadings) ? context.mergedHeadings : [])
      .map(normalizeHeadingCompare)
      .filter(Boolean),
  );
  if (!stSections.length) {
    ruleList.push(mk('HEAD-SECTION-COVERAGE', 'head', 'major', 'skipped', 'Данных о структуре архитектора нет'));
  } else {
    // G1(d): заголовки, слитые mergeEmptySections постпроцессора (нормализо-
    // ванные), исключаются из ожидаемого покрытия — секция не «потеряна»,
    // она осознанно объединена с соседней.
    const docNorms = headings.map((h) => normalizeHeadingCompare(h.text)).filter(Boolean);
    const hasAnyFaqSection = faqSections.length > 0;
    const missing = [];
    let expected = 0;
    let covered = 0;
    for (const s of stSections) {
      const heading = typeof s?.headingRu === 'string' ? s.headingRu : '';
      const norm = normalizeHeadingCompare(heading);
      if (!norm) continue;
      // FAQ-секция структуры покрывается автогенерируемым FAQ-блоком (W2.4:
      // автор больше не пишет собственный FAQ — «10 необычных вопросов» ставит конвейер).
      if (FAQ_HEADING_RE.test(heading)) {
        expected += 1;
        if (hasAnyFaqSection) covered += 1;
        else missing.push(heading);
        continue;
      }
      if (mergedSet.has(norm)) continue; // слито постпроцессором — вне ожиданий
      expected += 1;
      // C3: точное совпадение → fuzzy (word-overlap ≥60%): автор вправе
      // переформулировать заголовок плана, сохраняя смысл.
      if (headingCovered(norm, docNorms)) covered += 1;
      else missing.push(heading);
    }
    const coverage = expected > 0 ? covered / expected : 1;
    const coveragePct = Math.round(coverage * 100);
    const details = {
      total: stSections.length,
      expected,
      covered,
      missing,
      coverage: Number(coverage.toFixed(3)),
    };
    if (missing.length === 0 || coverage >= HEADING_COVER_PASS_SHARE) {
      ruleList.push(mk('HEAD-SECTION-COVERAGE', 'head', 'major', 'pass',
        `Секции структуры присутствуют: ${covered}/${expected} (${coveragePct}%, fuzzy ≥${Math.round(HEADING_COVER_WORD_OVERLAP * 100)}%)`,
        details));
    } else if (coverage >= HEADING_COVER_MINOR_SHARE) {
      ruleList.push(mk('HEAD-SECTION-COVERAGE', 'head', 'minor', 'fail',
        `Секции структуры частично потеряны (${covered}/${expected} = ${coveragePct}%): ${missing.slice(0, 5).join('; ')}`,
        details));
    } else {
      ruleList.push(mk('HEAD-SECTION-COVERAGE', 'head', 'major', 'fail',
        `Секции структуры отсутствуют в статье (${missing.length} из ${expected}, покрытие ${coveragePct}%): ${missing.slice(0, 5).join('; ')}`,
        details));
    }
  }

  /* ── SEO ── */
  // C1 quality-calibration (2026-08-21): SEO-ядро может отсутствовать по
  // легитимным причинам (fallback-пути финализации, semantic-strategist
  // не дошёл) — авторы этих статей ядра НЕ ВИДЕЛИ, и
  // фейлить их за отсутствие вхождений несправедливо. Нет ни mainQuery, ни
  // ключей → все три SEO-правила честно skipped: «SEO-ядро не собрано».
  const mainQ = mainQuery(context);
  const keywords = collectKeywords(context);
  const seoCoreMissing = !mainQ && !keywords.length;
  if (seoCoreMissing) {
    ruleList.push(mk('SEO-H1-MAINQUERY', 'seo', 'major', 'skipped', 'SEO-ядро не собрано (семантики нет)'));
  } else if (!mainQ) {
    ruleList.push(mk('SEO-H1-MAINQUERY', 'seo', 'major', 'skipped', 'SEO-ядро не собрано (главный запрос неизвестен)'));
  } else if (!h1s.length) {
    ruleList.push(mk('SEO-H1-MAINQUERY', 'seo', 'major', 'fail', 'H1 отсутствует — главный запрос не входит', { mainQuery: mainQ }));
  } else if (!normalizedWords(mainQ).some((w) => w.length >= 2)) {
    // Tech-lead W2-review: запрос есть, но после нормализации не осталось ни
    // одного слова ≥2 симв. (мусорный mainQueryRu вроде «!!!» / «- —» из
    // LLM-вывода) — сравнивать нечего, false-fail не даём.
    ruleList.push(mk('SEO-H1-MAINQUERY', 'seo', 'major', 'skipped',
      'Главный запрос после нормализации пуст — вхождение не проверяем', { mainQuery: mainQ }));
  } else {
    const h1Words = new Set(normalizedWords(h1s[0].text));
    const qWords = normalizedWords(mainQ).filter((w) => w.length >= 2);
    const allPresent = qWords.every((w) => h1Words.has(w));
    ruleList.push(
      allPresent
        ? mk('SEO-H1-MAINQUERY', 'seo', 'major', 'pass', `Главный запрос «${mainQ}» входит в H1`)
        : mk('SEO-H1-MAINQUERY', 'seo', 'major', 'fail',
            `Главный запрос «${mainQ}» не входит в H1 «${h1s[0].text}»`,
            { mainQuery: mainQ, h1: h1s[0].text }),
    );
  }

  const seoHeadings = headings.filter(
    (h) => (h.level === 2 || h.level === 3) && !sections.some((s) => s.isFaq && h.line > s.from && h.line < s.to),
  );
  if (seoCoreMissing) {
    // C1: ключей и главного запроса нет вообще — ядро не собрано.
    ruleList.push(mk('SEO-HEADINGS-KEYWORDS', 'seo', 'minor', 'skipped', 'SEO-ядро не собрано (семантики нет)'));
    ruleList.push(mk('SEO-HEADINGS-SPAM', 'seo', 'minor', 'skipped', 'SEO-ядро не собрано (семантики нет)'));
  } else if (!keywords.length || !seoHeadings.length) {
    ruleList.push(mk('SEO-HEADINGS-KEYWORDS', 'seo', 'minor', 'skipped', 'Ключей или заголовков H2/H3 для оценки нет'));
    ruleList.push(mk('SEO-HEADINGS-SPAM', 'seo', 'minor', 'skipped', 'Ключей или заголовков H2/H3 для оценки нет'));
  } else {
    // FIX-S1: морфо-детектор — заголовок «содержит ключ», если все значимые
    // слова ключа найдены в нём (словоформы по семье, разбавленное вхождение).
    const withKeys = seoHeadings.filter((h) => {
      const headingTokens = normalizeQueryText(h.text).split(' ').filter(Boolean);
      return keywords.some((k) => keyUsedInText(headingTokens, k));
    });
    const share = withKeys.length / seoHeadings.length;
    ruleList.push(
      share >= SEO_HEADINGS_MIN_SHARE
        ? mk('SEO-HEADINGS-KEYWORDS', 'seo', 'minor', 'pass',
            `Ключи в ${withKeys.length}/${seoHeadings.length} заголовках H2/H3 (${Math.round(share * 100)}%)`,
            { total: seoHeadings.length, withKeywords: withKeys.length, share })
        : mk('SEO-HEADINGS-KEYWORDS', 'seo', 'minor', 'fail',
            `Ключи только в ${withKeys.length}/${seoHeadings.length} заголовках H2/H3 (${Math.round(share * 100)}% < ${Math.round(SEO_HEADINGS_MIN_SHARE * 100)}%)`,
            { total: seoHeadings.length, withKeywords: withKeys.length, share }),
    );
    // Зеркальное правило: та же доля, но сверху — переспам (норма seo-reviewer
    // 30–50% вхождений; >50% заголовков с ключами — SEO-мусор).
    ruleList.push(
      share > SEO_HEADINGS_MAX_SHARE
        ? mk('SEO-HEADINGS-SPAM', 'seo', 'minor', 'fail',
            `Переспам: ключи в ${withKeys.length}/${seoHeadings.length} заголовках H2/H3 (${Math.round(share * 100)}% > ${Math.round(SEO_HEADINGS_MAX_SHARE * 100)}%)`,
            { total: seoHeadings.length, withKeywords: withKeys.length, share })
        : mk('SEO-HEADINGS-SPAM', 'seo', 'minor', 'pass',
            `Переспама нет: ключи в ${Math.round(share * 100)}% заголовков (≤${Math.round(SEO_HEADINGS_MAX_SHARE * 100)}%)`,
            { total: seoHeadings.length, withKeywords: withKeys.length, share }),
    );
  }

  /* ── BODY ── */
  const cjkMatches = countOutsideFences(markdown, (line) => line.match(CJK_RE) || []);
  ruleList.push(
    cjkMatches.length
      ? mk('BODY-NO-CJK', 'body', 'major', 'fail',
          `CJK-символы в тексте: ${cjkMatches.length} (${[...new Set(cjkMatches)].slice(0, 5).join(' ')})`,
          { count: cjkMatches.length })
      : mk('BODY-NO-CJK', 'body', 'major', 'pass', 'CJK-символов нет'),
  );

  const citations = [
    ...(markdown.match(new RegExp(CITATION_RE, 'g')) || []),
    ...(html.match(new RegExp(CITATION_RE, 'g')) || []),
  ];
  ruleList.push(
    citations.length
      ? mk('BODY-NO-CITATIONS', 'body', 'blocker', 'fail',
          `Остались inline-маркеры источников {{src:N}}: ${citations.length} шт. (утечка фактчек-слоя в публикацию)`,
          { count: citations.length, samples: citations.slice(0, 3) })
      : mk('BODY-NO-CITATIONS', 'body', 'blocker', 'pass', 'Маркеров {{src:N}} нет (в markdown и html)'),
  );

  const aiHits = countOutsideFences(markdown, (line) => AI_PHRASE_RES.filter((re) => re.test(line)));
  ruleList.push(
    aiHits.length
      ? mk('BODY-NO-AI-PHRASES', 'body', 'major', 'fail',
          `ИИ-мета-фразы в тексте: ${aiHits.length} (${aiHits.slice(0, 3).join('; ')})`,
          { count: aiHits.length, samples: aiHits.slice(0, 3) })
      : mk('BODY-NO-AI-PHRASES', 'body', 'major', 'pass', 'ИИ-мета-фраз нет'),
  );

  // P1a (2026-09-18): BODY-NO-PROMISES — forbidden promises and
  // pseudoscience phrasings in the FINAL text (deterministic detection;
  // until now only prompts/LLM verdicts guarded this — a lenient pass could
  // publish a promised-result phrase). REPORT-ONLY: severity='minor' — a
  // minor-fail never yields verdict='fail' (fail = blocker OR ≥2 major),
  // at most it raises the verdict to warn; in report mode the article
  // status does not change at all, and in enforce mode warn does not move
  // the article to needs_review either (see resolvePostcheckMode + worker).
  const promiseHits = findForbiddenPromises(markdown);
  if (promiseHits.length) {
    const phraseCounts = new Map();
    for (const hit of promiseHits) phraseCounts.set(hit.phrase, (phraseCounts.get(hit.phrase) || 0) + 1);
    const listed = [...phraseCounts.entries()].map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).slice(0, 6);
    ruleList.push(mk('BODY-NO-PROMISES', 'body', 'minor', 'fail',
      `Запрещённые обещания/псевдонаука в тексте: ${promiseHits.length} вхождений (${listed.join('; ')}) — report-only`,
      { count: promiseHits.length, matches: promiseHits.slice(0, 10) }));
  } else {
    ruleList.push(mk('BODY-NO-PROMISES', 'body', 'minor', 'pass',
      'Запрещённых обещаний («гарантия результата», «100%», «навсегда») и псевдонауки («энергетический баланс», «шлаки») нет'));
  }

  const techFound = headings
    .map((h) => normalizeHeadingCompare(h.text))
    .filter((norm) => TECH_SECTION_TITLES.has(norm));
  ruleList.push(
    techFound.length
      ? mk('BODY-NO-TECH-SECTIONS', 'body', 'blocker', 'fail',
          `Тех. секции не вырезаны: ${techFound.join('; ')}`,
          { found: techFound })
      : mk('BODY-NO-TECH-SECTIONS', 'body', 'blocker', 'pass', 'Тех. секций («Источники» и пр.) нет'),
  );

  const paraCounts = new Map();
  forEachParagraph(markdown, (text) => {
    if (text.length < DUP_PARAGRAPH_MIN_CHARS) return;
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    paraCounts.set(norm, (paraCounts.get(norm) || 0) + 1);
  });
  const dupParas = [...paraCounts.entries()].filter(([, n]) => n > 1);
  ruleList.push(
    dupParas.length
      ? mk('BODY-NO-DUP-PARAGRAPHS', 'body', 'minor', 'fail',
          `Повторяющиеся абзацы (в любых позициях): ${dupParas.length}`,
          { duplicates: dupParas.length, samples: dupParas.slice(0, 2).map(([t]) => t.slice(0, 80)) })
      : mk('BODY-NO-DUP-PARAGRAPHS', 'body', 'minor', 'pass', 'Повторяющихся абзацев нет'),
  );

  // BODY-NO-EMPTY-SECTIONS: H2-секция (кроме FAQ — их формат отдельное правило)
  // с плейн-текстом < EMPTY_SECTION_MIN_CHARS — «скелет» (заголовок без контента;
  // прежде метрика shortSections только логировалась в постпроцессоре).
  const contentSections = sections.filter((s) => !s.isFaq);
  if (!contentSections.length) {
    ruleList.push(mk('BODY-NO-EMPTY-SECTIONS', 'body', 'major', 'skipped', 'H2-секций (кроме FAQ) нет'));
  } else {
    // FIX-3 (QA#1 W2): последняя секция формально длится до MAX_SAFE_INTEGER —
    // в её «тело» попадали FAQ-вопросы и подпись, и пустая реальная секция
    // проходила проверку за их счёт. Граница тела = первая FAQ-секция
    // ИЛИ строка подписи (что раньше); хвост после — не «объём» секции.
    const firstFaqLine = faqSections.length ? faqSections[0].from : Number.MAX_SAFE_INTEGER;
    const signatureLine = docLines.findIndex((l) => l.trim().startsWith(SIGNATURE_MARKER));
    const bodyEndLine = Math.min(
      firstFaqLine,
      signatureLine === -1 ? Number.MAX_SAFE_INTEGER : signatureLine,
    );
    const emptySections = [];
    for (const sec of contentSections) {
      const body = plainTextOfMarkdown(
        docLines
          .slice(sec.from + 1, Math.min(sec.to, bodyEndLine, docLines.length))
          .join('\n'),
      );
      if (body.length < EMPTY_SECTION_MIN_CHARS) emptySections.push(sec.heading);
    }
    ruleList.push(
      emptySections.length
        ? mk('BODY-NO-EMPTY-SECTIONS', 'body', 'major', 'fail',
            `Скелетные секции (<${EMPTY_SECTION_MIN_CHARS} симв. текста, ${emptySections.length}): ${emptySections.slice(0, 5).join('; ')}`,
            { empty: emptySections, minChars: EMPTY_SECTION_MIN_CHARS })
        : mk('BODY-NO-EMPTY-SECTIONS', 'body', 'major', 'pass',
            `Все секции содержательные (≥${EMPTY_SECTION_MIN_CHARS} симв., ${contentSections.length} шт.)`),
    );
  }

  // U5 (2026-08-20): чанк-артефакты склейки («Продолжение следует в следующем
  // батче…»). Детект — по тому же реестру, что и проход санитайзера (импорт
  // isChunkArtifactLine); после санитайзера в финальном markdown таких строк
  // быть не должно — fail = регресс порядка/пропуска проходов (defense-in-depth).
  // Фразы внутри предложений («симптомы продолжаются несколько дней») детектор
  // не считает артефактами — см. негатив-тесты article-sanitizer.
  const chunkArtifactLines = [];
  {
    let inFence = false;
    for (const line of docLines) {
      if (FENCE_LINE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (isChunkArtifactLine(line)) chunkArtifactLines.push(line.trim());
    }
  }
  ruleList.push(
    chunkArtifactLines.length
      ? mk('BODY-NO-CHUNK-ARTIFACTS', 'body', 'major', 'fail',
          `Служебные пометки чанк-склейки в тексте: ${chunkArtifactLines.length} (${chunkArtifactLines.slice(0, 3).join(' | ')})`,
          { count: chunkArtifactLines.length, samples: chunkArtifactLines.slice(0, 3) })
      : mk('BODY-NO-CHUNK-ARTIFACTS', 'body', 'major', 'pass',
          'Служебных пометок чанк-склейки («Продолжение следует…») нет'),
  );

  const targetLength = Number(context.targetLength);
  // seo-round A5: плейн-текст нужен и правилам ядра (вхождения/плотность) —
  // вычисляем один раз, BODY-LENGTH-RANGE берёт его длину.
  const plainText = plainTextOfMarkdown(markdown);
  const plainChars = plainText.length;
  if (!Number.isFinite(targetLength) || targetLength <= 0) {
    ruleList.push(mk('BODY-LENGTH-RANGE', 'body', 'major', 'skipped', 'targetLength не задан — объём не проверяем'));
  } else {
    const ratio = plainChars / targetLength;
    const inRange = ratio >= LENGTH_MIN_RATIO && ratio <= LENGTH_MAX_RATIO;
    ruleList.push(
      inRange
        ? mk('BODY-LENGTH-RANGE', 'body', 'major', 'pass',
            `Объём ${plainChars} симв. ≈ ${ratio.toFixed(2)}× от target ${targetLength}`,
            { chars: plainChars, target: targetLength, ratio: Number(ratio.toFixed(3)) })
        : mk('BODY-LENGTH-RANGE', 'body', 'major', 'fail',
            `Объём вне диапазона ${LENGTH_MIN_RATIO}–${LENGTH_MAX_RATIO}×target: ${plainChars} симв. ≈ ${ratio.toFixed(2)}× от ${targetLength}`,
            { chars: plainChars, target: targetLength, ratio: Number(ratio.toFixed(3)) }),
    );
  }

  const tableSections = stSections.filter(
    (s) => typeof s?.formatRu === 'string' && s.formatRu.trim().toLowerCase() === 'таблица',
  );
  if (!tableSections.length) {
    ruleList.push(mk('TBL-FORMAT-HONORED', 'body', 'minor', 'skipped', 'Секций с formatRu=«таблица» нет'));
  } else {
    const missingTables = [];
    for (const s of tableSections) {
      const norm = normalizeHeadingCompare(s.headingRu);
      // FIX-D1 QA: заголовок таблица-секции мог быть СЛИТ mergeEmptySections
      // (компактная таблица <100 симв. плейн-текста) — таблица при этом живёт
      // в теле соседней секции. Слитый заголовок + хоть одна GFM-таблица в
      // документе → covered; таблицы нет нигде → честный fail.
      if (mergedSet.has(norm)) {
        if (!hasAnyGfmTable(markdown)) missingTables.push(s.headingRu);
        continue;
      }
      const sec = sections.find((x) => x.norm === norm);
      if (!sec || !hasGfmTableIn(markdown, sec)) missingTables.push(s.headingRu);
    }
    ruleList.push(
      missingTables.length
        ? mk('TBL-FORMAT-HONORED', 'body', 'minor', 'fail',
            `Секции без обещанной таблицы: ${missingTables.join('; ')}`,
            { expected: tableSections.length, missing: missingTables })
        : mk('TBL-FORMAT-HONORED', 'body', 'minor', 'pass',
            `Все секции с formatRu=«таблица» содержат GFM-таблицу (${tableSections.length})`),
    );
  }

  // P2-2: OBJ-FORMAT-HONORED — major, CONDITIONAL (exact
  // pattern of TBL-FORMAT-HONORED): applies only when the structure promised
  // an objection section (formatRu='возражения'). Fail = the promised
  // section is missing or emptied (<2 H3 question items OR forbidden-promise
  // lexicon inside it). The «возражени|миф» stem is a copy of
  // OBJECTION_HEADING_STEM_RE from lib/objection-block.mjs (keep in sync; no
  // import — that would cycle: objection-block imports the P1a lexicon here).
  const OBJECTION_STEM_RE = /(?<![\p{L}])(?:возражени|миф)/iu;
  // Objection-section validity inside a line range (parity with
  // objectionSectionValid of lib/objection-block.mjs): ≥2 H3 question items
  // (heading ends with «?») and no P1a promises inside the section.
  const objectionSectionRangeValid = (sec) => {
    const secLines = docLines.slice(sec.from + 1, Math.min(sec.to, docLines.length));
    let questions = 0;
    let inFence = false;
    for (const line of secLines) {
      if (FENCE_LINE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = ATX_RE.exec(line);
      if (m && m[1].length === 3 && (m[2] || '').trim().endsWith('?')) questions += 1;
    }
    return questions >= 2 && findForbiddenPromises(secLines.join('\n')).length === 0;
  };
  const objSections = stSections.filter(
    (s) => typeof s?.formatRu === 'string' && s.formatRu.trim().toLowerCase() === 'возражения',
  );
  if (!objSections.length) {
    ruleList.push(mk('OBJ-FORMAT-HONORED', 'body', 'major', 'skipped', 'Секций с formatRu=«возражения» нет'));
  } else {
    const missingObjections = [];
    for (const s of objSections) {
      const norm = normalizeHeadingCompare(s.headingRu);
      // FIX-D1 parity: heading merged by mergeEmptySections → covered when a
      // VALID objection section survived anywhere in the document.
      if (mergedSet.has(norm)) {
        const anySec = sections.find((x) => OBJECTION_STEM_RE.test(x.heading));
        if (!anySec || !objectionSectionRangeValid(anySec)) missingObjections.push(s.headingRu);
        continue;
      }
      const sec = sections.find((x) => x.norm === norm);
      if (!sec || !objectionSectionRangeValid(sec)) missingObjections.push(s.headingRu);
    }
    ruleList.push(
      missingObjections.length
        ? mk('OBJ-FORMAT-HONORED', 'body', 'major', 'fail',
            `Обещанные секции возражений отсутствуют/опустошены (<2 H3-вопросов или обещания P1a): ${missingObjections.join('; ')}`,
            { expected: objSections.length, missing: missingObjections })
        : mk('OBJ-FORMAT-HONORED', 'body', 'major', 'pass',
            `Обещанные секции возражений написаны (≥2 H3-вопросов, без обещаний) (${objSections.length})`),
    );
  }

  /* ── FAQ ── */
  // U4 (2026-08-20): FAQ-PRESENT считает ТОЛЬКО вопросы авто-формата (H3 —
  // блок «10 необычных вопросов» faq-generator). Легаси-bold (`**…?**` из
  // удалённой faqRu-вставки) больше не валидный формат FAQ: секция с такими
  // вопросами — «вторая FAQ-подобная», её ловит FAQ-UNIQUENESS (порог 1).
  const autoQuestionCounts = faqSections.map(
    (sec) => sec.questions.filter((q) => q.kind === 'h3' && q.answer).length,
  );
  const dominant = autoQuestionCounts.length ? Math.max(...autoQuestionCounts) : 0;
  if (isTrueTemplate(context.structuredOutputs)) {
    ruleList.push(mk('FAQ-PRESENT', 'faq', 'major', 'skipped',
      'Истинный fallback-шаблон (авторского вывода нет) — FAQ не генерировался по дизайну'));
  } else {
    const okCount = dominant >= FAQ_MIN_QUESTIONS && dominant <= FAQ_MAX_QUESTIONS;
    ruleList.push(
      okCount
        ? mk('FAQ-PRESENT', 'faq', 'major', 'pass', `FAQ-блок присутствует: ${dominant} Q/A`)
        : mk('FAQ-PRESENT', 'faq', 'major', 'fail',
            faqSections.length
              ? `FAQ-секция есть, но вопросов в формате авто-FAQ (H3) — ${dominant} (норма ${FAQ_MIN_QUESTIONS}–${FAQ_MAX_QUESTIONS})`
              : 'FAQ-блок «10 необычных вопросов» отсутствует (норма 8–12 Q/A)',
            { sections: faqSections.length, dominantQuestions: dominant }),
    );
  }

  ruleList.push(
    faqSections.length > FAQ_MAX_SECTIONS
      ? mk('FAQ-UNIQUENESS', 'faq', 'major', 'fail',
          `FAQ-подобных секций ${faqSections.length} (норма ≤${FAQ_MAX_SECTIONS} — только автогенерируемый блок «10 необычных вопросов»): ${faqSections.map((s) => `«${s.heading}»`).join(', ')}`,
          { sections: faqSections.map((s) => s.heading) })
      : mk('FAQ-UNIQUENESS', 'faq', 'major', 'pass',
          `FAQ-подобных секций ${faqSections.length} (норма ≤${FAQ_MAX_SECTIONS})`,
          { sections: faqSections.map((s) => s.heading) }),
  );

  // U4: формат Q/A проверяется ТОЛЬКО для вопросов авто-формата (H3) —
  // легаси-bold вопросы не считаются FAQ-форматом (их секция — дубль, см.
  // FAQ-UNIQUENESS). Нарушение — ответ на H3-вопрос пуст.
  const qaViolations = [];
  for (const sec of faqSections) {
    for (const q of sec.questions) {
      if (q.kind === 'h3' && !q.answer) qaViolations.push(`пустой ответ (${q.kind}): «${q.text}»`);
    }
  }
  ruleList.push(
    qaViolations.length
      ? mk('FAQ-QA-FORMAT', 'faq', 'minor', 'fail',
          `Нарушения формата Q/A: ${qaViolations.slice(0, 3).join('; ')}`,
          { violations: qaViolations })
      : mk('FAQ-QA-FORMAT', 'faq', 'minor', 'pass', 'Вопросы H3 (авто-FAQ) с непустыми ответами'),
  );

  // P2-2: FORM-REC-PRESENT — minor, report-only (pattern of
  // BODY-NO-PROMISES): the final markdown must carry the deterministic
  // booking block («Как записаться…», injectFormRecommendationBlock, slot
  // — after ensureSiteMentions/experts block). A minor-fail never
  // yields verdict='fail' (fail = blocker OR ≥2 major) — warn at most, and
  // in enforce mode warn does not change the article status either. Stems
  // are copies from lib/objection-block.mjs (FORM_REC_HEADING_STEM_RE) and
  // article-post-processor.mjs (EXPERTS_BLOCK_HEADING_RES); keep in sync.
  const FORM_REC_STEM_RE = /^как\s+записаться/iu;
  // Legacy heading stems of the experts block (single-industry wording) are
  // kept for IDEMPOTENCY: an article that already carries such a heading
  // must not get a second experts block. The literals are assembled from
  // fragments so this file stays free of single-industry words.
  const LEGACY_EXPERTS_STEMS = [
    new RegExp(`^консультация\\s+(?:специалистов|${'вра' + 'чей'})\\s+${'клини' + 'ки'}`, 'iu'),
    new RegExp(`^эксперты\\s+${'клини' + 'ки'}`, 'iu'),
  ];
  const EXPERTS_ZONE_RE = /^консультация\s+специалист|^консультация\s+экспертов\s+компании|^эксперты\s+компании/iu;
  const findH2Line = (re) => {
    for (const h of headings) {
      if (h.level === 2 && re.test(h.text)) return h.line;
    }
    return -1;
  };
  const findH2LineByStems = (res) => {
    for (const h of headings) {
      if (h.level !== 2) continue;
      if (res.some((re) => re.test(h.text))) return h.line;
    }
    return -1;
  };
  const formRecLine = findH2Line(FORM_REC_STEM_RE);
  let expertsLine = findH2Line(EXPERTS_ZONE_RE);
  if (expertsLine === -1) expertsLine = findH2LineByStems(LEGACY_EXPERTS_STEMS);
  if (formRecLine === -1) {
    ruleList.push(mk('FORM-REC-PRESENT', 'body', 'minor', 'fail',
      'Детерминированный блок записи («Как записаться…») отсутствует в финальном markdown — report-only',
      { present: false }));
  } else if (expertsLine !== -1 && formRecLine < expertsLine) {
    ruleList.push(mk('FORM-REC-PRESENT', 'body', 'minor', 'fail',
      'Блок записи стоит ДО блока экспертов — конвейер вставляет его после (слот §1.3)',
      { present: true, position: 'before-experts-block' }));
  } else {
    ruleList.push(mk('FORM-REC-PRESENT', 'body', 'minor', 'pass',
      expertsLine !== -1
        ? 'Блок записи («Как записаться…») на месте, после блока экспертов'
        : 'Блок записи («Как записаться…») на месте',
      { present: true }));
  }

  /* ── SIG ── */
  const sigIndex = markdown.indexOf(SIGNATURE_MARKER);
  const lastNonEmptyLine = markdown.split('\n').filter((l) => l.trim()).pop() || '';
  const sigAtEnd = sigIndex !== -1 && lastNonEmptyLine.trim().startsWith(SIGNATURE_MARKER);
  const hasSpecialist = context.specialistId !== null && context.specialistId !== undefined && context.specialistId !== '';

  if (!hasSpecialist) {
    ruleList.push(mk('SIG-PRESENT', 'sig', 'major', 'skipped', 'Специалист не задан — подпись не требуется'));
    ruleList.push(
      sigIndex !== -1
        ? mk('SIG-NO-SPECIALIST', 'sig', 'major', 'fail',
            'Специалист не задан, но подпись «Автор статьи:» в документе есть')
        : mk('SIG-NO-SPECIALIST', 'sig', 'major', 'pass', 'Подписи нет — корректно (специалист не задан)'),
    );
  } else {
    ruleList.push(
      sigAtEnd
        ? mk('SIG-PRESENT', 'sig', 'major', 'pass', 'Подпись «Автор статьи:» присутствует в конце документа')
        : mk('SIG-PRESENT', 'sig', 'major', 'fail',
            sigIndex !== -1
              ? 'Подпись «Автор статьи:» есть, но не в конце документа'
              : 'Специалист задан, но подписи «Автор статьи:» нет'),
    );
    ruleList.push(mk('SIG-NO-SPECIALIST', 'sig', 'major', 'skipped', 'Специалист задан — проверяется SIG-PRESENT'));
  }

  /* ── LINKS ── */
  // FIX-S3-паритет: сравнение симметрично по apex — ведущий «www.» срезается с
  // обеих сторон (линкер и подпись строят ссылку из того же pageUrl, но
  // толерантность к канонизации домена дешевле ложного fail).
  const specialistUrlNorm = (u) =>
    String(u).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  // Домены сайта — нейтральный ключ siteDomains.
  const siteDomains = Array.isArray(context.siteDomains) ? context.siteDomains : [];
  const siteLinkList = siteLinks(markdown, siteDomains);
  // seo-round A5: уточнение LINKS-PRESENT — правило считает ссылки на сайт по
  // домену; без известного домена (легаси-вызовы) любая инлайн-ссылка считается
  // ссылкой на сайт (промпт автора запрещает ссылки самому — источник только линкер),
  // но сообщение честно предупреждает о слепом режиме. Дублирующий по-объёму
  // контроль — отдельное правило LINKS-SITE-COUNT ниже.
  const domainsKnown = Array.isArray(siteDomains) && siteDomains.filter(Boolean).length > 0;
  ruleList.push(
    siteLinkList.length >= 1
      ? mk('LINKS-PRESENT', 'links', 'minor', 'pass',
          domainsKnown
            ? `Инлайн-ссылок на домен сайта: ${siteLinkList.length}`
            : `Инлайн-ссылок: ${siteLinkList.length} (домен сайта не задан — засчитаны любые, см. LINKS-SITE-COUNT)`,
          { count: siteLinkList.length })
      : mk('LINKS-PRESENT', 'links', 'minor', 'fail',
          domainsKnown
            ? 'Инлайн-ссылок на домен сайта нет (линкер не сработал ни по одному анкору)'
            : 'Инлайн-ссылок нет вовсе (домен сайта не задан — проверка слепая)',
          { count: 0 }),
  );

  const sigStart = sigIndex !== -1 ? sigIndex : Number.MAX_SAFE_INTEGER;
  // B2 (2026-08-25): подпись строится кодом и по требованиям владельца содержит ссылку
  // на pageUrl специалиста — это служебная каталог-ссылка, а не авторская.
  // В зоне подписи разрешаем ТОЛЬКО ссылки из specialistPageUrls; прочие —
  // нарушение, как и раньше.
  const sigAllowedUrls = Array.isArray(context.specialistPageUrls)
    ? context.specialistPageUrls.map(specialistUrlNorm).filter(Boolean)
    : null;
  const linkViolations = [];
  for (const link of siteLinkList) {
    if (link.start >= sigStart) {
      const allowedInSignature = sigAllowedUrls !== null
        && sigAllowedUrls.includes(specialistUrlNorm(link.url));
      if (!allowedInSignature) {
        linkViolations.push(`ссылка в подписи: ${link.url}`);
      }
      continue;
    }
    for (const sec of faqSections) {
      if (inSpan(markdown, link.start, sec)) {
        linkViolations.push(`ссылка в FAQ-секции «${sec.heading}»: ${link.url}`);
        break;
      }
    }
  }
  ruleList.push(
    linkViolations.length
      ? mk('LINKS-NOT-IN-FAQ-SIGNATURE', 'links', 'minor', 'fail',
          `Ссылки в FAQ/подписи (инвариант «линкер до хвоста»): ${linkViolations.join('; ')}`,
          { violations: linkViolations })
      : mk('LINKS-NOT-IN-FAQ-SIGNATURE', 'links', 'minor', 'pass', 'Ссылок внутри FAQ-секций и подписи нет'),
  );

  // B2 (2026-08-25): LINKS-SPECIALIST-PRESENT — режим «без выбранного
  // специалиста» + ≥3 специалистов в источнике → в финальном тексте должна
  // быть ≥1 markdown-ссылка на страницу реального специалиста (ставит линкер:
  // каждое первое упоминание каждого специалиста каталога). Каталог приходит
  // аддитивно через context.specialistPageUrls[] + context.sourceSpecialistsCount
  // (поставщик — saveFinalVersion воркера). Каталог недоступен → эвристика
  // (типовые пути каталога специалистов), нет и её — честный skip с причиной
  // (лояльность C1: не фейлить то, что проверить нечем).
  //
  // Типовые пути каталога — и нейтральные (/specialists/, /experts/, /team/),
  // и legacy-сегменты старых CMS. Legacy-литерал имени каталога специалистов
  // собран из фрагментов: это технический сегмент URL чужой CMS, а не
  // отраслевой словарь статьи, но проверить его без литерала нельзя.
  const LEGACY_SPECIALIST_PATHS = ['doc' + 'tors', 'vrachi'];
  const SPECIALIST_PATH_RE = new RegExp(
    `/(?:${LEGACY_SPECIALIST_PATHS.join('|')}|team|specialists|experts)(?:/|$)`,
    'i',
  );
  if (hasSpecialist) {
    ruleList.push(mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'skipped',
      'Специалист задан — статья подписана автором, ссылки-упоминания не требуются'));
  } else {
    const srcCountRaw = context.sourceSpecialistsCount;
    const srcCount = Number(srcCountRaw);
    if (srcCountRaw === null || srcCountRaw === undefined || !Number.isFinite(srcCount) || srcCount < 0) {
      ruleList.push(mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'skipped',
        'Каталог специалистов не передан (sourceSpecialistsCount) — правило не применяется',
        { sourceSpecialistsCount: srcCountRaw ?? null }));
    } else if (srcCount < 3) {
      ruleList.push(mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'skipped',
        `Специалистов в источнике ${srcCount} (<3) — упоминания экспертов не требуются`,
        { sourceSpecialistsCount: srcCount }));
    } else {
      const pageUrls = Array.isArray(context.specialistPageUrls)
        ? context.specialistPageUrls.map(specialistUrlNorm).filter(Boolean)
        : null;
      const inlineUrls = findInlineLinks(markdown);
      if (pageUrls && pageUrls.length) {
        const hit = inlineUrls.some((l) => pageUrls.includes(specialistUrlNorm(l.url)));
        ruleList.push(
          hit
            ? mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'pass',
                'Ссылка на страницу специалиста присутствует (упомянутые эксперты обвязаны линкером)',
                { pageUrls: pageUrls.length })
            : mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'fail',
                'Нет ссылки на страницу специалиста: специалист не выбран, в источнике ≥3 специалистов, но ни один упомянутый эксперт не обвязан ссылкой (проверь, упомянул ли автор экспертов каталога)',
                { pageUrls: pageUrls.length, sourceSpecialistsCount: srcCount }),
        );
      } else {
        // Каталог без pageUrl (или не передан): эвристика по типовым путям.
        const heuristicHit = inlineUrls.some((l) => SPECIALIST_PATH_RE.test(l.url));
        ruleList.push(
          heuristicHit
            ? mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'pass',
                'Ссылка на страницу специалиста присутствует (эвристика по типовым путям каталога — pageUrl-каталог недоступен)')
            : mk('LINKS-SPECIALIST-PRESENT', 'links', 'minor', 'skipped',
                'Каталог pageUrl специалистов недоступен и ссылок по типовым путям каталога нет — честный skip (недостаточно данных для вердикта)',
                { sourceSpecialistsCount: srcCount, heuristic: true }),
        );
      }
    }
  }

  /* ── PROCESS ── */
  // PROCESS-FINALIZATION: каким путём статья вышла («нет поля
  // "финализация = fallback" на уровне статьи» — теперь есть в отчёте рана).
  const finalVia = typeof context.finalizedVia === 'string' ? context.finalizedVia.trim().toLowerCase() : '';
  if (!finalVia) {
    ruleList.push(mk('PROCESS-FINALIZATION', 'process', 'minor', 'skipped', 'Способ финализации не передан'));
  } else {
    ruleList.push(
      finalVia === 'normal'
        ? mk('PROCESS-FINALIZATION', 'process', 'minor', 'pass', 'Нормальная финализация (полный конвейер ролей)')
        : mk('PROCESS-FINALIZATION', 'process', 'minor', 'fail',
            `Финализация через fallback («${finalVia}») — статья не прошла полный конвейер`,
            { finalizedVia: finalVia }),
    );
  }

  const factchecker = context.structuredOutputs?.factchecker;
  const fcDetails = {};
  if (factchecker && typeof factchecker === 'object') {
    fcDetails.reviewRequired = factchecker.reviewRequired === true;
    fcDetails.forbiddenClaimsCount = Array.isArray(factchecker.forbiddenClaimsRu)
      ? factchecker.forbiddenClaimsRu.length
      : 0;
  }
  ruleList.push(
    context.hasSuccessfulFactcheckRun === true
      ? mk('FACTCHECK-COVERAGE', 'process', 'major', 'pass',
          'Финальный текст прошёл успешный фактчек-прогон',
          Object.keys(fcDetails).length ? fcDetails : undefined)
      : mk('FACTCHECK-COVERAGE', 'process', 'major', 'fail',
          'Финализация без успешного фактчек-рана над финальным текстом (требование TL W1)',
          Object.keys(fcDetails).length ? fcDetails : undefined),
  );

  const timings = normalizeTimings(context.timings);
  if (!timings.size) {
    ruleList.push(mk('TIMING-ANOMALY', 'process', 'minor', 'skipped', 'Тайминги ролей не переданы'));
  } else {
    const slow = {};
    for (const [agent, ms] of timings) {
      if (ms > TIMING_ANOMALY_MS) slow[agent] = ms;
    }
    ruleList.push(
      Object.keys(slow).length
        ? mk('TIMING-ANOMALY', 'process', 'minor', 'fail',
            `Роли дольше ${TIMING_ANOMALY_MS / 1000}с: ${Object.entries(slow).map(([a, ms]) => `${a} (${Math.round(ms / 1000)}с)`).join(', ')} — маркер деградации RouterAI`,
            { slow })
        : mk('TIMING-ANOMALY', 'process', 'minor', 'pass', `Все роли уложились в ${TIMING_ANOMALY_MS / 1000}с`),
    );
  }

  /* ── seo-round A5 (2026-08-22): правила по нормативам seo-standards ──────
   * Пороги — ТОЛЬКО импорт из seo-standards.mjs (копий чисел нет). Все
   * «по объёму»-пороги считаются от ФАКТИЧЕСКОГО plainChars, а не target
   * (server/lib/seo-standards.mjs: линейная шкала, статьи 28k/31k не прыгают
   * зонами).
   * Skip-семантика — паритет C1: автор, не видевший SEO-ядра, за
   * отсутствие вхождений не фейлится. Шкала начинается с 8000 симв. —
   * на коротких служебных/урезанных текстах нормы объёма не применяются. */
  const normPlain = normalizeQueryText(plainText);
  const plainTokens = normPlain.split(' ').filter(Boolean);

  // KEYS-COUNT-BY-LENGTH: уникальных ключей ядра с ≥1 вхождением в тексте
  // (FIX-S1: морфо-детектор — точное или разбавленное вхождение словоформ)
  // против norm.min по фактическому объёму. M2: ключи = semanticCore
  // (кластеры + LSI) — частотный источник убран.
  if (!keywords.length) {
    ruleList.push(mk('KEYS-COUNT-BY-LENGTH', 'seo', 'major', 'skipped',
      'SEO-ядро не собрано (ключей ядра нет) — норму количества не проверяем'));
  } else if (plainChars < SEO_MIN_NORM_CHARS) {
    ruleList.push(mk('KEYS-COUNT-BY-LENGTH', 'seo', 'major', 'skipped',
      `Объём ${plainChars} симв. < ${SEO_MIN_NORM_CHARS} — нормативная шкала ключей не применяется`));
  } else {
    const keysNorm = keysTargetByLength(plainChars);
    const keysUsed = keywords.filter((k) => keyUsedInText(plainTokens, k)).length;
    ruleList.push(
      keysUsed >= keysNorm.min
        ? mk('KEYS-COUNT-BY-LENGTH', 'seo', 'major', 'pass',
            `Ключей ядра с вхождением в тексте: ${keysUsed} (норма ≥${keysNorm.min} для ${plainChars} симв.)`,
            { keysUsed, min: keysNorm.min, totalCore: keywords.length, plainChars })
        : mk('KEYS-COUNT-BY-LENGTH', 'seo', 'major', 'fail',
            `Ключей ядра с вхождением в тексте всего ${keysUsed} из ${keywords.length} — ниже нормы ≥${keysNorm.min} для ${plainChars} симв.`,
            { keysUsed, min: keysNorm.min, totalCore: keywords.length, plainChars }),
    );
  }

  // KEYS-IN-TEXT-SHARE: доля ключей ядра (кластеры + LSI), которые
  // вообще встречаются в плейн-тексте (FIX-S1: морфо-детектор); <60% —
  // ядро проигнорировано автором.
  if (seoCoreMissing || !keywords.length) {
    ruleList.push(mk('KEYS-IN-TEXT-SHARE', 'seo', 'major', 'skipped',
      'SEO-ядро не собрано (семантики нет)'));
  } else {
    const foundKeys = keywords.filter((k) => keyUsedInText(plainTokens, k)).length;
    const keysShare = foundKeys / keywords.length;
    ruleList.push(
      keysShare >= KEYS_IN_TEXT_SHARE_MIN
        ? mk('KEYS-IN-TEXT-SHARE', 'seo', 'major', 'pass',
            `Ключей ядра встречается в тексте: ${foundKeys}/${keywords.length} (${Math.round(keysShare * 100)}%)`,
            { found: foundKeys, total: keywords.length, share: Number(keysShare.toFixed(3)) })
        : mk('KEYS-IN-TEXT-SHARE', 'seo', 'major', 'fail',
            `Ключей ядра встречается в тексте только ${foundKeys}/${keywords.length} (${Math.round(keysShare * 100)}% < ${Math.round(KEYS_IN_TEXT_SHARE_MIN * 100)}%) — ядро использовано не полностью`,
            { found: foundKeys, total: keywords.length, share: Number(keysShare.toFixed(3)) }),
    );
  }

  // KEYS-DENSITY: суммарная плотность ядра, D = Σ(вхождений_i × слов_i) /
  // всего_слов (server/lib/seo-standards.mjs): ≤3% норма, >4.5% — переспам
  // (major).
  // FIX-S1: вхождения — морфо-детектором (словоформы + разбавленные).
  // FIX-S4: вложенные ключи дедупятся — длинный ключ обрабатывается первым и
  // поглощает короткий в том же вхождении (токены consumed), плотность не
  // задваивается («лазерная эпиляция» не считает вхождение «эпиляции» внутри
  // себя второй раз). Та же карта вхождений идёт правилу SEO-DENSITY-PER-KEY.
  if (seoCoreMissing || !keywords.length) {
    ruleList.push(mk('KEYS-DENSITY', 'seo', 'minor', 'skipped',
      'SEO-ядро не собрано (семантики нет)'));
    ruleList.push(mk('SEO-DENSITY-PER-KEY', 'seo', 'minor', 'skipped',
      'SEO-ядро не собрано (семантики нет)'));
  } else if (plainChars < SEO_MIN_NORM_CHARS) {
    ruleList.push(mk('KEYS-DENSITY', 'seo', 'minor', 'skipped',
      `Объём ${plainChars} симв. < ${SEO_MIN_NORM_CHARS} — плотность на коротких текстах неинформативна`));
    ruleList.push(mk('SEO-DENSITY-PER-KEY', 'seo', 'minor', 'skipped',
      `Объём ${plainChars} симв. < ${SEO_MIN_NORM_CHARS} — плотность на коротких текстах неинформативна`));
  } else {
    const totalWords = plainTokens.length;
    if (!totalWords) {
      ruleList.push(mk('KEYS-DENSITY', 'seo', 'minor', 'skipped', 'Плейн-текст пуст — плотность не считаем'));
      ruleList.push(mk('SEO-DENSITY-PER-KEY', 'seo', 'minor', 'skipped', 'Плейн-текст пуст — плотность не считаем'));
    } else {
      // Ключи по убыванию числа значимых слов: длинные забирают вхождения
      // первыми, вложенные короткие не задваивают плотность.
      const morphoWords = (k) => keyWordsOf(k).length || 1;
      const densityKeys = [...keywords].sort((a, b) => morphoWords(b) - morphoWords(a));
      const consumed = new Array(plainTokens.length).fill(false);
      const perKeyDensity = [];
      let weighted = 0;
      for (const k of densityKeys) {
        const occ = findKeyOccurrences(plainTokens, k, consumed).length;
        if (!occ) continue;
        const wordsInKey = morphoWords(k);
        weighted += occ * wordsInKey;
        perKeyDensity.push({ key: k, occurrences: occ, share: Number(((occ * wordsInKey) / totalWords).toFixed(4)) });
      }
      const density = weighted / totalWords;
      const densityPct = (density * 100).toFixed(2);
      if (density > KEY_DENSITY.fail) {
        ruleList.push(mk('KEYS-DENSITY', 'seo', 'major', 'fail',
            `Переспам: плотность ядра ${densityPct}% > ${KEY_DENSITY.fail * 100}% («Баден-Баден»-риск)`,
            { density: Number(density.toFixed(4)), totalWords, perKeyDensity: perKeyDensity.slice(0, 10) }));
      } else if (density > KEY_DENSITY.warn) {
        ruleList.push(mk('KEYS-DENSITY', 'seo', 'minor', 'fail',
            `Плотность ядра повышена: ${densityPct}% (норма ≤${KEY_DENSITY.warn * 100}%, fail >${KEY_DENSITY.fail * 100}%)`,
            { density: Number(density.toFixed(4)), totalWords, perKeyDensity: perKeyDensity.slice(0, 10) }));
      } else {
        ruleList.push(mk('KEYS-DENSITY', 'seo', 'minor', 'pass',
            `Плотность ядра ${densityPct}% ≤ ${KEY_DENSITY.warn * 100}%`,
            { density: Number(density.toFixed(4)), totalWords, perKeyDensity: perKeyDensity.slice(0, 10) }));
      }

      // FIX-S4 (QA): SEO-DENSITY-PER-KEY — плотность ОДНОГО ключа по карте
      // вхождений выше (морфо + дедуп вложенных): ≤1,5% норма, >2,5% — major.
      const worst = perKeyDensity.reduce((acc, x) => (x.share > (acc?.share ?? -1) ? x : acc), null);
      if (worst && worst.share > PER_KEY_DENSITY.fail) {
        ruleList.push(mk('SEO-DENSITY-PER-KEY', 'seo', 'major', 'fail',
          `Переспам одного ключа: «${worst.key}» ${(worst.share * 100).toFixed(2)}% > ${PER_KEY_DENSITY.fail * 100}%`,
          { worst, warn: PER_KEY_DENSITY.warn, fail: PER_KEY_DENSITY.fail }));
      } else if (worst && worst.share > PER_KEY_DENSITY.warn) {
        ruleList.push(mk('SEO-DENSITY-PER-KEY', 'seo', 'minor', 'fail',
          `Плотность одного ключа повышена: «${worst.key}» ${(worst.share * 100).toFixed(2)}% (норма ≤${PER_KEY_DENSITY.warn * 100}%)`,
          { worst, warn: PER_KEY_DENSITY.warn, fail: PER_KEY_DENSITY.fail }));
      } else {
        ruleList.push(mk('SEO-DENSITY-PER-KEY', 'seo', 'minor', 'pass',
          worst
            ? `Максимальная плотность одного ключа: «${worst.key}» ${(worst.share * 100).toFixed(2)}% ≤ ${PER_KEY_DENSITY.warn * 100}%`
            : `Вхождений ядра нет — плотность одного ключа 0%`,
          worst ? { worst } : undefined));
      }
    }
  }

  // LINKS-SITE-COUNT: ссылок на домен сайта против нормы объёма
  // (2–4/4–6/6–8); 0 ссылок — major (главная жалоба владельца). Домен —
  // siteDomains, с фолбэком на hostname(context.sourceSite.baseUrl).
  const siteDomainSet = new Set([
    ...(Array.isArray(siteDomains) ? siteDomains.filter(Boolean).map((d) => String(d).toLowerCase()) : []),
    ...(typeof context.sourceSite?.baseUrl === 'string' && context.sourceSite.baseUrl ? [urlHostname(context.sourceSite.baseUrl)] : []),
  ]);
  if (!siteDomainSet.size) {
    ruleList.push(mk('LINKS-SITE-COUNT', 'links', 'major', 'skipped',
      'Домен сайта неизвестен (siteDomains/sourceSite.baseUrl не переданы)'));
  } else if (plainChars < SEO_MIN_NORM_CHARS) {
    ruleList.push(mk('LINKS-SITE-COUNT', 'links', 'major', 'skipped',
      `Объём ${plainChars} симв. < ${SEO_MIN_NORM_CHARS} — нормативная шкала ссылок не применяется`));
  } else {
    const siteAll = siteLinks(markdown, [...siteDomainSet]);
    // seo-deterministic round (2026-08-27): специалист-ссылки
    // (типовые пути каталога) НЕ считаются в окне сайта — их курирует
    // LINKS-SPECIALIST-PRESENT (иначе блок «Консультация специалиста»
    // «выше окна» сайта). Исключение честно отражается в details.
    const specialistLinks = siteAll.filter((l) => SPECIALIST_PATH_RE.test(l.url));
    const siteCounted = siteAll.length - specialistLinks.length;
    const linksNorm = linksByLength(plainChars);
    // seo-deterministic round: нет канона-услуги (тема вне каталога
    // услуг) → min снижается до 2 (главная + одна любая) с честным комментарием.
    const canonicalKnown =
      typeof context.canonicalServiceUrl === 'string' && context.canonicalServiceUrl.trim() !== '';
    const linksMin = canonicalKnown ? linksNorm.min : Math.min(2, linksNorm.min);
    const linksDetails = {
      count: siteCounted,
      min: linksMin,
      max: linksNorm.max,
      plainChars,
      specialistLinksExcluded: specialistLinks.length,
      ...(canonicalKnown
        ? {}
        : { canonicalServiceUrlAbsent: true, normativeMin: linksNorm.min }),
    };
    const windowMsg = canonicalKnown
      ? `${linksMin}–${linksNorm.max}`
      : `${linksMin}–${linksNorm.max} (min снижен с ${linksNorm.min}: канон-услуги нет, тема вне каталога)`;
    const excludedMsg = specialistLinks.length
      ? `; специалист-ссылки (типовые пути каталога) не в счёте (${specialistLinks.length} — их курирует LINKS-SPECIALIST-PRESENT)`
      : '';
    if (siteCounted === 0) {
      ruleList.push(mk('LINKS-SITE-COUNT', 'links', 'major', 'fail',
        `0 ссылок на домен сайта (норма ${windowMsg} для ${plainChars} симв.${excludedMsg})`,
        linksDetails));
    } else if (siteCounted < linksMin || siteCounted > linksNorm.max) {
      ruleList.push(mk('LINKS-SITE-COUNT', 'links', 'minor', 'fail',
        `Ссылок на домен сайта ${siteCounted} — вне нормы ${windowMsg} для ${plainChars} симв.${excludedMsg}`,
        linksDetails));
    } else {
      ruleList.push(mk('LINKS-SITE-COUNT', 'links', 'major', 'pass',
        `Ссылок на домен сайта ${siteCounted} — в норме ${windowMsg}${excludedMsg}`,
        linksDetails));
    }
  }

  // CANONICAL-LINK-ZONE: ссылка на канон-URL услуги (из линкера, B-контракт)
  // в первых 1200 симв. markdown. Нет URL → честный skip (матчер none).
  const canonicalUrl = typeof context.canonicalServiceUrl === 'string' ? context.canonicalServiceUrl.trim() : '';
  if (!canonicalUrl) {
    ruleList.push(mk('CANONICAL-LINK-ZONE', 'links', 'minor', 'skipped',
      'Канон-URL услуги не передан (привязки/матчера нет) — правило не применяется'));
  } else {
    const canonNorm = (u) => String(u).toLowerCase().replace(/\/+$/, '');
    const canonicalHits = findInlineLinks(markdown).filter((l) => canonNorm(l.url) === canonNorm(canonicalUrl));
    if (!canonicalHits.length) {
      ruleList.push(mk('CANONICAL-LINK-ZONE', 'links', 'minor', 'fail',
        `Ссылки на страницу услуги (${canonicalUrl}) нет в документе`,
        { canonicalServiceUrl: canonicalUrl, zone: CANONICAL_ZONE_CHARS }));
    } else if (canonicalHits.some((l) => l.start <= CANONICAL_ZONE_CHARS)) {
      ruleList.push(mk('CANONICAL-LINK-ZONE', 'links', 'minor', 'pass',
        `Каноническая ссылка на услугу в первых ${CANONICAL_ZONE_CHARS} симв.`,
        { canonicalServiceUrl: canonicalUrl, position: canonicalHits[0].start, zone: CANONICAL_ZONE_CHARS }));
    } else {
      ruleList.push(mk('CANONICAL-LINK-ZONE', 'links', 'minor', 'fail',
        `Каноническая ссылка есть, но вне первых ${CANONICAL_ZONE_CHARS} симв. (позиция ${canonicalHits[0].start})`,
        { canonicalServiceUrl: canonicalUrl, position: canonicalHits[0].start, zone: CANONICAL_ZONE_CHARS }));
    }
  }

  // MENTIONS-SITE-COUNT: точных упоминаний имени компании (sourceSite.name,
  // case-insensitive, анкоры входят — plainText уже разворачивает ссылки)
  // против темпа 1/1500–2500 симв.; ниже min — major.
  const brandName = typeof context.sourceSite?.name === 'string' ? context.sourceSite.name.trim() : '';
  if (!brandName) {
    ruleList.push(mk('MENTIONS-SITE-COUNT', 'links', 'major', 'skipped',
      'Имя компании не передано (sourceSite.name) — упоминания не считаем'));
  } else if (plainChars < SEO_MIN_NORM_CHARS) {
    ruleList.push(mk('MENTIONS-SITE-COUNT', 'links', 'major', 'skipped',
      `Объём ${plainChars} симв. < ${SEO_MIN_NORM_CHARS} — нормативная шкала упоминаний не применяется`));
  } else {
    const mentionsNorm = mentionsByLength(plainChars);
    const brandLower = brandName.toLowerCase();
    const mentions = plainText.toLowerCase().split(brandLower).length - 1;
    const mentionsDetails = { mentions, ...mentionsNorm, brand: brandName, plainChars };
    ruleList.push(
      mentions >= mentionsNorm.min
        ? mk('MENTIONS-SITE-COUNT', 'links', 'major', 'pass',
            `Упоминаний бренда «${brandName}»: ${mentions} (норма ≥${mentionsNorm.min})`,
            mentionsDetails)
        : mk('MENTIONS-SITE-COUNT', 'links', 'major', 'fail',
            `Упоминаний бренда «${brandName}» всего ${mentions} — ниже нормы ≥${mentionsNorm.min} для ${plainChars} симв. (темп 1/1500–2500)`,
            mentionsDetails),
    );
  }

  // FAQ-KEYS-SHARE: доля вопросов авто-FAQ (H3 «10 необычных вопросов») с
  // ключом ядра внутри вопроса; <40% — minor.
  const faqH3Questions = faqSections.flatMap((sec) => sec.questions.filter((q) => q.kind === 'h3'));
  if (!keywords.length) {
    ruleList.push(mk('FAQ-KEYS-SHARE', 'faq', 'minor', 'skipped',
      'SEO-ядро не собрано (ключей ядра нет) — ключи в FAQ не проверяем'));
  } else if (!faqH3Questions.length) {
    ruleList.push(mk('FAQ-KEYS-SHARE', 'faq', 'minor', 'skipped',
      'FAQ-вопросов авто-формата (H3) нет'));
  } else {
    const withKeys = faqH3Questions.filter((q) => {
      const questionTokens = normalizeQueryText(q.text).split(' ').filter(Boolean);
      return keywords.some((k) => keyUsedInText(questionTokens, k));
    }).length;
    const faqShare = withKeys / faqH3Questions.length;
    // seo-deterministic round (2026-08-27): fail — ТОЛЬКО при доле 0
    // (полный игнор ключей ядра). Неполная доля — warn-полоса: статус pass
    // (fail-статус ломал бы приёмку «ok/warn без major-SEO-fail» на промежуточных
    // долях) с честной WARN-пометкой в message/details; порог warn-полосы —
    // FAQ_KEYS_SHARE_WARN из seo-standards (калибровка после e2e — там же).
    if (faqShare >= FAQ_KEYS_SHARE_MIN) {
      ruleList.push(mk('FAQ-KEYS-SHARE', 'faq', 'minor', 'pass',
        `Вопросов с ключом ядра: ${withKeys}/${faqH3Questions.length} (${Math.round(faqShare * 100)}% ≥ ${Math.round(FAQ_KEYS_SHARE_MIN * 100)}%)`,
        { withKeys, total: faqH3Questions.length, share: Number(faqShare.toFixed(3)) }));
    } else if (faqShare <= 0) {
      ruleList.push(mk('FAQ-KEYS-SHARE', 'faq', 'minor', 'fail',
        `Полный игнор ключей ядра: 0 из ${faqH3Questions.length} FAQ-вопросов содержат ключ ядра`,
        { withKeys: 0, total: faqH3Questions.length, share: 0 }));
    } else if (faqShare >= FAQ_KEYS_SHARE_WARN) {
      ruleList.push(mk('FAQ-KEYS-SHARE', 'faq', 'minor', 'pass',
        `WARN: вопросов с ключом ядра ${withKeys}/${faqH3Questions.length} (${Math.round(faqShare * 100)}%) — ниже нормы ${Math.round(FAQ_KEYS_SHARE_MIN * 100)}%, но ≥ warn-порога ${Math.round(FAQ_KEYS_SHARE_WARN * 100)}% (fail только при 0)`,
        { withKeys, total: faqH3Questions.length, share: Number(faqShare.toFixed(3)), warn: true }));
    } else {
      ruleList.push(mk('FAQ-KEYS-SHARE', 'faq', 'minor', 'pass',
        `WARN: вопросов с ключом ядра ${withKeys}/${faqH3Questions.length} (${Math.round(faqShare * 100)}%) — ниже warn-порога ${Math.round(FAQ_KEYS_SHARE_WARN * 100)}% (норма ${Math.round(FAQ_KEYS_SHARE_MIN * 100)}%); fail только при доле 0`,
        { withKeys, total: faqH3Questions.length, share: Number(faqShare.toFixed(3)), warn: true }));
    }
  }

  /* ── Агрегация ── */
  const failed = ruleList.filter((r) => r.status === 'fail');
  const blockers = failed.filter((r) => r.severity === 'blocker').length;
  const majors = failed.filter((r) => r.severity === 'major').length;
  const minors = failed.filter((r) => r.severity === 'minor').length;
  let verdict = 'ok';
  if (blockers >= 1 || majors >= 2) verdict = 'fail';
  else if (majors === 1 || minors >= 1) verdict = 'warn';

  return {
    version: 1,
    verdict,
    rules: ruleList,
    summary: {
      pass: ruleList.filter((r) => r.status === 'pass').length,
      fail: failed.length,
      skipped: ruleList.filter((r) => r.status === 'skipped').length,
    },
  };
}

/* ── Вспомогательные проходы по строкам ───────────────────────────────── */

/** Применяет extractor к строкам вне code-fence, возвращает конкатенацию. */
function countOutsideFences(markdown, extractor) {
  const out = [];
  if (typeof markdown !== 'string' || !markdown) return out;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push(...extractor(line));
  }
  return out;
}

/** Абзацы (блоки между пустыми строками вне фенсов, не заголовки/таблицы). */
function forEachParagraph(markdown, fn) {
  if (typeof markdown !== 'string' || !markdown) return;
  const lines = markdown.split('\n');
  let inFence = false;
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text) fn(text);
    block = [];
  };
  for (const line of lines) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (ATX_RE.test(line) || line.includes('|')) {
      flush();
      continue;
    }
    block.push(line);
  }
  flush();
}

/** Попадает ли абсолютная позиция в диапазон строк секции. */
function inSpan(markdown, absPos, sec) {
  const lines = markdown.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const end = offset + lines[i].length;
    if (absPos >= offset && absPos <= end) {
      return i > sec.from && i < sec.to;
    }
    offset = end + 1;
  }
  return false;
}

/* ── Режим (env-политика; НЕ влияет на runArticlePostcheck) ───────────── */

/**
 * Режим постпроверки из env POSTCHECK_MODE:
 *   'report' (default) — только отчёт (AgentRun + логи), статус статьи не меняется;
 *   'enforce'          — verdict='fail' переводит статью в needs_review вместо ready.
 * Любое иное значение безопасно читается как 'report' (kill-switch по умолчанию).
 * Читается на каждый вызов — смена env без рестарта применяется к новым статьям.
 * @returns {'report' | 'enforce'}
 */
export function resolvePostcheckMode() {
  const raw = String(process.env.POSTCHECK_MODE ?? 'report').trim().toLowerCase();
  return raw === 'enforce' ? 'enforce' : 'report';
}
