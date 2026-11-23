/**
 * P4 (2026-08-16): FAQ-блок «10 необычных вопросов» для финальной сборки статьи.
 *
 * Служебный SEO-вызов НАПРЯМУЮ через
 * callRouterAI (НЕ через роль — нет контракта/валидации ролевого пайплайна).
 * Модель резолвится как generation-tier qwen (env ROUTERAI_MODEL_GENERATION,
 * дефолт qwen/qwen3.6-flash) — НЕ resolveRoleModel('standard'): тот рассчитан
 * на роль из agentRoleData и бросает на служебных вызовах. Явный
 * enable_thinking:false — генерация Q/A не требует reasoning, только замедляет.
 *
 * Контракт:
 *  - generateUnusualFaqMarkdown({ topic, h1, headings, conclusionExcerpt,
 *    keywords }, { callFn }) → Promise<string>: markdown FAQ-блока ('' на любом
 *    сбое — НИКОГДА не бросает, статья сохраняется без FAQ). keywords (W2/B2,
 *    seo-round 2026-08-22): string[] — топ ключей SEO-ядра; ≥40% вопросов
 *    формулируются с ними естественно (инструкция только при непустом списке).
 *      * F1 (2026-08-21): 2 попытки (2-я — таймаут 60с); сбой = throw вызова
 *        ИЛИ <MIN_ITEMS валидных вопросов; лог каждой попытки.
 *      * topic обязателен; h1/headings/conclusionExcerpt — компактный контекст.
 *      * валидация: после dedupe уникальных вопросов 8–12, иначе WARN-пропуск;
 *        >12 — обрезка до 10 (целевой размер блока).
 *  - hasUnusualFaqSection(markdown) → boolean: идемпотентность-гард для
 *    повторный прогон — не вставлять FAQ-блок второй раз.
 *
 * Вызывающий код (saveFinalVersion воркера) ОБЯЗАН прогнать возвращённый блок
 * через sanitizeArticle + normalizeHeadings перед вставкой в статью.
 */
import { callRouterAI } from '../agent-role-execution.mjs';

const FAQ_SYSTEM_PROMPT =
  'Ты SEO-копирайтер и эксперт отрасли. По теме статьи и её структуре сгенерируй РОВНО 10 ' +
  'необычных, неочевидных вопросов обычного человека по теме — раскрывающих "тёмные" ' +
  'стороны, подводные камни, о которых молчат (аналог блока "Похожие вопросы" в ' +
  'поисковиках). Вопросы корректные, конкретные, целевые. Ответы краткие ' +
  '(2-4 предложения), чёткие, с обоснованием. Верни JSON ' +
  '{"items":[{"question":"...","answer":"..."}]} — только JSON, без markdown-обёрток.';

const FAQ_MODEL = process.env.ROUTERAI_MODEL_GENERATION || 'qwen/qwen3.6-flash';
const MAX_TOKENS = 3000;
const TEMPERATURE = 0.5;

// F1 (quality-final 2026-08-21): FAQ-ретраи. e2e-факт: при деградации LLM
// (timeout/502/мусор вместо JSON) единственная попытка умирала → статья
// выходила БЕЗ FAQ. Теперь 2 попытки; вторая — с урезанным таймаутом 60с
// (per-call override callRouterAI { timeoutMs }): деградирующий провайдер не
// должен держать финализацию статьи ещё 3 минуты. Ретраится и «мягкий» сбой
// (валидных вопросов < MIN_ITEMS) — это та же деградация ответа.
const FAQ_MAX_ATTEMPTS = 2;
const FAQ_RETRY_TIMEOUT_MS = 60_000;

const MIN_ITEMS = 8; // <8 после dedupe → WARN-пропуск (лучше без FAQ, чем кривой)
const MAX_ITEMS = 12; // >12 → обрезка до целевых 10
const TARGET_ITEMS = 10;
const CONCLUSION_EXCERPT_CHARS = 500;

// W2/B2 (seo-round 2026-08-22; M2 — источник semanticCore): ключи SEO-ядра
// в вопросах. Воркер кладёт в faqContext.keywords топ-12 ключей (string[]).
// Минимальная доля вопросов с ключом — по нормативу SEO (раздел 4.1:
// ≥ 40% = pass, т.е. 4 из 10). Сверх 12 ключей в промпт не идёт — компактность.
const FAQ_KEYWORDS_MAX = 12;

