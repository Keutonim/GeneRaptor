/**
 * W0 (seo-round, 2026-08-22): ЕДИНЫЙ источник SEO-порогов статьи.
 *
 * Числа перенесены из норматива SEO-структуры статей-лендингов.
 * Правило раунда: промпты и
 * валидатор читают пороги ТОЛЬКО отсюда — рассинхрон «промпт требует 30%,
 * валидатор фейлит на 25%» невозможен по построению.
 *
 * Объём L — длина ПЛЕЙН-ТЕКСТА статьи в символах (contentText, без разметки).
 * Все «по объёму»-пороги — кусочно-линейная интерполяция по трём якорям
 * (10k / 30k / 50k), НЕ ступеньки (риск-лист: статьи 28k
 * и 31k не должны прыгать между зонами). Вне шкалы — clamp к крайним якорям.
 *
 * Округление: min-пороги округляются ВВЕРХ (ceil — норму не занижаем),
 * max-пороги ключей — ceil (запас для сечек промптов), max-пороги ссылок —
 * floor (окно не расширяем искусственно).
 *
 * Override-точка: все константы этого файла — единственное место правки при
 * калибровке (плановая правка ОДНОГО файла, без касания промптов/валидатора).
 */

/* ── Якорные таблицы ────────────────────────────────────────────────────── */

/** Уникальных ключей SEO-ядра в статье: 10k → 8–12, 30k → 15–20, 50k → 20–30. */
const KEYS_ANCHORS = [
  { chars: 10_000, min: 8, max: 12 },
  { chars: 30_000, min: 15, max: 20 },
  { chars: 50_000, min: 20, max: 30 },
];

/** Вхождений главного запроса (вкл. H1): 10k → 3–5, 30k → 5–8, 50k → 8–12. */
const MAIN_QUERY_ANCHORS = [
  { chars: 10_000, min: 3, max: 5 },
  { chars: 30_000, min: 5, max: 8 },
  { chars: 50_000, min: 8, max: 12 },
];

/** Ссылок на домен сайта: 10k → 2–4, 30k → 4–6, 50k → 6–8. */
const LINKS_ANCHORS = [
  { chars: 10_000, min: 2, max: 4 },
  { chars: 30_000, min: 4, max: 6 },
  { chars: 50_000, min: 6, max: 8 },
];

/** Нижняя граница нормативной шкалы объёмов («0 ссылок при L ≥ 8000 — fail»;
 *  ниже шкала не применяется — правила честно skipped). */
export const SEO_MIN_NORM_CHARS = 8000;

/** Дефолтный объём, когда реальный неизвестен (сбор до генерации и т.п.). */
export const SEO_DEFAULT_CHARS = 10_000;

/* ── Скалярные пороги ────────────────────────────────────────────────────── */

/** Окно доли H2/H3 с ключами: ниже min — minor-fail, ниже fail — major-fail,
 *  выше max — переспам (fail). Target-зона промптов 30–50% — шире окна НЕ делаем. */
export const HEADINGS_WITH_KEYS_WINDOW = { min: 0.2, fail: 0.2, max: 0.65 };

/** Суммарная плотность ядра (доля, не проценты): ≤3% — норма, >4.5% — major. */
export const KEY_DENSITY = { warn: 0.03, fail: 0.045 };

/**
 * Плотность ОДНОГО ключа: ≤1,5% — норма (warn), >2,5% — fail.
 * FIX-S4 (QA): порог заведён в нормативы как пара, правило постчека —
 * SEO-DENSITY-PER-KEY (считает морфо-детектором FIX-S1, вложенные ключи
 * дедупятся: длинный поглощает короткий в том же вхождении).
 */
export const PER_KEY_DENSITY = { warn: 0.015, fail: 0.025 };

/** Минимальная доля FAQ-вопросов с ключом ядра (≥40% — pass). */
export const FAQ_KEYS_SHARE_MIN = 0.4;

/**
 * Warn-порог FAQ-KEYS-SHARE (seo-deterministic round, 2026-08-27):
 * доля вопросов с ключом в [0.3, 0.4) — warn (НЕ fail); fail — только при
 * доле 0 (полный игнор ключей ядра). Калибровка после e2e — здесь.
 */
export const FAQ_KEYS_SHARE_WARN = 0.3;

/** Минимальная доля ключей ядра, встреченных в плейн-тексте (правило
 *  KEYS-IN-TEXT-SHARE постчека; требование seo-round: <60% — major). */
