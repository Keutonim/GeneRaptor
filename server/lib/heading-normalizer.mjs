/**
 * T2 (fix/article-quality-2026-08-14): нормализатор заголовков финального
 * markdown-артикля. Детерминированная чистая функция над строкой markdown.
 *
 * Правила:
 *  (а) единственный H1: первый заголовок документа остаётся H1 (или повышается
 *      до H1, если H1 в документе нет), остальные H1 понижаются до H2;
 *  (б) запрет пропусков уровней: каждый следующий заголовок не глубже
 *      prev+1 (H1 → H3 исправляется на H1 → H2);
 *  (в) setext-заголовки (Title\n=== / Title\n---) конвертируются в atx.
 *      ГВАРД от ловушки: в CommonMark строка `---` сразу после абзаца — это
 *      setext-H2, но в наших LLM-статьях это почти всегда артефактный hr.
 *      При неоднозначности (документ в основном использует atx-заголовки,
 *      underline — `---`) — трактуем как hr: вставляем пустую строку перед
 *      `---`, заголовок НЕ создаём. `===`-underline честно считаем заголовком.
 *
 * Ограждения кода (``` / ~~~) отслеживаются: заголовки внутри code-fence
 * не трогаются. Идемпотентно: повторный прогон по результату — no-op.
 *
 * Экспорт:
 *  - normalizeHeadings(markdown) → { markdown, report }
 *    report = { wasModified, counts: { setextConverted, hrDisambiguated,
 *              promotedToH1, demotedH1, levelJumpsFixed } }
 */

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_EQ_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT_HYPHEN_RE = /^ {0,3}-+[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/;
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const TABLE_ROW_RE = /\|/;

function isBlank(line) {
  return !line || !line.trim();
}

/** Может ли строка быть содержимым setext-заголовка (обычная строка абзаца). */
function isPlainParagraphLine(line) {
  if (isBlank(line)) return false;
  if (ATX_RE.test(line)) return false;
  if (FENCE_RE.test(line)) return false;
  if (HR_RE.test(line)) return false;
  if (LIST_RE.test(line)) return false;
  if (TABLE_ROW_RE.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false; // blockquote
  if (/^ {0,3}</.test(line)) return false; // html-блок
  return true;
}

/**
 * Абзац однострочный (setext-заголовок из него — безопасная конвертация)?
 * Смотрим предыдущую строку: если она тоже «продолжение абзаца» — контент
 * многострочный, конвертация в один atx потеряла бы строки.
 */
function isSingleLineParagraph(lines, index) {
  if (index <= 0) return true;
  return !isPlainParagraphLine(lines[index - 1]);
}

/**
 * Фаза A: setext → atx + гвард артефактных hr.
 * @param {string[]} lines
 * @returns {{ lines: string[], counts: { setextConverted: number, hrDisambiguated: number } }}
 */
function convertSetextAndGuardHr(lines) {
  const out = [];
  const counts = { setextConverted: 0, hrDisambiguated: 0 };
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const prevOut = out.length ? out[out.length - 1] : '';
    const prevIsPlainParagraph = out.length > 0 && isPlainParagraphLine(prevOut);

    // `===`-underline — честно считаем заголовком (setext H1).
    if (SETEXT_EQ_RE.test(line)) {
      if (prevIsPlainParagraph && isSingleLineParagraph(lines, i - 1)) {
        out[out.length - 1] = `# ${prevOut.trim()}`;
        counts.setextConverted += 1;
      } else {
        // Не paragraphs-контент (или многострочный) — не трогаем.
        out.push(line);
      }
      continue;
    }

    // `---`-underline сразу после абзаца: CommonMark сказал бы setext-H2,
    // но в наших статьях это почти всегда артефактный hr.
    if (SETEXT_HYPHEN_RE.test(line) && prevIsPlainParagraph) {
      // Честная setext-конвертация — только если документ НЕ использует atx
      // (иначе «в основном atx» → неоднозначность → hr) И абзац однострочный.
      const docHasAtx = lines.some((l) => !inFence && ATX_RE.test(l));
      if (!docHasAtx && isSingleLineParagraph(lines, i - 1)) {
        out[out.length - 1] = `## ${prevOut.trim()}`;
        counts.setextConverted += 1;
      } else {
        // ГВАРД: трактуем как hr — вставляем пустую строку перед `---`,
        // чтобы парсер не склеил её с абзацем в setext-заголовок.
        out.push('');
        out.push(line);
        counts.hrDisambiguated += 1;
      }
      continue;
    }

    out.push(line);
  }

  return { lines: out, counts };
}

/**
 * Фаза B: правила (а) единственный H1 + (б) запрет пропусков уровней.
 * @param {string[]} lines
 * @returns {{ lines: string[], counts: { promotedToH1: number, demotedH1: number, levelJumpsFixed: number } }}
 */
function normalizeLevels(lines) {
  const counts = { promotedToH1: 0, demotedH1: 0, levelJumpsFixed: 0 };
  let inFence = false;
  let firstHeadingSeen = false;
  let prevLevel = 0;

  const result = lines.map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    const match = ATX_RE.exec(line);
    if (!match) return line;

    const hashes = match[1];
    const text = (match[2] || '').trim();
    const originalLevel = hashes.length;
    let target;

    if (!firstHeadingSeen) {
      // (а) первый заголовок документа — единственный H1.
      target = 1;
      firstHeadingSeen = true;
      if (originalLevel !== 1) counts.promotedToH1 += 1;
    } else if (originalLevel === 1) {
      // (а) остальные H1 понижаются до H2.
      target = 2;
      counts.demotedH1 += 1;
    } else {
      // (б) не глубже prev+1.
      target = Math.min(originalLevel, prevLevel + 1);
      if (target !== originalLevel) counts.levelJumpsFixed += 1;
    }

    prevLevel = target;
    return '#'.repeat(target) + (text ? ` ${text}` : '');
  });

  return { lines: result, counts };
}

/**
 * Нормализует заголовки markdown-статьи.
 *
 * @param {string} markdown — финальный markdown статьи
 * @returns {{ markdown: string, report: object }} нормализованный markdown + отчёт
 */
export function normalizeHeadings(markdown) {
  if (typeof markdown !== 'string' || markdown === '') {
    return {
      markdown: typeof markdown === 'string' ? markdown : '',
      report: {
        wasModified: false,
        counts: { setextConverted: 0, hrDisambiguated: 0, promotedToH1: 0, demotedH1: 0, levelJumpsFixed: 0 },
      },
    };
  }

  const lines = markdown.split('\n');
  const phaseA = convertSetextAndGuardHr(lines);
  const phaseB = normalizeLevels(phaseA.lines);

  const resultMarkdown = phaseB.lines.join('\n');
  return {
    markdown: resultMarkdown,
    report: {
      wasModified: resultMarkdown !== markdown,
      counts: {
        setextConverted: phaseA.counts.setextConverted,
        hrDisambiguated: phaseA.counts.hrDisambiguated,
        promotedToH1: phaseB.counts.promotedToH1,
        demotedH1: phaseB.counts.demotedH1,
        levelJumpsFixed: phaseB.counts.levelJumpsFixed,
      },
    },
  };
}