// Гард идемпотентности: итоговый markdown уже содержит секцию необычных
// вопросов (генерация может повториться / FAQ уже вставлен) → не дублировать.
// «необычн… вопрос…» / «вопрос… по тем…» — аккуратные корни, чтобы не ловить
// обычный FAQ («Часто задаваемые вопросы») и бытовой текст про «вопросы».
const FAQ_ALREADY_PRESENT_RE = /необычн[а-яё]*\s+вопрос|вопрос[а-яё]*\s+по\s+тем[а-яё]*/i;

/**
 * Есть ли в markdown уже вставленная секция «необычных вопросов».
 * Tech-lead review (2026-08-16): проверяем ТОЛЬКО строки-заголовки ATX вне
 * code-fence. Секция определяется заголовком; фраза в теле текста («рассмотрим
 * вопросы по теме…» — обычный русский оборот) — НЕ признак готового FAQ-блока:
 * прежний полныйтекстовый test() давал ложное срабатывание и молча убивал
 * вставку FAQ (статья сохранялась без него).
 * @param {string} markdown
 * @returns {boolean}
 */
export function hasUnusualFaqSection(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return false;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^ {0,3}#{1,6}(?=\s)/.test(line) && FAQ_ALREADY_PRESENT_RE.test(line)) return true;
  }
  return false;
}

/**
 * Генерирует markdown FAQ-блока «10 необычных вопросов: {topic}».
 *
 * @param {{ topic?: string, h1?: string, headings?: string[], conclusionExcerpt?: string,
 *           keywords?: string[] }} context — keywords (W2/B2): топ ключей SEO-ядра
 *   (string[], ≤12 учитывается); ≥40% вопросов формулируются с ними естественно.
 * @param {{ callFn?: Function }} [options] — инъекция LLM-вызова для тестов
 *   (дефолт — реальный callRouterAI).
 * @returns {Promise<string>} markdown блока или '' (любой сбой → без FAQ).
 */
export async function generateUnusualFaqMarkdown(context = {}, options = {}) {
  const topic = typeof context?.topic === 'string' ? context.topic.trim() : '';
  if (!topic) return '';

  const call = typeof options?.callFn === 'function' ? options.callFn : callRouterAI;

  // F1: до FAQ_MAX_ATTEMPTS попыток; каждая логируется. Попытка «провалилась»,
  // если вызов бросил ИЛИ ответ не дал enough валидных вопросов. Все попытки
  // упали → прежний fail-safe: WARN и '' (статья сохраняется без FAQ).
  for (let attempt = 1; attempt <= FAQ_MAX_ATTEMPTS; attempt += 1) {
    let content;
    try {
      // Вторая попытка — урезанный таймаут (per-call override callRouterAI):
      // если провайдер деградирует, не ждём полный env-таймаут ещё раз.
      const callArgs =
        attempt === 1
          ? [buildFaqPayload(context, topic)]
          : [buildFaqPayload(context, topic), { timeoutMs: FAQ_RETRY_TIMEOUT_MS }];
      const { data } = await call(...callArgs);
      content = extractContent(data);
    } catch (err) {
      console.warn(
        `[faq-generator] Попытка ${attempt}/${FAQ_MAX_ATTEMPTS}: вызов RouterAI упал (${err?.message || err})` +
          (attempt < FAQ_MAX_ATTEMPTS ? ' — ретрай.' : ' — попытки исчерпаны.')
      );
      continue;
    }

    const items = parseFaqItems(content);
    if (items.length < MIN_ITEMS) {
      console.warn(
        `[faq-generator] Попытка ${attempt}/${FAQ_MAX_ATTEMPTS}: мало валидных вопросов после dedupe ` +
          `(${items.length} < ${MIN_ITEMS})` +
          (attempt < FAQ_MAX_ATTEMPTS ? ' — ретрай.' : ' — попытки исчерпаны.')
      );
      continue;
    }
    if (items.length > MAX_ITEMS) {
      items.length = TARGET_ITEMS; // обрезка к целевому размеру блока
    }
    console.log(
      `[faq-generator] Попытка ${attempt}/${FAQ_MAX_ATTEMPTS}: OK — ${items.length} валидных вопросов.`
    );
    return renderFaqMarkdown(topic, items);
  }

  console.warn(
    `[faq-generator] Все ${FAQ_MAX_ATTEMPTS} попытки не дали валидного FAQ — статья сохраняется без FAQ.`
  );
  return '';
}

