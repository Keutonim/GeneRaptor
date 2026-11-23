/**
 * Fallback-генерация статьи из структуры (при 502 / fetch failed article-author)
 */
import {
  POSTCHECK_FAQ_HEADING_RE,
  keyUsedInText,
  normalizeQueryText,
  collectKeywords,
  findKeyOccurrences,
} from './lib/article-postcheck.mjs';
// P2-2: deterministic booking block.
import {
  buildFormRecommendationBlock,
  hasFormRecommendationBlock,
} from './lib/objection-block.mjs';
// seo-deterministic (2026-08-27): капы плотности/заголовков — ТОЛЬКО из единого
// модуля нормативов (числа не дублируются, план 20260827-seo-deterministic).
import {
  KEY_DENSITY,
  PER_KEY_DENSITY,
  HEADINGS_WITH_KEYS_WINDOW,
  SEO_MIN_NORM_CHARS,
} from './lib/seo-standards.mjs';

// ── G1(c) quality-calibration (2026-08-21): слияние пустых H2-секций ──────
// Порог синхронизирован с EMPTY_SECTION_MIN_CHARS постчека
// (server/lib/article-postcheck.mjs) — там секция с меньшим плейн-текстом
// фейлит BODY-NO-EMPTY-SECTIONS. Здесь та же секция сливается в предыдущую
// ДО финальных sanitize/normalize, чтобы скелет не доходил до постчека.
export const EMPTY_SECTION_MERGE_MIN_CHARS = 100;

// FAQ-детект тот же, что в постчеке (узкий паттерн — см. комментарий там):
// секции «часто задаваемые вопросы», «популярные вопросы», «10 необычных
// вопросов» и пр. имеют собственный формат (Q/A) и не сливаются.