export const KEYS_IN_TEXT_SHARE_MIN = 0.6;

/** Зона канонической ссылки на услугу: первые N символов markdown. */
export const CANONICAL_ZONE_CHARS = 1200;

/* ── Интерполяция ────────────────────────────────────────────────────────── */

/** Числовой объём: NaN/мусор → дефолт 10k (нижний якорь шкалы). */
function normChars(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return SEO_DEFAULT_CHARS;
  return n;
}

/**
 * Кусочно-линейная интерполяция по якорям с clamp вне шкалы.
 * @param {{chars:number,min:number,max:number}[]} anchors отсортированы по chars
 * @param {number} chars объём статьи (плейн-текст, симв.)
 * @param {(v:number,edge:'min'|'max')=>number} round округление границы
 */
function interpolate(anchors, chars, round) {
  const n = normChars(chars);
  if (n <= anchors[0].chars) {
    return { min: anchors[0].min, max: anchors[0].max };
  }
  const last = anchors[anchors.length - 1];
  if (n >= last.chars) {
    return { min: last.min, max: last.max };
  }
  for (let i = 1; i < anchors.length; i += 1) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (n <= b.chars) {
      const t = (n - a.chars) / (b.chars - a.chars);
      return {
        min: Math.max(1, round(a.min + t * (b.min - a.min), 'min')),
        max: Math.max(1, round(a.max + t * (b.max - a.max), 'max')),
      };
    }
  }
  return { min: last.min, max: last.max }; // unreachable, defensive
}

const ceilBoth = (v) => Math.ceil(v);

/** Уникальных ключей SEO-ядра по объёму (интерполяция как в формулах). */
export function keysTargetByLength(chars) {
  return interpolate(KEYS_ANCHORS, chars, ceilBoth);
}

/** Вхождений главного запроса по объёму («тело» + H1). */
export function mainQueryCountByLength(chars) {
  return interpolate(MAIN_QUERY_ANCHORS, chars, ceilBoth);
}

/** Ссылок на домен сайта по объёму (min — ceil, max — floor). */
export function linksByLength(chars) {
  return interpolate(LINKS_ANCHORS, chars, (v, edge) =>
    edge === 'min' ? Math.ceil(v) : Math.floor(v),
  );
}

/**
 * Упоминаний бренда компании по объёму: базовый темп 1 на 1500–2500 симв.
 *   min = floor(L / 2500), max = round(L / 1500) — формулы норматива.
 */
export function mentionsByLength(chars) {
  const n = normChars(chars);
  return { min: Math.floor(n / 2500), max: Math.round(n / 1500) };
}

/**
 * Жёсткая капа ссылок линкера: 8 при L ≤ 40k, 10 при L > 40k.
 * Превышение капы — warn, ×1.5 — fail; саму капу считает линкер (воркер
 * передаёт её через opts.maxLinks).
 */
export function linksHardCapByLength(chars) {
  return normChars(chars) > 40_000 ? 10 : 8;
}

/* ── Сечки пайплайна (снять жёсткий кап 12) ──────────────────────────────── */

/**
 * Сечки SEO-ядра для промптов по объёму статьи.
 * M2: частотный источник убран — semantic-strategist единственный поставщик
 * ядра, сечек для его вывода по объёму нет. Кластеры/LSI/FAQ-интенты:
 * объёмной нормы для них нет — плоские SEO-default,
 * override-точка — этот файл.
 */
export function semanticCoreCaps() {
  return {
    clusters: 10,
    lsi: 12,
    faqIntents: 8,
  };
}

/** Агрегатор: все нормативы одного объёма одним объектом (удобно для логов/тестов). */
export function resolveSeoStandards(chars) {
  return {
    chars: normChars(chars),
    keys: keysTargetByLength(chars),
    mainQuery: mainQueryCountByLength(chars),
    links: linksByLength(chars),
    linksHardCap: linksHardCapByLength(chars),
    mentions: mentionsByLength(chars),
    headingsWithKeysWindow: HEADINGS_WITH_KEYS_WINDOW,
    keyDensity: KEY_DENSITY,
    perKeyDensity: PER_KEY_DENSITY,
    faqKeysShare: FAQ_KEYS_SHARE_MIN,
    canonicalZoneChars: CANONICAL_ZONE_CHARS,
    minNormChars: SEO_MIN_NORM_CHARS,
  };
}
