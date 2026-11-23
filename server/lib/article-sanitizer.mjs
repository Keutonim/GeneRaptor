/**
 * T3 (fix/article-quality-2026-08-14): санитайзер финального markdown-артикля.
 *
 * Только чистые удаления/замены, НИКАКИХ вставок HTML. Удаляет типовые
 * артефакты LLM (qwen/deepseek через RouterAI):
 *  (а) CJK-символы — Unicode property escapes \p{Script=Han/Hangul/
 *      Hiragana/Katakana} (+ CJK-пунктуация) — ВНЕ URL: markdown-ссылки
 *      [text](url) и голые URL защищены плейсхолдерами и не трогаются;
 *      осиротевшие пробелы/пустые строки после удаления схлопываются;
 *  (б) leaked-фенсы: обёртки ```markdown / ```md (снятие ограждений,
 *      контент сохраняется) и дублирующиеся ``` подряд;
 *  (в) ИИ-фразы (консервативный список ru+en) — удаление предложения
 *      с фразой (или всей строки, если предложение одно);
 *  (г) задвоенности: подряд идущие одинаковые заголовки (keep first),
 *      подряд идущие одинаковые абзацы (keep first) и одинаковые соседние
 *      GFM-таблицы (keep first, отдельная метрика duplicateTables);
 *  (д) тех. секции по точному заголовку («Источники» и пр.);
 *  (е) U5: чанк-артефакты продолжения («Продолжение следует в следующем
 *      батче…») — самостоятельные короткие абзацы, удаляются целиком.
 *
 * Code-fence'ы отслеживаются: их содержимое не трогается. Идемпотентно.
 *
 * Экспорт:
 *  - sanitizeArticle(markdown) → { markdown, report }
 *    report = { wasModified, counts: { cjk, fences, aiPhrases,
 *              duplicateHeadings, duplicateParagraphs, duplicateTables,
 *              cutSections, chunkArtifacts } }
 *  - CHUNK_ARTIFACT_RES / isChunkArtifactLine / stripTrailingContinuation —
 *    U5-реестр чанк-артефактов (общий для воркера и постчека).
 *
 * Вызывающий код (saveFinalVersion) логирует отчёт:
 *   console.warn('[article-sanitizer] articleId=…', JSON.stringify(report))
 * — прозрачность вместо тихой правки.
 */

// U+30FC/U+30A0 (знак продления/двойное дефис-тире) имеют Script=Common —
// добавлены явно, иначе «マッサージ» оставляет осиротевший «ー».
const CJK_RE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF\u30FC\u30A0]/gu;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
// «Голые» http(s)-URL: покрывают и href в [text](url), и автолинки.
const URL_RE = /(https?:\/\/[^\s<>)\]]+)/g;

// ── (в) ИИ-фразы: консервативный список. \b не работает с кириллицей в JS,
// поэтому русские фразы guarded негативным lookahead'ом на букву.
// FIX-1 (QA 2026-08-14): голое «я не могу» УДАЛЕНО из списка — оно рвало
// легитимные цитаты клиентов («я не могу уснуть из-за боли» — ядро контента
// экспертных статей). Оставлены только явные ИИ-мета формулировки с глаголом.
// Универсальный guard на ложный профессиональный дисклеймер («я не являюсь
// <профессия>») — форма одинакова для любой отрасли, поэтому и ловится
// родовым шаблоном, а не перечислением профессий.
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

const EMPTY_COUNTS = () => ({
  cjk: 0,
  fences: 0,
  aiPhrases: 0,
  duplicateHeadings: 0,
  duplicateParagraphs: 0,
  duplicateTables: 0,
  cutSections: 0,
  chunkArtifacts: 0,
});