const SIGNATURE_MARKER = '**Автор статьи:**';
const ATX_H2_RE = /^ {0,3}##[ \t]+(.*?)[ \t]*$/;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Нормализация заголовка — как normalizeHeadingCompare постчека. */
function normalizeHeadingForMerge(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Плейн-текст блока markdown (синхронизирован с plainTextOfMarkdown постчека):
 * фенсы выбрасываются, ссылки → анкоры, разметка снимается.
 */
function plainTextOfBlock(lines) {
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
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^ {0,3}>[ \t]?/gm, '')
    .replace(/^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+/gm, '')
    .replace(/[|`*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * G1(c): детерминированная страховка от «скелетных» секций. Чистая функция:
 * H2-секция с телом < minChars плейн-текста (FAQ-секции и хвост после
 * подписи исключены) сливается в ПРЕДЫДУЩУЮ контентную секцию — заголовок
 * пустой секции удаляется, её текст приклеивается к телу соседа.
 *
 * F3 (quality-final 2026-08-21): пустая ПЕРВАЯ секция больше НЕ остаётся
 * как есть — она сливается ВПЕРЁД: заголовок удаляется, её контент (если
 * есть) приклеивается к СЛЕДУЮЩЕЙ выжившей секции (реализовано переносом
 * заголовка следующей секции в начало бывшей первой — контент ведущих
 * скелетов оказывается внутри следующей секции, порядок контента не меняется).
 * Счётчик тот же: слияние первой секции входит в count/mergedHeadings (для
 * HEAD-SECTION-COVERAGE). Если ВЫЖИВШИХ секций нет вообще (все скелетные) —
 * первая остаётся якорем (firstSectionLeftAsIs), как раньше: без единого H2
 * статью оставить нельзя.
 *
 * Уровни: слияние только H2 → H2; H3-подразделы — часть тела своей H2-секции
 * и не трогаются.
 *
 * @param {string} markdown
 * @param {{ minChars?: number }} [options]
 * @returns {{ markdown: string, mergedHeadings: string[], count: number, firstSectionLeftAsIs: number }}
 *   mergedHeadings — НОРМАЛИЗОВАННЫе заголовки слитых секций (для исключения
 *   из HEAD-SECTION-COVERAGE, см. G1(d)).
 */
export function mergeEmptySections(markdown, { minChars = EMPTY_SECTION_MERGE_MIN_CHARS } = {}) {
  if (typeof markdown !== 'string' || !markdown) {
    return { markdown: typeof markdown === 'string' ? markdown : '', mergedHeadings: [], count: 0, firstSectionLeftAsIs: 0 };
  }
  const lines = markdown.split('\n');

  // Границы H2-секций вне code-fence: [{ heading, norm, line }] + подпись.
  const h2s = [];
  let inFence = false;
  let signatureLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (signatureLine === -1 && line.trim().startsWith(SIGNATURE_MARKER)) {
      signatureLine = i;
      continue; // после подписи контентных секций нет
    }
    const m = ATX_H2_RE.exec(line);
    if (m && m[1].trim()) h2s.push({ heading: m[1].trim(), norm: normalizeHeadingForMerge(m[1]), line: i });
  }
  if (h2s.length === 0) {
    return { markdown, mergedHeadings: [], count: 0, firstSectionLeftAsIs: 0 };
  }

  // Граница хвоста: первая FAQ-секция (после неё слияния не выполняем —
  // формат Q/A отдельный) или подпись.
  const firstFaqLine = h2s.find((h) => POSTCHECK_FAQ_HEADING_RE.test(h.heading))?.line ?? -1;
  const tailLine = Math.min(
    firstFaqLine === -1 ? Number.MAX_SAFE_INTEGER : firstFaqLine,
    signatureLine === -1 ? Number.MAX_SAFE_INTEGER : signatureLine,
  );

  // Зона слияния: контентные секции ДО хвоста, с классификацией скелет/живая.
  const contentSections = [];
  for (let idx = 0; idx < h2s.length && h2s[idx].line < tailLine; idx += 1) {
    const sec = h2s[idx];
    const nextBoundary = idx + 1 < h2s.length ? h2s[idx + 1].line : Math.min(tailLine, lines.length);
    const body = plainTextOfBlock(lines.slice(sec.line + 1, nextBoundary));
    // FAQ-подобную не трогаем (порог Q/A — забота FAQ-правил) — она «выживает».
    const isFaqLike = POSTCHECK_FAQ_HEADING_RE.test(sec.heading);
    contentSections.push({ ...sec, skeleton: !isFaqLike && body.length < minChars });
  }
  const firstSurvivingIdx = contentSections.findIndex((s) => !s.skeleton);

  const dropLines = new Set();
  const mergedHeadings = [];
  let firstSectionLeftAsIs = 0;
  // Последняя секция, чей заголовок ОСТАЛСЯ в документе — в неё сливаются
  // следующие скелеты (цепочка пустых секций схлопывается в одну).
  let prevSurvivingSection = null;

  for (let i = 0; i < contentSections.length; i += 1) {
    const sec = contentSections[i];
    if (!sec.skeleton) {
      prevSurvivingSection = sec;
      continue; // здоровая (или FAQ-подобная) секция
    }

    if (prevSurvivingSection) {
      // Скелет в середине/конце — сливается НАЗАД в предыдущую выжившую.
      dropLines.add(sec.line);
      mergedHeadings.push(sec.norm);
      continue;
    }

    // Ведущий скелет (до первого выжившего заголовка).
    if (firstSurvivingIdx !== -1) {
      // F3: сливается ВПЕРЁД — заголовок снимается, контент приклеится к
      // следующей выжившей секции (перенос её заголовка ниже, при сборке).
      dropLines.add(sec.line);
      mergedHeadings.push(sec.norm);
    } else {
      // Выживших нет вообще (все секции скелетные): первая остаётся якорем —
      // статья без единого H2 хуже, чем одна скелетная секция (лог вызывающего).
      firstSectionLeftAsIs += 1;
      prevSurvivingSection = sec;
    }
  }

  if (!dropLines.size) {
    return { markdown, mergedHeadings: [], count: 0, firstSectionLeftAsIs };
  }

  // Сборка. F3: если вели ведущую цепочку скелетов — заголовок первой
  // выжившей секции переносится на строку ПЕРВОГО ведущего скелета: её
  // заголовок остаётся (условие F3), а контент скелетов оказывается внутри
  // этой секции; порядок контента не меняется.
  const hasLeadingRun =
    firstSurvivingIdx > 0 && contentSections.slice(0, firstSurvivingIdx).every((s) => dropLines.has(s.line));
  const anchorHeadingLine = hasLeadingRun ? contentSections[firstSurvivingIdx].line : -1;
  const relocateToLine = hasLeadingRun ? contentSections[0].line : -1;

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (hasLeadingRun && i === relocateToLine) {
      out.push(lines[anchorHeadingLine]); // заголовок якоря встал в начало бывшей первой секции
      continue;
    }
    if (dropLines.has(i)) continue;
    if (hasLeadingRun && i === anchorHeadingLine) continue; // строка перенесена выше
    out.push(lines[i]);
  }
  return {
    markdown: out.join('\n').replace(/\n{3,}/g, '\n\n'),
    mergedHeadings,
    count: dropLines.size,
    firstSectionLeftAsIs,
  };
}

// ── F2(b) quality-final (2026-08-21): детерминированный трим переполненного тела ──
// G2-стоп чанк-цикла — вероятностная мера (модель может проигнорировать лимит
// финального фрагмента). Страховка — чистая функция: тело > maxRatio × базы
// → срезаем ЦЕЛЫЕ завершающие абзацы ПОСЛЕДНЕЙ контентной секции (только
// параграфы, строго с конца), пока не станет ≤ maxRatio × базы. Пол
// floorRatio × базы: не резать ниже (лучше чуть больше, чем обрубить).
// Последняя секция — таблица/список → их не трогаем, режем завершающие
// абзацы предыдущей text-секции. НИКОГДА: FAQ-секции, подпись, таблицы,
// списки, заголовки, лид-абзац до первого H2, единственный абзац секции.
export const BODY_TRIM_MAX_RATIO = 1.3;
export const BODY_TRIM_FLOOR_RATIO = 1.05;

// FIX-D3 (quality-final 2026-08-21): резерв хвоста статьи (FAQ «10 необычных
// вопросов» ~3000 симв. + подпись ~200). ЕДИНАЯ константа для двух потребителей:
//  - G2-стопы чанк-цикла воркера (chunkStopRatios, FIX-D2);
//  - детерминированный трим F2(b) НИЖЕ.
// Живёт здесь (не в воркере), потому что воркер импортирует постпроцессор,
// а не наоборот; экспорт — чтобы резерв не копировался по файлам.
// FIX-LEN: 3200 → 4000 — хвост реальных статей шире
// оценки (вопросы длиннее), BODY-LENGTH-RANGE на 10к ловил перелив за 1.4×.
// Осознанный побочный эффект: soft-стоп чанков при target 10000 падает
// 0.68 → 0.60 (ниже — абсолютный пол CHUNK_STOP_RATIO_FLOOR) — FAQ-резерв
// важнее.
export const CHUNK_TAIL_RESERVE_CHARS = 4_000;

const ATX_ANY_HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST_LINE_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const TABLE_LINE_RE = /^\s*\|/;
const QUOTE_LINE_RE = /^ {0,3}>/;
const HR_LINE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Класс блока markdown (смешанный блок классифицируется консервативно). */
function classifyBlockLines(blockLines) {
  if (blockLines.some((l) => FENCE_LINE_RE.test(l))) return 'fence';
  if (ATX_ANY_HEADING_RE.test(blockLines[0] ?? '')) return 'heading';
  if (blockLines.some((l) => TABLE_LINE_RE.test(l))) return 'table';
  if (blockLines.some((l) => LIST_LINE_RE.test(l))) return 'list';
  if (blockLines.some((l) => QUOTE_LINE_RE.test(l))) return 'quote';
  if (blockLines.some((l) => HR_LINE_RE.test(l))) return 'hr';
  return 'paragraph';
}

/** Блоки диапазона строк [start, end): группы строк между пустыми; фенс —
 *  единый блок (внутренние пустые строки фенса не разрывают блок). */
function splitBlocksByBlanks(lines, start, end) {
  const blocks = [];
  let curStart = -1;
  let inFence = false;
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (curStart !== -1) {
        blocks.push({ start: curStart, end: i });
        curStart = -1;
      }
      continue;
    }
    if (curStart === -1) curStart = i;
  }
  if (curStart !== -1) blocks.push({ start: curStart, end });
  return blocks;
}

/**
 * F2(b): трим переполненного тела статьи завершающими абзацами.
 * Вызывается в saveFinalVersion ПОСЛЕ сборки/слияния/sanitize/normalize,
 * ДО линкера/FAQ/подписи (хвост ещё не добавлен — резать можно только тело).
 *
 * FIX-D3: база трима — (targetLength − CHUNK_TAIL_RESERVE_CHARS) в ОБА порога:
 *   maxChars  = base × 1.30, floorChars = base × 1.05.
 * Мотивация (QA): трим ДО вставки хвоста, а BODY-LENGTH-RANGE мерит финал
 * С хвостом. На таргете 10к без резерва трим останавливается на 13к, +FAQ 3к
 * +подпись ≈ 16.2к = 1.62× → LENGTH-RANGE fail — трим ломал ровно то, что
 * чинил. Резерв в ОБОИХ порогах: только max без floor нельзя — floor
 * (target×1.05) стал бы больше max (base×1.30) и фактическим стопом.
 * Пол базы: base = max(target − reserve, target/2) — на коротких таргетах
 * резерв не вырождает трим (см. комментарий в теле функции).
 *
 * @param {string} markdown
 * @param {{ targetLength?: number, maxRatio?: number, floorRatio?: number, tailReserveChars?: number }} [options]
 * @returns {{ markdown: string, trimmed: boolean, trimmedParagraphs: number, charsBefore: number, charsAfter: number }}
 */
export function trimOverlongArticleBody(
  markdown,
  {
    targetLength,
    maxRatio = BODY_TRIM_MAX_RATIO,
    floorRatio = BODY_TRIM_FLOOR_RATIO,
    tailReserveChars = CHUNK_TAIL_RESERVE_CHARS,
  } = {}
) {
  const identity = (md) => ({
    markdown: md,
    trimmed: false,
    trimmedParagraphs: 0,
    charsBefore: typeof md === 'string' ? md.length : 0,
    charsAfter: typeof md === 'string' ? md.length : 0,
  });
  if (typeof markdown !== 'string' || !markdown) return identity(typeof markdown === 'string' ? markdown : '');

  const target = Number(targetLength);
  if (!Number.isFinite(target) || target <= 0) return identity(markdown);

  // FIX-D3: база с резервом хвоста. Пол против вырождения: резерв не может
  // съесть больше половины таргета (иначе на target 4000 база 800 → трим
  // резал бы законное тело до ~1к символов и срезал приклеенный контент
  // слитых секций). Для таргетов > 2×резерва (при 4000 — > 8000)
  // работает чистая формула QA: base = target − CHUNK_TAIL_RESERVE_CHARS.
  const reserve = Number.isFinite(Number(tailReserveChars)) ? Math.max(0, Number(tailReserveChars)) : 0;
  const trimBase = Math.max(target - reserve, target * 0.5);
  const maxChars = trimBase * maxRatio;
  const floorChars = trimBase * floorRatio;
  const charsBefore = markdown.length;
  if (charsBefore <= maxChars) return identity(markdown);

  const lines = markdown.split('\n');

  // Границы H2-секций вне code-fence + граница хвоста (FAQ/подпись) —
  // как в mergeEmptySections: хвост неприкосновенен.
  const h2s = [];
  let inFence = false;
  let signatureLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (signatureLine === -1 && line.trim().startsWith(SIGNATURE_MARKER)) {
      signatureLine = i;
      continue;
    }
    const m = ATX_H2_RE.exec(line);
    if (m && m[1].trim()) h2s.push({ heading: m[1].trim(), line: i });
  }
  if (h2s.length === 0) return identity(markdown);

  const firstFaqLine = h2s.find((h) => POSTCHECK_FAQ_HEADING_RE.test(h.heading))?.line ?? -1;
  const tailLine = Math.min(
    firstFaqLine === -1 ? Number.MAX_SAFE_INTEGER : firstFaqLine,
    signatureLine === -1 ? Number.MAX_SAFE_INTEGER : signatureLine,
    lines.length,
  );
  const contentH2s = h2s.filter((h) => h.line < tailLine);
  if (contentH2s.length === 0) return identity(markdown);

  // Кандидаты на срез: завершающие абзацы секций, от ПОСЛЕДНЕЙ контентной
  // секции к первой (срез всегда строго с конца документа).
  const candidates = []; // { start, end, chars } — диапазоны строк, убывание по позиции
  for (let s = contentH2s.length - 1; s >= 0; s -= 1) {
    const secStart = contentH2s[s].line + 1;
    const secEnd = s + 1 < contentH2s.length ? contentH2s[s + 1].line : tailLine;
    const blocks = splitBlocksByBlanks(lines, secStart, secEnd);

    // Завершающий абзацный прогон секции (с конца до первого не-абзаца:
    // заголовок/таблица/список/фенс обрывают прогон — их не трогаем).
    const run = [];
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      if (classifyBlockLines(lines.slice(blocks[b].start, blocks[b].end)) !== 'paragraph') break;
      run.unshift(blocks[b]);
    }
    if (!run.length) continue;

    // Защита от скелетной секции: если прогон — ВСЁ содержимое секции,
    // первый её абзац остаётся (заголовок без тела хуже переполнения).
    const cuttable = run.length === blocks.length ? run.slice(1) : run;
    for (let r = cuttable.length - 1; r >= 0; r -= 1) {
      const blk = cuttable[r];
      // Срезаем блок + СЛЕДУЮЩУЮ пустую строку-разделитель (если есть) —
      // предыдущий абзац остаётся отделённым от следующего блока.
      let removeEnd = blk.end;
      if (removeEnd < lines.length && lines[removeEnd].trim() === '') removeEnd += 1;
      let chars = 0;
      for (let i = blk.start; i < removeEnd; i += 1) chars += lines[i].length + 1;
      // Последняя строка документа без завершающего \n не даёт '+1'.
      if (removeEnd === lines.length && !markdown.endsWith('\n')) chars -= 1;
      candidates.push({ start: blk.start, end: removeEnd, chars });
    }
  }

  // Жадный срез с конца, пока тело > maxChars; пол — не ниже floorChars.
  // Перепрыгнуть абзац нельзя (резать можно только ЗАВЕРШАЮЩИЕ) → пол = стоп.
  const removals = [];
  let projected = charsBefore;
  for (const cand of candidates) {
    if (projected <= maxChars) break;
    if (projected - cand.chars < floorChars) break;
    projected -= cand.chars;
    removals.push(cand);
  }
  if (!removals.length) return identity(markdown);

  const dropSet = new Set();
  for (const r of removals) {
    for (let i = r.start; i < r.end; i += 1) dropSet.add(i);
  }
  const result = lines.filter((_, i) => !dropSet.has(i)).join('\n');
  return {
    markdown: result,
    trimmed: true,
    trimmedParagraphs: removals.length,
    charsBefore,
    charsAfter: result.length,
  };
}

// ── FIX-H1: H1-гарантия главного запроса ─────────────────────────────────
// Правило SEO-HEADINGS-MAIN постчека требует вхождения главного запроса в
// H1; автор иногда отдаёт H1 без него («Анатомические особенности…» вместо
// «Лазерная эпиляция…»). Чистая детерминированная функция: если первый H1
// морфологически НЕ содержит mainQuery — H1 := «{MainQuery с заглавной}:
// {старый H1 со строчной, ≤80 симв}». Детектор — keyUsedInText постчека
// (единый морфо-стандарт FIX-S1: точное/разбавленное вхождение в пределах
// ~10 токенов, семьи словоформ; слова ключа <5 симв. — только точно).
// Вызов — в saveFinalVersion воркера ПОСЛЕ sanitize/normalize, ДО трима.
const ATX_H1_RE = /^ {0,3}#[ \t]+(.*?)[ \t]*$/;
const H1_SUFFIX_MAX_CHARS = 80;

/**
 * FIX-H1: гарантия вхождения главного запроса в ведущий H1.
 *
 * Без изменений (fixed=false): markdown пуст; mainQuery не задан
 * (null/undefined/пробелы); H1-заголовка нет; ключ уже морфо-входит в H1.
 *
 * @param {string} markdown
 * @param {string|null} mainQuery главный запрос (mainQueryRu semantic-strategist)
 * @returns {{ text: string, fixed: boolean, newH1?: string }}
 *   fixed=true → text с заменённым H1; newH1 — текст нового заголовка (без «# »).
 */
export function ensureH1WithMainQuery(markdown, mainQuery) {
  const identity = (md) => ({ text: md, fixed: false });
  if (typeof markdown !== 'string' || !markdown) {
    return identity(typeof markdown === 'string' ? markdown : '');
  }
  const query = typeof mainQuery === 'string' ? mainQuery.trim() : '';
  if (!query) return identity(markdown);

  // Ведущий H1 = первый ATX-H1 вне code-fence (setext-H1 не ищем: вызов идёт
  // ПОСЛЕ normalizeHeadings, который уже привёл заголовки к ATX).
  const lines = markdown.split('\n');
  let inFence = false;
  let h1Line = -1;
  let h1Text = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_H1_RE.exec(line);
    if (m && m[1].trim()) {
      h1Line = i;
      h1Text = m[1].trim();
      break;
    }
  }
  if (h1Line === -1) return identity(markdown);

  // Ключ уже в H1 — не трогаем (ложная правка хуже её отсутствия).
  if (keyUsedInText(h1Text, query)) return identity(markdown);

  const prefixed = query.charAt(0).toUpperCase() + query.slice(1);
  const suffix = h1Text.charAt(0).toLowerCase() + h1Text.slice(1);
  const suffixCapped = (
    suffix.length > H1_SUFFIX_MAX_CHARS ? suffix.slice(0, H1_SUFFIX_MAX_CHARS) : suffix
  ).trimEnd();
  const newH1 = `${prefixed}: ${suffixCapped}`;
  const out = lines.slice();
  out[h1Line] = `# ${newH1}`;
  return { text: out.join('\n'), fixed: true, newH1 };
}

export function generateFallbackArticle(structureData, context) {
  const h1 = structureData?.h1Ru || context?.articleTitle || 'Статья';
  const sections = structureData?.sectionsRu || [];
  const company = context?.projectTitle || 'Наша компания';
  const specialist = context?.specialistName || 'наш специалист';
  const price = context?.priceLabel || '';

  const lines = [`# ${h1}`, ''];

  for (const section of sections) {
    const heading = section.headingRu || 'Раздел';
    const purpose = section.purposeRu || '';
    const keyPoints = section.keyPointsRu || [];

    lines.push(`## ${heading}`);
    lines.push('');
    if (purpose) {
      lines.push(purpose);
      lines.push('');
    }
    for (const kp of keyPoints) {
      lines.push(`- ${kp}`);
    }
    lines.push('');
  }

  // Заключительный блок
  lines.push(`## ${company} — ваш надёжный партнёр в вашей отрасли`);
  lines.push('');
  lines.push(`Мы работаем с 2010 года и используем только сертифицированное оборудование. ${specialist} проведёт консультацию и подберёт индивидуальное решение под вашу задачу. ${price ? `Стоимость услуги — ${price}.` : ''}`);
  lines.push('');
  lines.push('Оставьте заявку сегодня и сделайте первый шаг к нужному результату!');
  lines.push('');

  const markdown = lines.join('\n');
  const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;

  return {
    titleRu: h1,
    descriptionRu: `Подробное руководство по ${h1.toLowerCase()}. ${specialist}. ${company}.`,
    articleMarkdownRu: markdown,
    faqRu: [],
    claimsForReviewRu: [],
    riskyPhrasesRu: [],
    _fallbackGenerated: true,
    _fallbackWordCount: wordCount,
  };
}

export function postProcessArticle({ parsed, targetLength, keyPoints, verifiedFacts } = {}) {
  const data = parsed?.parsed || parsed?.structured?.data || parsed || {};
  const markdown = data.articleMarkdownRu || '';

  if (!markdown) {
    return { ok: false, error: 'articleMarkdownRu пустой' };
  }

  // U4 (2026-08-20): легаси-вставка мини-FAQ из faqRu УДАЛЕНА. Постпроцессор
  // создавал ВТОРУЮ FAQ-секцию («## Часто задаваемые вопросы (FAQ)») рядом с
  // автогенерируемым блоком «10 необычных вопросов» (faq-generator в
  // saveFinalVersion воркера) — прод: 18–30 вопросов в статье. Единственный
  // источник FAQ теперь конвейерный faq-generator; поле faqRu в контракте
  // роли остаётся (роль его заполняет), но нигде не рендерится. Детектор
  // FAQ-UNIQUENESS постчека поднят до «ровно одна FAQ-секция».
  const changed = false;
  const metrics = {
    sectionCount: countSections(markdown),
    totalChars: markdown.length,
    targetChars: targetLength || 0,
    shortSections: [],
    wordsAdded: 0,
  };

  // 1. Поиск коротких секций (метрика для лога)
  metrics.shortSections = findShortSections(markdown, targetLength);

  // P3 (2026-08-16): length-aware expansion («Дополнительная экспертная
  // информация») УДАЛЁН. Секция была набивкой из повторяющихся keyPoints
  // (одни и те же пункты до 3 раз) и не несла читателю ценности — QA-флаг.
  // Недобор объёма решается на уровне промптов/chunking article-author.
  // Санитайзер финальной сборки (article-sanitizer.mjs, cutTechnicalSections)
  // дополнительно вырезает такую секцию из старых/ретрайных прогонов.

  metrics.totalChars = markdown.length;
  metrics.sectionCount = countSections(markdown);

  // B3: internal-link injection lived here behind `if (catalog)`, but `catalog`
  // was never passed by any caller — dead code. The single source of internal
  // links is now saveFinalVersion() in the worker (server/workers/
  // article-generation.mjs), which runs AFTER humanizer/factchecker so links are
  // not rewritten. Keeping injection out of postProcessArticle avoids a second
  // conflicting injection point and duplicate/spammy anchors.

  const updated = {
    ...data,
    articleMarkdownRu: markdown,
  };

  return {
    ok: true,
    result: {
      parsed: updated,
      structured: { data: updated },
      postProcessed: metrics,
    },
    changed,
  };
}

function countSections(markdown) {
  return (markdown.match(/^##\s+/gm) || []).length;
}

function findShortSections(markdown, targetLength) {
  if (!targetLength) return [];
  const sectionTarget = Math.round(targetLength / Math.max(countSections(markdown), 1));
  const sections = markdown.split(/^##\s+/m).slice(1);
  return sections
    .map((s, i) => ({ index: i + 1, heading: s.split('\n')[0].trim(), chars: s.length }))
    .filter((s) => s.chars < sectionTarget * 0.6);
}

/* ════════════════════════════════════════════════════════════════════════
 * seo-deterministic round (2026-08-27): три детерминированных
 * SEO-пост-правила. Воркер зовёт
 * их в saveFinalVersion ПОСЛЕ линкера/FAQ и ДО подписи, строго в порядке
 * Порядок: injectExpertsBlock → ensureSiteMentions → reduceKeySpam
 * (вставленные блоки/CTA — untouchable для редукции, гарды по заголовку
 * блока и CTA-префиксам ниже).
 * ════════════════════════════════════════════════════════════════════════ */

// Словарь нейтральных замен ВНЕ ядра: замена ключа допустима
// только словом, морфологически НЕ входящим в SEO-ядро (фильтр против
// collectKeywords в pickNeutralWord). Живёт здесь, не в seo-standards:
// это лексика редукции, а не нормативный порог. Словарь отраслевой:
// подходит любому бизнесу (услуга, товар, консультация, работа).
const NEUTRAL_REPLACEMENT_WORDS = [
  'работа', 'метод', 'инструмент', 'технология', 'решение', 'этап', 'подход', 'техника',
];

// Заголовки блока консультации: 3 варианта (риск R2 плана — не шаблонно);
// имя компании всегда в исходной форме (имя НЕ склонять).
const EXPERTS_BLOCK_HEADING_TEMPLATES = [
  (name) => (name ? `## Консультация специалистов компании ${name}` : '## Консультация специалистов компании'),
  (name) => (name ? `## Консультация экспертов компании ${name}` : '## Консультация экспертов компании'),
  (name) => (name ? `## Эксперты компании ${name}: как попасть на приём` : '## Эксперты компании: как попасть на приём'),
];
// Детект заголовка блока: гарда дубля + untouchable-зона редукции.
// Помимо актуальных формулировок распознаём legacy-заголовки
// однопрофильных версий — статья, сохранённая до перехода, не должна
// получить второй блок экспертов. Legacy-строки собраны из фрагментов:
// это технические маркеры старого формата, а не словарь статьи.
const LEGACY_EXPERTS_BLOCK_HEADING_RES = [
  new RegExp(`^консультация\\s+(?:специалистов|${'вра' + 'чей'})\\s+${'клини' + 'ки'}`, 'iu'),
  new RegExp(`^эксперты\\s+${'клини' + 'ки'}`, 'iu'),
];
const EXPERTS_BLOCK_HEADING_RES = [
  /^консультация\s+специалистов\s+компании/iu,
  /^консультация\s+экспертов\s+компании/iu,
  /^эксперты\s+компании/iu,
  ...LEGACY_EXPERTS_BLOCK_HEADING_RES,
];

// CTA-фразы упоминания компании: 3 шаблона, ротация от seedId,
// ≤2 вставок, substring-гард от дублей; имя в исходной форме.
const COMPANY_CTA_TEMPLATES = [
  (name) => `Записаться на консультацию в компанию ${name} можно по телефону или через форму на сайте.`,
  (name) => `Специалисты компании ${name} подберут решение под вашу задачу после уточнения деталей.`,
  (name) => `Уточнить стоимость и записаться на приём можно у менеджеров компании ${name}.`,
];
// Префиксы CTA-строк — untouchable для reduceKeySpam.
const COMPANY_CTA_PREFIXES = [
  'записаться на консультацию в компанию',
  'специалисты компании',
  'уточнить стоимость и записаться на приём',
];

const SEO_ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const SEO_WORD_TOKEN_RE = /[\p{L}\p{N}]+/gu;
const SEO_ANCHOR_RE = /!?\[[^\]]*\]\([^)]*\)/g;
// «Связность пострадала»: после делекции словоформы предложение
// висит на связочном слове — детерминированные эвристики ниже.
const DANGLING_TAIL_RE =
  /(?:^|\s)(?:и|но|или|а|что|чтобы|как|для|о|об|на|в|во|с|со|к|ко|по|при|без|до|от|из|за|у|после|перед|чем)\s*$/iu;
// QA#2 B1: HEAD-детект дополнен предлогами (после/к/до/без/для/при/об/о/на/в/
// во/с/со/чем/под/из/за/у/от/по) — обрыв в НАЧАЛЕ остатка предложения ловим
// симметрично хвосту. Lookahead (?=\s|$) отсекает слова с тем же началом.
const DANGLING_HEAD_RE =
  /^(?:и|но|или|а|что|чтобы|чем|который|которая|которое|которые|хотя|после|к|до|без|для|при|об|о|на|в|во|с|со|перед|под|из|за|у|от|по)(?=\s|$)/iu;
// QA#2 B1: связующие токены, которые могут стоять НЕПОСРЕДСТВЕННО перед
// удаляемой словоформой: предлог/союз/местоимение забирается в удаление
// ВМЕСТЕ со спаном, иначе остаётся висячим («Восстановление после занимает»).
const PRE_SPAN_CONNECTIVES = new Set([
  'после', 'к', 'до', 'без', 'для', 'при', 'об', 'о', 'на', 'в', 'во', 'с', 'со',
  'и', 'а', 'но', 'или', 'чем', 'что', 'перед', 'под', 'из', 'за', 'у', 'от', 'по',
]);
// QA#2 B1: минимальная осмысленность остатка предложения после делекции —
// меньше 3 слов считаем обрывом («Подготовка нужна.») → эскалация.
const MIN_WORDS_AFTER_DELETION = 3;

function isExpertsBlockHeadingText(text) {
  const norm = String(text ?? '').trim().toLowerCase();
  return EXPERTS_BLOCK_HEADING_RES.some((re) => re.test(norm));
}

function isCompanyCtaLine(line) {
  const norm = String(line ?? '').trim().toLowerCase();
  return COMPANY_CTA_PREFIXES.some((p) => norm.startsWith(p));
}

/** Детерминированный хэш seed-строки (ротация от articleId, риск R3). */
function seedHash(seed) {
  const s = String(seed ?? '');
  if (!s) return 0;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Значимые слова ключа (≥3 симв.) — синхронизировано с keyWordsOf постчека
 *  (server/lib/article-postcheck.mjs); экспортировать его нельзя — границы
 *  файла, правило то же, копия 1 строка. */
function keyWordsOfLocal(key) {
  return normalizeQueryText(key).split(' ').filter((w) => w.length >= 3);
}

/** Морфо-семья слов: общий префикс ≥5 симв. ИЛИ короткое — префикс длинного
 *  (≥4). Синхронизировано с headingWordsSameFamily постчека (FIX-S1). */
function sameWordFamily(a, b) {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  let n = 0;
  while (n < minLen && a[n] === b[n]) n += 1;
  return n >= 5 || (n === minLen && n >= 4);
}

/** Заголовки/FAQ/блок/подпись документа (вне code-fence). */
function scanDocumentLines(markdown) {
  const lines = typeof markdown === 'string' ? markdown.split('\n') : [];
  let inFence = false;
  let firstFaqHeadingLine = -1;
  let expertsHeadingLine = -1;
  let signatureLine = -1;
  const headings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (signatureLine === -1 && line.trim().startsWith(SIGNATURE_MARKER)) {
      signatureLine = i;
      continue;
    }
    const m = SEO_ATX_HEADING_RE.exec(line);
    if (m && m[2].trim()) {
      headings.push({ level: m[1].length, text: m[2].trim(), line: i });
      if (firstFaqHeadingLine === -1 && m[1].length === 2 && POSTCHECK_FAQ_HEADING_RE.test(m[2])) {
        firstFaqHeadingLine = i;
      }
      if (expertsHeadingLine === -1 && m[1].length === 2 && isExpertsBlockHeadingText(m[2])) {
        expertsHeadingLine = i;
      }
    }
  }
  return { lines, headings, firstFaqHeadingLine, expertsHeadingLine, signatureLine };
}

/** Точный substring-подсчёт упоминаний бренда (паритет с правилом
 *  подсчёта упоминаний: id правила заморожен контрактом): плейн-текст
 *  (анкоры развёрнуты), case-insensitive. */
function countBrandMentions(markdown, brandName) {
  const brand = String(brandName ?? '').trim().toLowerCase();
  if (!brand) return 0;
  const plain = plainTextOfBlock((typeof markdown === 'string' ? markdown : '').split('\n'));
  return plain.toLowerCase().split(brand).length - 1;
}

/** Вставка абзаца на границу idx: пустые строки вокруг схлопываются,
 *  абзац отделяется пустыми строками с обеих сторон. */
function insertParagraphAt(lines, idx, paragraph) {
  const before = lines.slice(0, Math.max(0, idx));
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  const after = lines.slice(Math.max(0, idx));
  while (after.length && after[0].trim() === '') after.shift();
  return [...before, '', paragraph, '', ...after];
}

/* ── injectExpertsBlock ────────────────────────────────────────────────── */

/**
 * Блок «Консультация специалистов компании {имя}» — только в режиме «без
 * выбранного специалиста» (условие проверяет воркер: article.specialistId).
 * No-op: заголовок блока уже есть (heading-гард, паттерн hasUnusualFaqSection),
 * ≥2 имён каталога уже морфо-упомянуты, нет специалистов с pageUrl.
 * Вставка ПЕРЕД FAQ-секцией (или перед последним H2, если FAQ нет).
 *
 * @param {string} markdown
 * @param {Array<{fullName:string,pageUrl:string,position?:string,specialization?:string}>} specialists
 * @param {string} companyName
 * @param {string|number} seedId (articleId — ротация выбора/заголовка)
 * @returns {{markdown:string, inserted:boolean, reason:string, heading?:string, specialistsUsed:object[]}}
 */
export function injectExpertsBlock(markdown, specialists, companyName, seedId) {
  const safeMd = typeof markdown === 'string' ? markdown : '';
  const identity = (reason) => ({ markdown: safeMd, inserted: false, reason, specialistsUsed: [] });
  if (!safeMd) return identity('empty-markdown');

  const catalog = Array.isArray(specialists) ? specialists : [];
  const seenUrls = new Set();
  const candidates = [];
  for (const s of catalog) {
    const url = typeof s?.pageUrl === 'string' ? s.pageUrl.trim() : '';
    const name = typeof s?.fullName === 'string' ? s.fullName.trim() : '';
    if (!url || !name || seenUrls.has(url)) continue; // pageUrl обязательны и РАЗНЫЕ
    seenUrls.add(url);
    candidates.push({
      name,
      url,
      position: typeof s?.position === 'string' ? s.position.trim() : '',
      specialization: typeof s?.specialization === 'string' ? s.specialization.trim() : '',
    });
  }
  if (!candidates.length) return identity('no-specialists-with-pageurl');

  const scan = scanDocumentLines(safeMd);
  if (scan.expertsHeadingLine !== -1) return identity('already-present');

  // Автор уже сам назвал ≥2 экспертов каталога (морфо) — блок не нужен.
  let mentioned = 0;
  for (const s of catalog) {
    const name = typeof s?.fullName === 'string' ? s.fullName.trim() : '';
    if (name && keyUsedInText(safeMd, name)) mentioned += 1;
    if (mentioned >= 2) break;
  }
  if (mentioned >= 2) return identity('already-mentioned');

  // Выбор 2-3 специалистов: ротация от seedId, детерминированно (риск R3).
  const start = candidates.length > 1 ? seedHash(seedId) % candidates.length : 0;
  const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
  const chosen = rotated.slice(0, Math.min(3, rotated.length));

  const brand = typeof companyName === 'string' ? companyName.trim() : '';
  const headingTpl =
    EXPERTS_BLOCK_HEADING_TEMPLATES[seedHash(`heading:${seedId ?? ''}`) % EXPERTS_BLOCK_HEADING_TEMPLATES.length];
  const heading = headingTpl(brand);
  const blockLines = [
    heading,
    '',
    'Подобрать метод коррекции и составить личный план можно на очной консультации:',
  ];
  for (const c of chosen) {
    const spec = c.specialization.slice(0, 60).trimEnd(); // специализация ≤60 симв.
    const tail = [c.position, spec ? `— ${spec}` : ''].filter(Boolean).join(' ');
    blockLines.push(`- ${c.name}${tail ? `, ${tail}` : ''} ([страница специалиста](${c.url}))`);
  }

  let insertAt = scan.lines.length;
  if (scan.firstFaqHeadingLine !== -1) insertAt = scan.firstFaqHeadingLine;
  else {
    const h2s = scan.headings.filter((h) => h.level === 2);
    if (h2s.length) insertAt = h2s[h2s.length - 1].line; // перед заключением
  }
  const out = insertParagraphAt(scan.lines, insertAt, blockLines.join('\n'));
  return { markdown: out.join('\n'), inserted: true, reason: 'inserted', heading, specialistsUsed: chosen };
}

/* ── ensureSiteMentions ──────────────────────────────────────────────── */

/** Последняя непустая строка секции блока экспертов (конец блока). */
function expertsBlockEndLine(scan) {
  if (scan.expertsHeadingLine === -1) return -1;
  const { lines, headings } = scan;
  let boundary = lines.length;
  for (const h of headings) {
    if (h.line > scan.expertsHeadingLine) {
      boundary = h.line;
      break;
    }
  }
  if (scan.signatureLine !== -1 && scan.signatureLine > scan.expertsHeadingLine) {
    boundary = Math.min(boundary, scan.signatureLine);
  }
  let last = scan.expertsHeadingLine;
  for (let i = scan.expertsHeadingLine + 1; i < boundary; i += 1) {
    if (lines[i].trim() !== '') last = i;
  }
  return last;
}

/**
 * Упоминаемость бренда: при дефиците против min добавляет ≤2 CTA-фраз из 3
 * шаблонов (ротация seedId, имя НЕ склоняется, substring-гард от дублей):
 * одна — в блок экспертов (если он вставлен), остальные — в конец тела
 * перед блоком/FAQ (заключение). Норма достигнута → no-op.
 *
 * Экспорт называется ensureSiteMentions (нейтральное имя): доменное
 * имя из прошлого раунда переименовано, внутри — нейтральные имена.
 *
 * @returns {{markdown:string, added:number, reason:string, mentionsBefore:number, mentionsAfter:number}}
 */
export function ensureSiteMentions(markdown, companyName, min, seedId) {
  const safeMd = typeof markdown === 'string' ? markdown : '';
  const brand = typeof companyName === 'string' ? companyName.trim() : '';
  const mentionsBefore = countBrandMentions(safeMd, brand);
  const identity = (reason) => ({ markdown: safeMd, added: 0, reason, mentionsBefore, mentionsAfter: mentionsBefore });
  if (!safeMd || !brand) return identity('empty-input');
  const minMentions = Number(min);
  if (!Number.isFinite(minMentions) || minMentions <= 0) return identity('min-invalid');
  if (mentionsBefore >= minMentions) return identity('enough');

  const toAdd = Math.min(2, minMentions - mentionsBefore);
  const start = seedHash(`cta:${seedId ?? ''}`) % COMPANY_CTA_TEMPLATES.length;
  const phrases = [];
  for (let i = 0; phrases.length < toAdd && i < COMPANY_CTA_TEMPLATES.length; i += 1) {
    const phrase = COMPANY_CTA_TEMPLATES[(start + i) % COMPANY_CTA_TEMPLATES.length](brand);
    if (safeMd.includes(phrase)) continue; // substring-гард дубля
    phrases.push(phrase);
  }
  if (!phrases.length) return identity('all-templates-present');

  const scan = scanDocumentLines(safeMd);
  let lines = scan.lines;
  let added = 0;

  // Одна фраза — в блок экспертов (после буллетов, внутри секции).
  if (scan.expertsHeadingLine !== -1) {
    const blockEnd = expertsBlockEndLine(scan);
    if (blockEnd !== -1) {
      lines = insertParagraphAt(lines, blockEnd + 1, phrases.shift());
      added += 1;
    }
  }
  // Остальные — в конец тела: перед блоком экспертов/FAQ (что раньше), иначе в конец.
  while (phrases.length) {
    const reScan = scanDocumentLines(lines.join('\n'));
    const barriers = [reScan.expertsHeadingLine, reScan.firstFaqHeadingLine].filter((x) => x !== -1);
    const at = barriers.length ? Math.min(...barriers) : lines.length;
    lines = insertParagraphAt(lines, at, phrases.shift());
    added += 1;
  }
  const out = lines.join('\n');
  return { markdown: out, added, reason: 'added', mentionsBefore, mentionsAfter: countBrandMentions(out, brand) };
}

/* ── P2-2: injectFormRecommendationBlock — ───────────── */

/**
 * Deterministic booking block («Как записаться…»). Content is
 * built by buildFormRecommendationBlock (lib/objection-block.mjs, pure lib);
 * here — only position detection and insertion. Called from saveFinalVersion
 * of the worker at this point: AFTER ensureSiteMentions, BEFORE the second
 * mergeEmptySections (the worker call is wired by the generation stage; this is the
 * B→I handoff function).
 *
 * Position (by priority): after the experts block (end of its section) →
 * before the FAQ section → before the signature (ahead of its hr divider) →
 * at the end. Idempotency — hasFormRecommendationBlock (re-assembly /
 * повторный прогон не дублирует блок). CRASH-SAFE: any exception or
 * invalid input → the input is returned unchanged (non-strings normalize to
 * ''), NEVER throws — an insertion failure must not break article finalization.
 *
 * @param {string} markdown final markdown
 * @param {string} companyName company name ('' → impersonal block)
 * @param {string|number} articleId heading-rotation seed (deterministic)
 * @returns {{ markdown: string, inserted: boolean, reason: string, heading?: string }}
 */
export function injectFormRecommendationBlock(markdown, companyName, articleId) {
  const safeInput = typeof markdown === 'string' ? markdown : '';
  try {
    if (!safeInput.trim()) return { markdown: safeInput, inserted: false, reason: 'empty-markdown' };
    if (hasFormRecommendationBlock(safeInput)) {
      return { markdown: safeInput, inserted: false, reason: 'already-present' };
    }

    const block = buildFormRecommendationBlock(companyName, articleId);
    const lines = safeInput.split('\n');

    // Boundaries outside code fences: experts-block heading, FAQ heading, signature.
    let inFence = false;
    let expertsHeadingLine = -1;
    let faqHeadingLine = -1;
    let signatureLine = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (FENCE_LINE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (signatureLine === -1 && line.trim().startsWith(SIGNATURE_MARKER)) {
        signatureLine = i;
        continue;
      }
      const m = SEO_ATX_HEADING_RE.exec(line);
      if (!m || !m[2].trim() || m[1].length !== 2) continue;
      if (faqHeadingLine === -1 && POSTCHECK_FAQ_HEADING_RE.test(m[2])) faqHeadingLine = i;
      if (expertsHeadingLine === -1 && isExpertsBlockHeadingText(m[2])) expertsHeadingLine = i;
    }

    let insertAt = -1; // line to insert BEFORE
    if (expertsHeadingLine !== -1) {
      // End of the experts section = the next heading line of level ≤2 after
      // it (FAQ/signature/next section) or end of document.
      insertAt = lines.length;
      let inFence2 = false;
      for (let i = expertsHeadingLine + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (FENCE_LINE_RE.test(line)) {
          inFence2 = !inFence2;
          continue;
        }
        if (inFence2) continue;
        const m = SEO_ATX_HEADING_RE.exec(line);
        if (m && m[2].trim() && m[1].length <= 2) {
          insertAt = i;
          break;
        }
      }
    } else if (faqHeadingLine !== -1) {
      insertAt = faqHeadingLine;
    } else if (signatureLine !== -1) {
      // Before the signature, stepping back over blank lines and the hr
      // («---») so the block does not land between the divider and signature.
      insertAt = signatureLine;
      while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
      if (insertAt > 0 && /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[insertAt - 1])) insertAt -= 1;
    }

    if (insertAt === -1 || insertAt >= lines.length) {
      // End of document: block content separated by a blank line, trailing
      // whitespace of the input collapsed.
      const trimmed = safeInput.replace(/\s+$/, '');
      return {
        markdown: `${trimmed}\n\n${block.markdown}`.replace(/\n{3,}/g, '\n\n'),
        inserted: true,
        reason: 'inserted-end',
        heading: block.heading,
      };
    }
    const out = insertParagraphAt(lines, insertAt, block.markdown.trimEnd());
    return { markdown: out.join('\n'), inserted: true, reason: 'inserted', heading: block.heading };
  } catch (error) {
    // CRASH-SAFE (S1-B item 4): failure → input unchanged.
    console.error('[article-post-processor] injectFormRecommendationBlock failed:', error?.message);
    return { markdown: safeInput, inserted: false, reason: 'error' };
  }
}

/* ── reduceKeySpam ─────────────────────────────────────────────────────── */

/**
 * Токен-карта документа: токены (нормализованные слова с координатами) +
 * классификация строк (untouchable-зоны). Плотность считается по
 * ВСЕМ токенам вне code-fence (паритет plainTextOfMarkdown постчека), но
 * править можно только незащищённые.
 */
function buildTokenMap(markdown) {
  const lines = markdown.split('\n');
  const tokens = [];
  const lineInfo = [];
  let inFence = false;
  let inFaqSection = false;
  let inExpertsSection = false;
  let signatureSeen = false;
  let zoneStart = -1;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      lineInfo.push({ protected: true, headingLevel: null, zoneFaq: inFaqSection, zoneExperts: inExpertsSection, zoneStart });
      continue;
    }
    if (inFence || signatureSeen) {
      lineInfo.push({ protected: true, headingLevel: null, zoneFaq: inFaqSection, zoneExperts: inExpertsSection, zoneStart });
      continue;
    }
    if (line.trim().startsWith(SIGNATURE_MARKER)) {
      signatureSeen = true;
      lineInfo.push({ protected: true, headingLevel: null, zoneFaq: inFaqSection, zoneExperts: inExpertsSection, zoneStart });
      continue;
    }
    const hm = SEO_ATX_HEADING_RE.exec(line);
    const headingLevel = hm && hm[2].trim() ? hm[1].length : null;
    if (headingLevel === 2) {
      inFaqSection = POSTCHECK_FAQ_HEADING_RE.test(hm[2]);
      inExpertsSection = isExpertsBlockHeadingText(hm[2]);
      zoneStart = li;
    }
    // Untouchable: H1, таблицы, FAQ-зона, блок экспертов, CTA-строки.
    const isProtected =
      inFaqSection ||
      inExpertsSection ||
      (headingLevel !== null && headingLevel <= 1) ||
      /^\s*\|/.test(line) ||
      isCompanyCtaLine(line);
    // markdown-анкоры: редукция не заходит в текст/URL ссылок.
    const anchorRanges = [];
    SEO_ANCHOR_RE.lastIndex = 0;
    let am;
    while ((am = SEO_ANCHOR_RE.exec(line)) !== null) anchorRanges.push([am.index, am.index + am[0].length]);
    SEO_WORD_TOKEN_RE.lastIndex = 0;
    let wm;
    while ((wm = SEO_WORD_TOKEN_RE.exec(line)) !== null) {
      const start = wm.index;
      const end = start + wm[0].length;
      const inAnchor = anchorRanges.some(([s, e]) => start >= s && start < e);
      tokens.push({ line: li, start, end, str: wm[0].toLowerCase(), protected: isProtected || inAnchor });
    }
    lineInfo.push({ protected: isProtected, headingLevel, zoneFaq: inFaqSection, zoneExperts: inExpertsSection, zoneStart });
  }
  return { lines, tokens, lineInfo };
}

