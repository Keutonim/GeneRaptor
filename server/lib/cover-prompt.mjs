/**
 * Cover wave (2026-10-24): prompt assembly for AI cover generation (R2/R3).
 *
 * Pure module — no DB, no network, no env reads. Two consumers:
 *   - cover-service.mjs: buildCoverPrompt (image prompt) +
 *     buildCompressionRequest (text-model compression call, R2);
 *   - cover-settings.mjs: DEFAULT_COVER_SYSTEM_PROMPT seeds the settings
 *     COVER_SETTINGS_DEFAULTS (promptTemplate).
 *
 * Composition rules (deterministic, unit-tested in
 * tests/unit/cover-prompt.test.mjs):
 *   1. {title}         → Article.topic; NEVER auto-appended when absent.
 *   2. {articleBrief}  → the compressed brief; when the token is absent the
 *      brief is appended as «Содержание статьи: <brief>» (never lost).
 *   3. {refinement}    → the current refinement; when the token is absent and
 *      a refinement exists it is appended as «Дополнительные указания: <ref>»;
 *      when no refinement exists the section is omitted (no dangling header).
 *   4. Blank runs collapse to a single \n\n; the result is trimmed.
 *   5. Unknown {tokens} stay verbatim and are logged ONCE (never thrown).
 */

/**
 * DEFAULT cover template — brand-neutral (M5, D1/P2: every brand constant
 * is gone — the face description, the named typeface, the fixed hex palette
 * and the fixed corner radius; the default says only WHAT a good cover is,
 * never WHICH brand it belongs to).
 *
 * Editable at runtime via settings.promptTemplate; this constant is only the
 * DEFAULT value. Tokens {title}/{articleBrief}/{refinement} keep working.
 */
export const DEFAULT_COVER_SYSTEM_PROMPT =
  'Создай обложку-баннер для статьи. Текст на изображении — на русском языке, читаемый sans-serif шрифт. Изображение должно выделять главные темы статьи и быть пригодным для публикации в интернете. Используй нейтральную цветовую гамму с высоким контрастом текста и фона. Все внутренние элементы и блоки должны иметь аккуратные скругления краёв.';

/**
 * R2 compression instruction (RU): compress the article into a brief for the
 * image banner. Pinned by test case 9: ≤120 words, 5–8 aspects, facts only,
 * plain text, ≤ ~900 chars output.
 */
export const COMPRESSION_PROMPT = [
  'Сожми текст статьи в краткое описание (бриф) для рекламного баннера-обложки.',
  'Пиши на русском языке, простым текстом без разметки, списков и заголовков.',
  'Объём брифа — не более 120 слов (примерно до 900 символов).',
  'Отрази от 5 до 8 аспектов статьи: суть темы; польза и эффекты;',
  'целевая аудитория; сценарии применения и ограничения; длительность и условия;',
  'цена или специальное предложение; призыв к действию (CTA); ключевые условия акции.',
  'Используй ТОЛЬКО факты из статьи: не добавляй отраслевых утверждений,',
  'цифры, адреса и телефоны, которых в тексте нет.',
].join(' ');

/** Tokens buildCoverPrompt substitutes. Anything else is "unknown". */
const KNOWN_TOKENS = new Set(['title', 'articleBrief', 'refinement']);

/** Unknown-token warnings are logged once per process (rule 5). */
const warnedUnknownTokens = new Set();

/**
 * Substitute `token` with `value`. When the value is empty the token is
 * removed and any line left blank or reduced to a dangling header («Label:»)
 * is dropped entirely — the section is omitted, never rendered empty.
 * @param {string} source
 * @param {string} token — e.g. '{refinement}'
 * @param {string} value — already trimmed; '' means "no value"
 * @returns {string}
 */
function substituteToken(source, token, value) {
  if (!source.includes(token)) return source;
  if (value) return source.split(token).join(value);
  return source
    .split('\n')
    .map((line) => {
      if (!line.includes(token)) return line;
      const stripped = line.split(token).join('');
      const trimmed = stripped.trim();
      // Drop lines that became empty or end in a dangling header colon.
      if (trimmed === '' || /[:：]$/.test(trimmed)) return null;
      return stripped;
    })
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Warn about unknown {tokens} once each (rule 5) — never throw: the template
 * is operator-editable free text.
 * @param {string} template
 */
function warnUnknownTokensOnce(template) {
  const matches = template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
  for (const match of matches) {
    const name = match[1];
    if (KNOWN_TOKENS.has(name) || warnedUnknownTokens.has(name)) continue;
    warnedUnknownTokens.add(name);
    console.warn(
      `[cover-prompt] unknown template token {${name}} — left verbatim in the composed prompt`,
    );
  }
}

/**
 * Compose the single image prompt: brand template + brief + refinement
 * Deterministic and side-effect-free (apart from the
 * once-per-token warning).
 * @param {{template?: string|null, brief?: string|null, refinement?: string|null, title?: string|null}} input
 * @returns {string}
 */
export function buildCoverPrompt({ template, brief, refinement, title } = {}) {
  const tpl =
    typeof template === 'string' && template.trim() !== ''
      ? template
      : DEFAULT_COVER_SYSTEM_PROMPT;
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  const safeBrief = typeof brief === 'string' ? brief.trim() : '';
  const safeRefinement = typeof refinement === 'string' ? refinement.trim() : '';

  warnUnknownTokensOnce(tpl);

  let composed = tpl;
  composed = substituteToken(composed, '{title}', safeTitle);
  const hadBriefToken = composed.includes('{articleBrief}');
  composed = substituteToken(composed, '{articleBrief}', safeBrief);
  const hadRefinementToken = composed.includes('{refinement}');
  composed = substituteToken(composed, '{refinement}', safeRefinement);

  // Auto-append the sections whose tokens are absent (rules 2-3). The title
  // is deliberately NOT appended (rule 1).
  const blocks = [composed];
  if (!hadBriefToken && safeBrief) blocks.push(`Содержание статьи: ${safeBrief}`);
  if (!hadRefinementToken && safeRefinement) {
    blocks.push(`Дополнительные указания: ${safeRefinement}`);
  }

  return blocks
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n') // trailing spaces on lines
    .replace(/\n{3,}/g, '\n\n') // collapse blank runs (rule 4)
    .trim();
}

/**
 * Build the {system, user} message pair for the compression call (R2). The
 * caller (cover-service) truncates `text` to the 12 000-char budget before
 * calling — the composition rules above.
 * @param {{title?: string|null, text: string}} input
 * @returns {{system: string, user: string}}
 */
export function buildCompressionRequest({ title, text } = {}) {
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  const safeText = typeof text === 'string' ? text : '';
  const header = safeTitle ? `Заголовок статьи: ${safeTitle}` : 'Заголовок статьи: (без заголовка)';
  return {
    system: COMPRESSION_PROMPT,
    user: `${header}\n\nТекст статьи:\n${safeText}`,
  };
}
