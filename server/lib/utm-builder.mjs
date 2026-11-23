/**
 * P1d (2026-09-18): UTM-билдер для internal-ссылок линкера.
 *
 * Три чистые функции, без БД и побочных эффектов:
 *
 *  - isUtmEnabled(env) — truthy-парсер GENERAPTOR_UTM_ENABLED. Дефолт ВЫКЛ
 *    (env не задан → false): безопасный деплой, владелец включает явно.
 *    Truthy: любое непустое значение, кроме '0'/'false'/'no'/'off'
 *    (case-insensitive, с trim).
 *
 *  - buildUrlWithUtm(url, { enabled, campaign }) — добавляет к URL
 *    utm_source=generaptor и utm_medium=article (+ utm_campaign=<article id
 *    или slug> при непустом campaign). Контракт:
 *      * enabled:false → исходная строка без изменений;
 *      * существующий query сохраняется, UTM добавляются в конец;
 *      * ИДЕМПОТЕНТНОСТЬ: собственные utm_source/utm_medium/utm_campaign
 *        перед добавлением срезаются — повторные прогоны не плодят дубли,
 *        устаревшие значения перезаписываются актуальными; чужие параметры
 *        (включая utm_term и пр.) не трогаются;
 *      * битый/не-URL вход → вернуть как есть (безопасная деградация:
 *        UTM-фича не должна ломать линкер).
 *
 *  - pageUrlsWithUtmVariants(urls, opts) — RAW + UTM-формы списка URL для
 *    постчек-контекста специалист-ссылок. Причины: правила постчека
 *    (LINKS-SPECIALIST-PRESENT, разрешённые ссылки в подписи автора)
 *    сравнивают URL ТОЧНО, без среза query; при включённом UTM линкер
 *    ставит в markdown UTM-формы, а подпись «Автор статьи:» строится из
 *    RAW pageUrl — постчек обязан распознать обе формы.
 *
 * UTM применяется ТОЛЬКО к internal-ссылкам линкера (каталог/специалисты/
 * канон услуги/главная сайта). Внешние source-ссылки и rentry-вывод
 * не затрагиваются: билдер вызывается исключительно из internal-linker
 * и одного места воркера (постчек-контекст).
 */

/** Значения UTM по умолчанию (контракт плана, волна 1 P1d). */
export const UTM_SOURCE_DEFAULT = 'generaptor';
export const UTM_MEDIUM_DEFAULT = 'article';

/** Собственные параметры билдера: только их срезаем/перезаписываем. */
const OWN_UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign'];

/** Явно ложные строки для env-флагов (case-insensitive). */
const FALSY_ENV_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Включена ли UTM-разметка. Непустое значение, не входящее в ложный набор,
 * считается включением ('1', 'true', 'on', 'yes', …).
 * @param {Record<string, string|undefined>} [env] — окружение (тестируемость)
 * @returns {boolean}
 */
export function isUtmEnabled(env = process.env) {
  const raw = env ? env.GENERAPTOR_UTM_ENABLED : undefined;
  if (raw === undefined || raw === null) return false;
  return !FALSY_ENV_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * Собрать URL с UTM-параметрами (см. контракт модуля).
 * @param {string} url — абсолютный URL (https://… из каталога/канона)
 * @param {{ enabled?: boolean, campaign?: string }} [opts]
 * @returns {string} итоговый URL либо исходное значение без изменений
 */
export function buildUrlWithUtm(url, opts = {}) {
  const enabled = opts.enabled === true;
  if (!enabled) return url;
  if (typeof url !== 'string' || url.trim() === '') return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Не абсолютный URL — не портим (внутренние вызовы дают нормализованные
    // https-URL, сюда попадают только мусорные входы).
    return url;
  }
  // Идемпотентность: свои параметры срезаем и ставим заново — повторный
  // прогон даёт ту же строку, устаревшие значения не накапливаются.
  for (const key of OWN_UTM_PARAMS) {
    parsed.searchParams.delete(key);
  }
  parsed.searchParams.set('utm_source', UTM_SOURCE_DEFAULT);
  parsed.searchParams.set('utm_medium', UTM_MEDIUM_DEFAULT);
  const campaign = typeof opts.campaign === 'string' ? opts.campaign.trim() : '';
  if (campaign) {
    parsed.searchParams.set('utm_campaign', campaign);
  }
  return parsed.toString();
}

/**
 * RAW + UTM-формы списка URL (постчек-контекст специалист-ссылок).
 * Порядок стабилен: сначала все RAW, затем их UTM-формы; дубли срезаются.
 * @param {string[]|unknown} urls
 * @param {{ enabled?: boolean, campaign?: string }} [opts]
 * @returns {string[]}
 */
export function pageUrlsWithUtmVariants(urls, opts = {}) {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  const out = [];
  const push = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const normalized = value.trim();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const url of urls) {
    if (typeof url !== 'string' || url.trim() === '') continue;
    const trimmed = url.trim();
    push(trimmed);
    push(buildUrlWithUtm(trimmed, opts));
  }
  return out;
}