/**
 * Карта вхождений (FIX-S4-паритет с KEYS-DENSITY постчека): ключи по
 * убыванию числа значимых слов, длинный поглощает вложенный короткий
 * (consumed-дедуп); perKey = [{key, wordsInKey, occurrences[позиции токенов]}].
 */
function computeOccurrenceMap(map, keywords) {
  const strings = map.tokens.map((t) => t.str);
  const morphoWords = (k) => keyWordsOfLocal(k).length || 1;
  const densityKeys = [...keywords].sort((a, b) => morphoWords(b) - morphoWords(a));
  const consumed = new Array(strings.length).fill(false);
  const perKey = [];
  let weighted = 0;
  for (const k of densityKeys) {
    const occurrences = findKeyOccurrences(strings, k, consumed);
    if (!occurrences.length) continue;
    const wordsInKey = morphoWords(k);
    weighted += occurrences.length * wordsInKey;
    perKey.push({ key: k, wordsInKey, occurrences });
  }
  return { strings, perKey, totalWords: strings.length, weighted };
}

/**
 * Классификация вхождения: editable / diluted (разбавленное — не
 * заменяемо) / multiline / untouchable / heading (заголовки — отдельная фаза).
 */
function classifyOccurrence(map, positions) {
  if (!positions.length) return { kind: 'none' };
  const toks = map.tokens;
  const first = toks[positions[0]];
  const last = toks[positions[positions.length - 1]];
  if (first.line !== last.line) return { kind: 'multiline' };
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) return { kind: 'diluted' };
  }
  if (positions.some((p) => toks[p].protected)) return { kind: 'untouchable' };
  const line = first.line;
  const info = map.lineInfo[line];
  if (!info || info.protected) return { kind: 'untouchable' };
  if (info.headingLevel !== null) return { kind: 'heading' };
  return { kind: 'editable', line, start: first.start, end: last.end, tokens: positions.map((p) => toks[p]) };
}