/** Пайлоут LLM-вызова FAQ (инвариантен между попытками). */
function buildFaqPayload(context, topic) {
  return {
    model: FAQ_MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
    // Служебный SEO-вызов: reasoning не нужен, только замедляет qwen
    // (замер: 13.8с с thinking → ~1.1с без).
    enable_thinking: false,
    messages: [
      { role: 'system', content: FAQ_SYSTEM_PROMPT },
      { role: 'user', content: buildFaqUserMessage(context, topic) },
    ],
  };
}

/**
 * Компактный user-контекст: тема + H1 + заголовки + ключи SEO-ядра + отрывок
 * заключения. Без полных текстов секций — задача модели «задать неочевидные
 * вопросы», а не пересказать статью.
 */
function buildFaqUserMessage(context, topic) {
  const sections = [`Тема статьи: ${topic}`];

  const h1 = typeof context?.h1 === 'string' ? context.h1.trim() : '';
  if (h1 && h1 !== topic) {
    sections.push(`Заголовок статьи (H1): ${h1}`);
  }

  const headings = Array.isArray(context?.headings)
    ? context.headings.filter((h) => typeof h === 'string' && h.trim()).slice(0, 40)
    : [];
  if (headings.length) {
    sections.push(`Структура статьи (H2/H3):\n${headings.map((h) => `- ${h.trim()}`).join('\n')}`);
  }

  // W2/B2: ключи SEO-ядра → ≥40% вопросов формулируются с ними (норматив 4.1).
  const keywords = Array.isArray(context?.keywords)
    ? context.keywords
        .filter((k) => typeof k === 'string' && k.trim())
        .map((k) => k.trim())
        .slice(0, FAQ_KEYWORDS_MAX)
    : [];
  if (keywords.length) {
    sections.push(
      `Ключевые фразы для вопросов (SEO-ядро статьи):\n${keywords.map((k) => `- ${k}`).join('\n')}`
    );
    sections.push(
      'Минимум 40% вопросов (4 из 10) естественно формулируй с использованием этих ' +
        'ключевых фраз — ключ должен входить в вопрос как живая формулировка поискового ' +
        'запроса, а не перечисление ключей; вопросы остаются необычными и неочевидными, ' +
        'не SEO-мусором.'
    );
  }

  const conclusion =
    typeof context?.conclusionExcerpt === 'string' ? context.conclusionExcerpt.trim() : '';
  if (conclusion) {
    sections.push(
      `Заключение (первые ${Math.min(conclusion.length, CONCLUSION_EXCERPT_CHARS)} симв.):\n` +
        conclusion.slice(0, CONCLUSION_EXCERPT_CHARS)
    );
  }

  sections.push('', 'Сгенерируй РОВНО 10 необычных вопросов с ответами по этой теме.');
  return sections.join('\n');
}

function extractContent(data) {
  if (!data) return '';
  const choice = data.choices?.[0];
  const msg = choice?.message ?? choice;
  if (msg && typeof msg.content === 'string') return msg.content;
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof data.output_text === 'string') return data.output_text;
  if (typeof data.text === 'string') return data.text;
  return '';
}

/**
 * Парсит {items:[{question, answer}]} из ответа модели.
 * Модель может обернуть JSON в ```json-фенсинг или добавить текст вокруг —
 * парсер снимает фенс и берёт первую сбалансированную {...}.
 * Затем: фильтрация битых items → dedupe по нормализованному вопросу.
 */
function parseFaqItems(content) {
  if (!content || typeof content !== 'string') return [];
  const cleaned = stripMarkdownFence(content).trim();
  const jsonText = extractFirstJsonObject(cleaned);
  if (!jsonText) return [];

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const seen = new Set();
  const out = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
    if (!question || !answer) continue;

    const key = question.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question, answer });
  }
  return out;
}

function stripMarkdownFence(text) {
  // Снимает обёртку ```json ... ``` или ``` ... ```.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1].trim() : text;
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const end = findBalancedBrace(trimmed, 0);
    if (end > 0) return trimmed.slice(0, end + 1);
  }
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = findBalancedBrace(text, start);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

function findBalancedBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function renderFaqMarkdown(topic, items) {
  // W2/B2: тема в именительном падеже после двоеточия — «про Интимная лазерная
  // эпиляция» было некорректным падежом; склонение не детерминировано, поэтому
  // формулировка без падежной зависимости.
  const lines = [`## 10 необычных вопросов: ${topic}`, ''];
  for (const item of items) {
    lines.push(`### ${item.question}`);
    lines.push('');
    lines.push(item.answer);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