/* ── (е) U5 (2026-08-20): чанк-артефакты продолжения ──────────────────────
 * Модель в chunked-режиме знает, что текст — часть серии батчей, и оставляет
 * читателю мета-пометку («*(Продолжение следует в следующем батче...)*» —
 * прод 00983341, строка 73 в середине документа). Реестр — ЕДИНЫЙ источник
 * для трёх уровней защиты: хвост-обрезка чанков в воркере
 * (stripTrailingContinuation), этот проход санитайзера и правило
 * BODY-NO-CHUNK-ARTIFACTS постчека (импорт отсюда, без копипасты).
 *
 * КРИТИЧНАЯ ОСТОРОЖНОСТЬ: якорь — только служебные биграммы
 * («продолжение следует», «в следующем батче», «to be continued»), НЕ голое
 * «продолжение/продолжается»: отраслевые обороты вроде «процесс продолжается
 * несколько дней» / «выплаты продолжаются до 10 дней» обязаны жить. Удаляется
 * ТОЛЬКО самостоятельный короткий абзац (≤200 симв.), состоящий в основном
 * из паттерна + пунктуации/скобок — не фраза внутри предложения. */
export const CHUNK_ARTIFACT_RES = [
  /продолжение\s+следует/iu,
  /в\s+следующем\s+батче/iu,
  /батч\s+\d+\s+из\s+\d+/iu,
  /\[продолжение\]/iu,
  /continued\s+in\s+next/i,
  /to\s+be\s+continued/i,
  /(?:продолжение|окончание)\s+(?:следует|в\s+следующем)/iu,
];

const CHUNK_ARTIFACT_MAX_CHARS = 200;
const CHUNK_ARTIFACT_MIN_COVERAGE = 0.6;

/**
 * Является ли строка самостоятельным абзацем-артефактом продолжения.
 * Условия: короткая (≤200 симв.), матчит реестр, и паттерны покрывают
 * ≥60% строки (скобки/астериски/многоточия в покрытие не входят) —
 * фраза внутри обычного предложения НЕ удаляется.
 * @param {string} line
 * @returns {boolean}
 */
export function isChunkArtifactLine(line) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > CHUNK_ARTIFACT_MAX_CHARS) return false;

  const spans = [];
  for (const re of CHUNK_ARTIFACT_RES) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = global.exec(trimmed)) !== null) {
      if (m[0].length === 0) {
        global.lastIndex += 1;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  if (!spans.length) return false;

  // Merge overlapping spans → суммарное покрытие паттернами.
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cur = [spans[0][0], spans[0][1]];
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i][0] <= cur[1]) {
      cur[1] = Math.max(cur[1], spans[i][1]);
    } else {
      covered += cur[1] - cur[0];
      cur = [spans[i][0], spans[i][1]];
    }
  }
  covered += cur[1] - cur[0];
  return covered / trimmed.length >= CHUNK_ARTIFACT_MIN_COVERAGE;
}

/**
 * U5: хвост-ONLY обрезка чанк-артефактов — для склейки чанков в воркере.
 * Если последний непустой абзац чанка — строка-артефакт продолжения,
 * удалить его (вместе с хвостовыми пустыми строками). Середина текста
 * неприкосновенна; ничего не вставляется.
 * @param {string} markdown — markdown одного чанка
 * @returns {string} чанк без трейлинг-артефакта (или исходный)
 */
export function stripTrailingContinuation(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return markdown;
  const lines = markdown.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  if (end === 0) return markdown;
  if (!isChunkArtifactLine(lines[end - 1])) return markdown;
  const kept = lines.slice(0, end - 1).join('\n').replace(/\s+$/, '');
  return kept;
}

// P3 (2026-08-16): тех. секции, вырезаемые из ФИНАЛЬНОГО markdown. Это блоки,
// которые раньше генерировал пайплайн (length-aware expansion постпроцессора,
// bibliography-аппенд воркера), а теперь собираются вне статьи. Ката на случай
// повторного прогона / старых прогонов: заголовок ЛЮБОГО уровня с ТОЧНО таким
// текстом
// + всё содержимое до следующего заголовка того же или выше уровня.
// Совпадение ТОЛЬКО по точному нормализованному тексту заголовка (регистр и
// пробелы игнорируются) — «Источники данных для клиентов» НЕ попадает.
const CUT_SECTION_TITLES = new Set(['дополнительная экспертная информация', 'источники']);