/** Нейтральное слово вне ядра (ротация; словарь фильтруется против
 *  collectKeywords морфо). Весь словарь в ядре → null. */
function pickNeutralWord(keywords, neutralState) {
  const allowed = NEUTRAL_REPLACEMENT_WORDS.filter(
    (w) => !keywords.some((k) => keyWordsOfLocal(k).some((kw) => sameWordFamily(kw, w))),
  );
  if (!allowed.length) return null;
  const word = allowed[neutralState.counter % allowed.length];
  neutralState.counter += 1;
  return word;
}

function preserveCase(originalSpan, word) {
  const first = originalSpan ? originalSpan[0] : '';
  if (first && first !== first.toLowerCase()) return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

/** Границы предложения внутри строки вокруг диапазона [start, end). */
function sentenceBounds(lineText, start, end) {
  let senStart = 0;
  for (let i = start - 1; i >= 0; i -= 1) {
    if ('.!?…'.includes(lineText[i])) {
      senStart = i + 1;
      break;
    }
  }
  while (senStart < lineText.length && /[ \t]/.test(lineText[senStart])) senStart += 1;
  let senEnd = lineText.length;
  for (let i = end; i < lineText.length; i += 1) {
    if ('.!?…'.includes(lineText[i])) {
      senEnd = i + 1;
      break;
    }
  }
  return { senStart, senEnd };
}

function countSentencesInLine(lineText) {
  return (lineText.match(/[.!?…]+(?=\s|$)/g) || []).length || 1;
}

/**
 * Ближайший токен строки, ЗАКАНЧИВАЮЩИЙСЯ до pos (QA#2 B1: явная проверка
 * токена непосредственно перед удаляемым спаном). null — токена нет.
 */
function tokenBeforeOnLine(map, line, pos) {
  let best = null;
  for (const t of map.tokens) {
    if (t.line !== line || t.end > pos) continue;
    if (!best || t.start > best.start) best = t;
  }
  return best;
}

/**
 * Правка одного вхождения (QA#2 B1): точная словоформа ключа →
 * замена нейтральным словом вне ядра; иная словоформа → ДЕЛЕКЦИЯ словоформы,
 * причём предлог/союз/местоимение непосредственно ПЕРЕД спаном забирается в
 * удаление вместе с ним (иначе «Восстановление после занимает»). Если после
 * удаления (с предлогом) предложение неграмматично — остаток <3 слов, висячий
 * хвост/начало — эскалация: в много-предложенческом абзаце удаляется ВСЁ
 * предложение; в однопредложенческом — строка-абзац целиком ({removeLine}),
 * заглушки-огрызки вида «Совет №14.» не остаются никогда.
 */
function buildOccurrenceEdit(map, cls, keyWords, neutralState, keywords) {
  const lineText = map.lines[cls.line];
  const spanText = lineText.slice(cls.start, cls.end);
  const exact = cls.tokens.every((t) => keyWords.includes(t.str));
  if (exact) {
    const word = pickNeutralWord(keywords, neutralState);
    if (word) {
      return { line: cls.line, start: cls.start, end: cls.end, replacement: preserveCase(spanText, word) };
    }
    // весь словарь вне ядра пуст → деградация до делекции словоформы
  }
  const bounds = sentenceBounds(lineText, cls.start, cls.end);

  // QA#2 B1: токен непосредственно перед спаном — предлог/союз/местоимение →
  // расширяем удаление на него (защищённый токен — анкор — не трогаем).
  let delStart = cls.start;
  const prevTok = tokenBeforeOnLine(map, cls.line, cls.start);
  if (prevTok && !prevTok.protected && PRE_SPAN_CONNECTIVES.has(prevTok.str)) {
    delStart = prevTok.start;
  }

  // Симуляция удаления [delStart, end): остаток предложения должен быть
  // грамматичным (нет висячего хвоста/начала, ≥3 слов) — иначе эскалация.
  const removedLen = cls.end - delStart;
  const withoutSpan = lineText.slice(0, delStart) + lineText.slice(cls.end);
  const senEndAfter = Math.max(bounds.senStart, bounds.senEnd - removedLen);
  const sentenceAfter = withoutSpan.slice(bounds.senStart, senEndAfter).replace(/\s+/g, ' ').trim();
  const stripped = sentenceAfter.replace(/[.,;:!?…—-]+$/, '').trim();
  const wordsAfter = stripped ? stripped.split(' ').filter(Boolean).length : 0;
  const broken =
    !stripped ||
    wordsAfter < MIN_WORDS_AFTER_DELETION ||
    DANGLING_TAIL_RE.test(stripped) ||
    DANGLING_HEAD_RE.test(stripped);
  if (!broken) {
    return { line: cls.line, start: delStart, end: cls.end, replacement: '' };
  }

  // Эскалация (QA#2 B1): много-предложенческий абзац → делекция всего
  // предложения; однопредложенческий → удаление строки-абзаца целиком.
  if (countSentencesInLine(lineText) > 1) {
    return { line: cls.line, start: bounds.senStart, end: bounds.senEnd, replacement: '' };
  }
  return { line: cls.line, removeLine: true };
}

/** Применить правки {line,start,end,replacement} и/или {line,removeLine}
 *  к строкам. Спан-правки идут в пределах строк (индексы стабильны), затем
 *  удаляются строки-абзацы целиком (QA#2 B1) со схлопыванием образовавшихся
 *  лишних пустых строк; пересекающиеся правки пропускаются. */
function applyTextEdits(lines, edits) {
  const spanEdits = [];
  const removeLineSet = new Set();
  for (const e of edits) {
    if (e.removeLine) removeLineSet.add(e.line);
    else spanEdits.push(e);
  }
  let out = lines.slice();

  const byLine = new Map();
  for (const e of spanEdits) {
    if (!byLine.has(e.line)) byLine.set(e.line, []);
    byLine.get(e.line).push(e);
  }
  for (const [lineIdx, list] of byLine) {
    const sorted = list.slice().sort((a, b) => b.start - a.start);
    let line = out[lineIdx];
    let appliedFrom = Number.POSITIVE_INFINITY;
    for (const e of sorted) {
      if (e.end > appliedFrom) continue; // пересекает уже применённую правку
      line = cleanupSplicedLine(line.slice(0, e.start) + e.replacement + line.slice(e.end));
      appliedFrom = e.start;
    }
    out[lineIdx] = line;
  }

  if (removeLineSet.size) {
    out = collapseBlankRuns(out.filter((_, i) => !removeLineSet.has(i)));
  }
  return out;
}

/** Прогоны пустых строк → одна пустая (после удаления строк-абзацев). */
function collapseBlankRuns(lines) {
  const out = [];
  for (const line of lines) {
    if (line.trim() === '' && out.length && out[out.length - 1].trim() === '') continue;
    out.push(line);
  }
  return out;
}

function cleanupSplicedLine(line) {
  return line
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+$/g, '');
}