/**
 * (д) Вырезание тех. секций: заголовок с точным именем из CUT_SECTION_TITLES
 * + содержимое до следующего заголовка того же/выше уровня (или конца файла).
 * Заголовки внутри code-fence не считаются (фенс трекается).
 */
function cutTechnicalSections(lines, counts) {
  const out = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const isFenceLine = FENCE_LINE_RE.test(line);
    if (isFenceLine) inFence = !inFence;
    if (inFence || isFenceLine) {
      out.push(line);
      i += 1;
      continue;
    }

    const m = ATX_RE.exec(line);
    const title = m ? headingText(line) : null;
    if (m && title && CUT_SECTION_TITLES.has(title)) {
      counts.cutSections += 1;
      const level = m[1].length;
      let j = i + 1;
      let innerFence = false;
      while (j < lines.length) {
        const next = lines[j];
        if (FENCE_LINE_RE.test(next)) innerFence = !innerFence;
        if (!innerFence) {
          const nm = ATX_RE.exec(next);
          if (nm && nm[1].length <= level) break; // заголовок того же/выше уровня
        }
        j += 1;
      }
      inFence = innerFence; // незакрытый фенс внутри вырезанного — состояние сохраняем
      i = j;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out;
}

/** info-строка фенса — артефактная обёртка ```markdown / ```md? */
function isArtifactFenceInfo(info) {
  return /^(markdown|md)$/i.test((info || '').trim());
}

/**
 * (б) Снятие leaked-фенсов: обёрток ```markdown/```md и дублей ``` подряд.
 */
function removeLeakedFences(lines, counts) {
  const out = [];
  let inFence = false; // внутри ЛЕГИТНОГО code-fence (контент неприкосновенен)
  let inArtifactFence = false; // внутри артефактной обёртки (ограждения снимем)
  let lastEmittedIsFence = false; // предыдущая НЕ-пустая строка — граница фенса

  for (const line of lines) {
    const fenceMatch = FENCE_LINE_RE.exec(line);

    if (inArtifactFence) {
      if (fenceMatch && FENCE_CLOSE_RE.test(line)) {
        inArtifactFence = false; // закрывающее ограждение обёртки — снять
        continue;
      }
      lastEmittedIsFence = false;
      out.push(line); // контент обёртки сохраняется как есть
      continue;
    }

    if (inFence) {
      if (fenceMatch && FENCE_CLOSE_RE.test(line)) {
        inFence = false;
        lastEmittedIsFence = true;
      }
      out.push(line);
      continue;
    }

    if (fenceMatch) {
      if (isArtifactFenceInfo(fenceMatch[2])) {
        inArtifactFence = true; // открывающее ограждение обёртки — снять
        counts.fences += 1; // один артефакт = пара ограждений
        continue;
      }
      // Голая граница фенса строго сразу после другой границы (без пустой
      // строки) — дублирующееся ограждение. Фенс с info-строкой (языком) —
      // открытие нового легитимного блока, его не трогаем.
      if (lastEmittedIsFence && !(fenceMatch[2] || '').trim()) {
        counts.fences += 1;
        continue;
      }
      inFence = true;
      lastEmittedIsFence = true;
      out.push(line);
      continue;
    }

    lastEmittedIsFence = false;
    out.push(line);
  }

  return out;
}

/** Текст atx-заголовка без решёток. */
function headingText(line) {
  const m = ATX_RE.exec(line);
  return m ? (m[2] || '').replace(/\s+/g, ' ').trim().toLowerCase() : null;
}

/** (а)+(в) построчный проход вне фенсов: CJK и ИИ-фразы. */
function cleanLines(lines, counts) {
  const out = [];
  let inFence = false;

  for (const line of lines) {
    const isFenceLine = FENCE_LINE_RE.test(line);
    if (isFenceLine) inFence = !inFence;
    if (inFence || isFenceLine) {
      out.push(line);
      continue;
    }

    let current = line;

    // ── (а) CJK вне URL (URL уже под плейсхолдерами) ──
    const cjkMatches = current.match(CJK_RE);
    if (cjkMatches) {
      counts.cjk += cjkMatches.length;
      current = current.replace(CJK_RE, '');
      // Схлопнуть осиротевшие пробелы на изменённой строке.
      current = current.replace(/[ \t]{2,}/g, ' ').trim();

      // Строка опустела (абзац целиком из CJK) ИЛИ остался голый заголовок
      // без текста (заголовок целиком из CJK) — удалить строку.
      const atx = ATX_RE.exec(current);
      if (current === '' || (atx && !(atx[2] || '').trim())) {
        continue;
      }
    }

    // ── (в) ИИ-фразы: удалить предложение с фразой ──
    if (AI_PHRASE_RES.some((re) => re.test(current))) {
      const sentences = current.split(/(?<=[.!?…])\s+/).filter((s) => s.trim() !== '');
      const kept = sentences.filter((s) => !AI_PHRASE_RES.some((re) => re.test(s)));
      counts.aiPhrases += sentences.length - kept.length;
      current = kept.join(' ');
      if (current.trim() === '') {
        continue; // вся строка была ИИ-предложением
      }
    }

    out.push(current);
  }

  return out;
}

/** (е) U5: удаление самостоятельных абзацев-артефактов продолжения (вне фенсов). */
function removeChunkArtifacts(lines, counts) {
  const out = [];
  let inFence = false;

  for (const line of lines) {
    const isFenceLine = FENCE_LINE_RE.test(line);
    if (isFenceLine) inFence = !inFence;
    if (!inFence && !isFenceLine && isChunkArtifactLine(line)) {
      counts.chunkArtifacts += 1;
      continue; // строка-абзац целиком выбрасывается
    }
    out.push(line);
  }

  return out;
}

/** Нормализация блока для сравнения задвоенностей. */
function normalizeBlockText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * GFM-таблица: все строки содержат |, вторая строка — разделительная
 * (только |, -, :, пробелы, минимум один дефис).
 */
function isGfmTableBlock(blockLines) {
  if (blockLines.length < 2 || !blockLines.every((l) => l.includes('|'))) return false;
  const delim = blockLines[1];
  return /^[\s|:-]+$/.test(delim) && delim.includes('-');
}

/** (г) Подряд идущие одинаковые заголовки/абзацы/таблицы: keep first. */
function dedupeAdjacentBlocks(lines, counts) {
  const drop = new Set();
  let i = 0;
  let prev = null; // { type: 'heading'|'para'|'table', text }

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_LINE_RE.test(line)) {
      // Фенс целиком — нетронутый регион, сбрасывает «предыдущий блок».
      let j = i + 1;
      while (j < lines.length && !FENCE_LINE_RE.test(lines[j])) j += 1;
      i = j + 1;
      prev = null;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const hText = headingText(line);
    if (hText !== null && hText !== '') {
      if (prev?.type === 'heading' && prev.text === hText) {
        counts.duplicateHeadings += 1;
        drop.add(i); // дубль заголовка — удалить строку
      } else {
        prev = { type: 'heading', text: hText };
      }
      i += 1;
      continue;
    }

    // Абзац/таблица — до пустой строки/фенса.
    let j = i;
    const blockLines = [];
    while (j < lines.length && lines[j].trim() !== '' && !FENCE_LINE_RE.test(lines[j])) {
      blockLines.push(lines[j]);
      j += 1;
    }
    // FIX-3 (QA): одинаковые соседние GFM-таблицы (артефакт LLM) считаем
    // ОТДЕЛЬНОЙ метрикой duplicateTables, не duplicateParagraphs.
    const type = isGfmTableBlock(blockLines) ? 'table' : 'para';
    const text = normalizeBlockText(blockLines.join(' '));
    if (prev?.type === type && prev.text === text) {
      if (type === 'table') counts.duplicateTables += 1;
      else counts.duplicateParagraphs += 1;
      for (let k = i; k < j; k += 1) drop.add(k);
    } else {
      prev = { type, text };
    }
    i = j;
  }

  return lines.filter((_, idx) => !drop.has(idx));
}