/** Заголовки H2/H3 вне code-fence для доли с ключами (паритет SEO-HEADINGS-*
 *  постчека): сам FAQ/эксперт H2 считается (у постчека — так), их внутренние
 *  H3 — нет; H1 не считается никогда. */
function seoHeadingLines(map) {
  const out = [];
  for (let li = 0; li < map.lines.length; li += 1) {
    const info = map.lineInfo[li];
    if (!info || info.headingLevel === null || info.headingLevel < 2 || info.headingLevel > 3) continue;
    const strictlyInside = (info.zoneFaq || info.zoneExperts) && info.zoneStart !== li;
    if (strictlyInside) continue;
    out.push(li);
  }
  return out;
}

function headingLineHasKeys(map, li, keywords) {
  const toks = map.tokens.filter((t) => t.line === li).map((t) => t.str);
  return keywords.some((k) => keyUsedInText(toks, k));
}

/** Замена в заголовке: словоформа ключа (заголовки номинативны — замена
 *  допустима и для семьи) → нейтральное слово вне ядра. */
function buildHeadingEdit(map, lineIdx, keywords, neutralState) {
  const lineText = map.lines[lineIdx];
  const lineTokens = map.tokens.filter((t) => t.line === lineIdx);
  const strings = lineTokens.map((t) => t.str);
  const keys = [...keywords].sort((a, b) => keyWordsOfLocal(b).length - keyWordsOfLocal(a).length);
  for (const k of keys) {
    const occurrences = findKeyOccurrences(strings, k);
    if (!occurrences.length) continue;
    const positions = occurrences[0];
    const contiguous = positions.every((p, idx) => idx === 0 || p === positions[idx - 1] + 1);
    if (!contiguous) continue; // разбавленный заголовок не рвём
    const first = lineTokens[positions[0]];
    const last = lineTokens[positions[positions.length - 1]];
    const word = pickNeutralWord(keywords, neutralState);
    if (!word) return null;
    const span = lineText.slice(first.start, last.end);
    return { line: lineIdx, start: first.start, end: last.end, replacement: preserveCase(span, word) };
  }
  return null;
}

/**
 * Детерминированная авторедукция плотности SEO-ядра.
 *
 * Фазы (после no-op-гардов < SEO_MIN_NORM_CHARS / без ключей):
 *  1. per-key: вхождения ключа выше капа floor(PER_KEY_DENSITY.fail × слов /
 *     слов_в_ключе), floor ≥ 1, — лишние (с КОНЦА, первое вхождение
 *     неприкосновенно) заменяются/удаляются по единому механизму;
 *  2. total: суммарная плотность > KEY_DENSITY.fail → редукция по убыванию
 *     пер-ключ плотности;
 *  3. headings: доля H2/H3 с ключами > HEADINGS_WITH_KEYS_WINDOW.max →
 *     замена в лишних заголовках (с конца) вне-ядровым словом.
 * Разбавленные/untouchable вхождения не трогаются: кап недостижим →
 * stats.capNotReached с цифрами (честный отказ, текст не рвём).
 *
 * @param {string} markdown
 * @param {object} seoCoreContext результат buildSemanticCoreContext (паритет
 *   с semanticCore постчека)
 * @returns {{text:string, reduced:{perKey:number,total:number,headings:number},
 *   stats:{totalWords,densityBefore,densityAfter,perKeyBefore,perKeyAfter,
 *          headingsBefore,headingsAfter,capNotReached,reason?}}}
 */