/** Схлопнуть прогоны пустых строк (>1) вне фенсов до одной пустой строки. */
function collapseBlankRuns(lines) {
  const out = [];
  let inFence = false;
  let blankRun = 0;

  for (const line of lines) {
    const isFenceLine = FENCE_LINE_RE.test(line);
    if (isFenceLine) inFence = !inFence;

    if (!inFence && !isFenceLine && line.trim() === '') {
      blankRun += 1;
      if (blankRun > 1) continue; // лишняя пустая строка — выбросить
    } else {
      blankRun = 0;
    }
    out.push(line);
  }

  return out;
}

/**
 * Санитизирует финальный markdown статьи.
 *
 * @param {string} markdown — финальный markdown (после всех LLM-ролей)
 * @returns {{ markdown: string, report: object }} очищенный markdown + отчёт
 */
export function sanitizeArticle(markdown) {
  if (typeof markdown !== 'string' || markdown === '') {
    return {
      markdown: typeof markdown === 'string' ? markdown : '',
      report: { wasModified: false, counts: EMPTY_COUNTS() },
    };
  }

  const counts = EMPTY_COUNTS();

  // 1. Защита URL плейсхолдерами: CJK/фразы/точки предложений их не тронут.
  const urls = [];
  const guarded = markdown.replace(URL_RE, (url) => {
    urls.push(url);
    return `\u0000${urls.length - 1}\u0000`;
  });

  // 2. (д) вырезание тех. секций («Дополнительная экспертная информация»,
  //    «Источники») — до остальных проходов, чтобы дальнейшая чистка работала
  //    по тексту, уже освобождённому от тех. блоков.
  let lines = cutTechnicalSections(guarded.split('\n'), counts);
  // 3. (б) leaked-фенсы.
  lines = removeLeakedFences(lines, counts);
  // 4. (а)+(в) CJK и ИИ-фразы.
  lines = cleanLines(lines, counts);
  // 4.5. (е) U5: чанк-артефакты продолжения («Продолжение следует…»).
  lines = removeChunkArtifacts(lines, counts);
  // 5. (г) задвоенности.
  lines = dedupeAdjacentBlocks(lines, counts);
  // 6. Тиди: прогоны пустых строк.
  lines = collapseBlankRuns(lines);

  // 6. Восстановление URL. Гвард коллизий: если во входном тексте уже был
  // паттерн вида \u0000N\u0000 (не наш плейсхолдер — индекс вне диапазона),
  // возвращаем матч как есть — иначе в текст попадала бы строка "undefined"
  // (единственная точка, где санитайзер мог бы ВСТАВИТЬ посторонний текст).
  let result = lines.join('\n').replace(/\u0000(\d+)\u0000/g, (match, idx) => {
    const url = urls[Number(idx)];
    return url === undefined ? match : url;
  });

  // 7. FIX-2 (QA): если после CJK-чистки анкор ссылки опустел (`[](url)`),
  // снимаем markdown-обёртку, оставляя URL как plain text — URL источников
  // мед-статей ценен, а ссылка без анкора бесполезна.
  result = result.replace(/\[\s*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, '$1');

  // Финальный тиди краёв: пустые строки в начале/конце документа.
  result = result.replace(/^\n+/, '').replace(/\n+$/, '');

  return {
    markdown: result,
    report: { wasModified: result !== markdown, counts },
  };
}