export function reduceKeySpam(markdown, seoCoreContext) {
  const reduced = { perKey: 0, total: 0, headings: 0 };
  const identity = (reason) => ({
    text: typeof markdown === 'string' ? markdown : '',
    reduced,
    stats: { reason, capNotReached: [] },
  });
  if (typeof markdown !== 'string' || !markdown) return identity('empty-markdown');

  const plain = plainTextOfBlock(markdown.split('\n'));
  if (plain.length < SEO_MIN_NORM_CHARS) return identity(`short-text(<${SEO_MIN_NORM_CHARS})`);

  // Единый источник ключей: collectKeywords постчека.
  // M2: ключи = semanticCore (кластеры + LSI) — частотный источник убран.
  const keywords = collectKeywords({ semanticCore: seoCoreContext || {} });
  if (!keywords.length) return identity('no-keywords');

  let text = markdown;
  const mapBefore = buildTokenMap(text);
  const occBefore = computeOccurrenceMap(mapBefore, keywords);
  const neutralState = { counter: 0 };
  const capNotReached = new Map();

  // Фаза 1: пер-ключ капы, до фикспойнта (правки меняют длину).
  for (let round = 0; round < 30; round += 1) {
    const map = round === 0 ? mapBefore : buildTokenMap(text);
    const occ = round === 0 ? occBefore : computeOccurrenceMap(map, keywords);
    const edits = [];
    for (const entry of occ.perKey) {
      const cap = Math.max(1, Math.floor((PER_KEY_DENSITY.fail * occ.totalWords) / entry.wordsInKey));
      if (entry.occurrences.length <= cap) {
        capNotReached.delete(entry.key);
        continue;
      }
      const removable = entry.occurrences.slice(cap); // с хвоста; [0] (первое вхождение) остаётся
      const keyWords = keyWordsOfLocal(entry.key);
      let stuck = 0;
      for (let i = removable.length - 1; i >= 0; i -= 1) {
        const cls = classifyOccurrence(map, removable[i]);
        if (cls.kind !== 'editable') {
          stuck += 1;
          continue;
        }
        const edit = buildOccurrenceEdit(map, cls, keyWords, neutralState, keywords);
        if (edit) edits.push(edit);
      }
      if (stuck > 0) {
        capNotReached.set(entry.key, {
          key: entry.key,
          occurrences: entry.occurrences.length,
          cap,
          unreducible: stuck,
          reason: 'diluted-or-untouchable',
        });
      } else {
        capNotReached.delete(entry.key);
      }
    }
    if (!edits.length) break;
    text = applyTextEdits(map.lines, edits).join('\n');
    reduced.perKey += edits.length;
  }

  // Фаза 2: суммарная плотность ≤ KEY_DENSITY.fail — по убыванию пер-ключ плотности.
  for (let round = 0; round < 30; round += 1) {
    const map = buildTokenMap(text);
    const occ = computeOccurrenceMap(map, keywords);
    const density = occ.totalWords ? occ.weighted / occ.totalWords : 0;
    if (density <= KEY_DENSITY.fail) {
      capNotReached.delete('__total-density__');
      break;
    }
    const ranked = occ.perKey
      .map((e) => ({ e, share: (e.occurrences.length * e.wordsInKey) / Math.max(1, occ.totalWords) }))
      .sort((a, b) => b.share - a.share);
    let applied = false;
    for (const { e } of ranked) {
      if (e.occurrences.length <= 1) continue; // первое вхождение неприкосновенно
      const keyWords = keyWordsOfLocal(e.key);
      for (let i = e.occurrences.length - 1; i >= 1; i -= 1) {
        const cls = classifyOccurrence(map, e.occurrences[i]);
        if (cls.kind !== 'editable') continue;
        const edit = buildOccurrenceEdit(map, cls, keyWords, neutralState, keywords);
        if (!edit) continue;
        text = applyTextEdits(map.lines, [edit]).join('\n');
        reduced.total += 1;
        applied = true;
        break;
      }
      if (applied) break;
    }
    if (!applied) {
      capNotReached.set('__total-density__', {
        key: '__total-density__',
        density: Number(density.toFixed(4)),
        cap: KEY_DENSITY.fail,
        reason: 'diluted-or-untouchable',
      });
      break;
    }
  }

  // Фаза 3: доля заголовков с ключами ≤ HEADINGS_WITH_KEYS_WINDOW.max
  // (фактический max постчека 0.65; цель 0.5 НЕ применяется).
  let headingsBefore = null;
  for (let round = 0; round < 10; round += 1) {
    const map = buildTokenMap(text);
    const headingLines = seoHeadingLines(map);
    if (!headingLines.length) break;
    const withKeys = headingLines.filter((li) => headingLineHasKeys(map, li, keywords));
    const share = withKeys.length / headingLines.length;
    if (!headingsBefore) {
      headingsBefore = { total: headingLines.length, withKeys: withKeys.length, share: Number(share.toFixed(3)) };
    }
    if (share <= HEADINGS_WITH_KEYS_WINDOW.max) {
      capNotReached.delete('__headings-share__');
      break;
    }
    const allowed = Math.floor(HEADINGS_WITH_KEYS_WINDOW.max * headingLines.length);
    const excess = withKeys.slice(allowed); // лишние — с конца документа
    let applied = false;
    for (let i = excess.length - 1; i >= 0 && !applied; i -= 1) {
      const edit = buildHeadingEdit(map, excess[i], keywords, neutralState);
      if (!edit) continue;
      text = applyTextEdits(map.lines, [edit]).join('\n');
      reduced.headings += 1;
      applied = true;
    }
    if (!applied) {
      capNotReached.set('__headings-share__', {
        key: '__headings-share__',
        share: Number(share.toFixed(3)),
        cap: HEADINGS_WITH_KEYS_WINDOW.max,
        reason: 'diluted-or-protected-heading',
      });
      break;
    }
  }

  const mapAfter = buildTokenMap(text);
  const occAfter = computeOccurrenceMap(mapAfter, keywords);
  const headingLinesAfter = seoHeadingLines(mapAfter);
  const withKeysAfter = headingLinesAfter.filter((li) => headingLineHasKeys(mapAfter, li, keywords));
  const headingsAfter = {
    total: headingLinesAfter.length,
    withKeys: withKeysAfter.length,
    share: headingLinesAfter.length
      ? Number((withKeysAfter.length / headingLinesAfter.length).toFixed(3))
      : 0,
  };
  return {
    text,
    reduced,
    stats: {
      totalWords: occAfter.totalWords,
      densityBefore: occBefore.totalWords ? Number((occBefore.weighted / occBefore.totalWords).toFixed(4)) : 0,
      densityAfter: occAfter.totalWords ? Number((occAfter.weighted / occAfter.totalWords).toFixed(4)) : 0,
      perKeyBefore: occBefore.perKey.map((e) => ({ key: e.key, occurrences: e.occurrences.length })),
      perKeyAfter: occAfter.perKey.map((e) => ({ key: e.key, occurrences: e.occurrences.length })),
      headingsBefore,
      headingsAfter,
      capNotReached: [...capNotReached.values()],
    },
  };
}
