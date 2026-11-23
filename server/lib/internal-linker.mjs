/**
 * Программный инжектор internal links (Вариант A).
 *
 * Принцип: точный name-matching по каталогу услуг/специалистов из БД,
 * без LLM. URL берётся из БД (не выдумывается), анкор = каноническое имя.
 *
 * Три приоритета ссылок на домен сайта:
 * (правила линковки из списка ниже). Вход расширен optional-полями
 * { canonicalServiceUrl, canonicalServiceName, sourceSiteBaseUrl, siteName }
 * (воркер/Dev-A пробрасывает из sourceSite + карточки услуги; без них —
 * прежнее поведение, только каталог). opts.siteName — нейтральное имя
 * компании/сайта для прохода «сайт → главная».
 *  1. КАНОНИЧЕСКАЯ ссылка на страницу услуги статьи: первое вхождение
 *     canonicalServiceName в первых CANONICAL_ZONE_CHARS (1200) симв. текста
 *     → [name](canonicalServiceUrl). Имени нет в зоне — БЕЗ генерации текста:
 *     первый упомянутый сервис каталога в зоне (ссылка на его собственный URL;
 *     если он совпадает с canonicalServiceUrl — засчитывается каноном); нет и
 *     его — честный skip + лог.
 *  2. САЙТ → ГЛАВНАЯ: первое вхождение siteName → [name](sourceSiteBaseUrl),
 *     ровно ОДИН раз.
 *  3. КАТАЛОГ: прежний name-matching услуг/специалистов (first-occurrence,
 *     длинные имена приоритетнее) — на остаток общего бюджета maxLinks.
 *     B2 (2026-08-25): СПЕЦИАЛИСТЫ — вне бюджета: каждое ПЕРВОЕ упоминание
 *     КАЖДОГО специалиста каталога (с pageUrl) получает ссылку на его страницу,
 *     даже если бюджет maxLinks исчерпан услугами (автор в режиме «без
 *     специалиста» упоминает 2–4 экспертов — каждый обязан быть обвязан;
 *     услуги по-прежнему бюджетируются окном linksByLength).
 * Общий бюджет: canonical + siteMain + услуги каталога ≤ maxLinks
 * (default 8; объёмно-зависимый лимит по нормативу передаёт воркер через
 * opts.maxLinks). Ссылки на специалистов в бюджет НЕ входят (B2).
 *
 * NO-LINK ЗОНЫ: всё после заголовка FAQ-секции («10 необычных вопросов»,
 * «часто задаваемые вопросы», FAQ) и после подписи «Автор статьи:» не
 * линкуется (норматив 2.1: ссылки не в FAQ; подпись — не анкор). В конвейере
 * воркер вызывает линкер ДО вставки FAQ/подписи — зона остаётся защитным
 * гардом на случай повторной сборки и авторских FAQ-утечек.
 * P2-2: дополнительно секция возражений (H2 «возражени…»/«миф…») —
 * no-link ЗОНА-ДИАПАЗОН (заголовок + тело до следующей H1/H2-секции): секция
 * стоит в середине статьи, «хвостовой» запрет не подходит — после зоны
 * линковка возобновляется (см. findObjectionZoneRanges).
 *
 * Метаданные для постчека (opts.returnAudit:true): к прежним { markdown,
 * injected } добавляются linkedContent (alias), linksAdded: { canonical,
 * siteMain, catalog } и canonicalServiceUrl (ОЖИДАЕМЫЙ канон-URL, даже если
 * ссылка не была поставлена — правило постчека LINKS-CANONICAL-FIRSTZONE
 * честно warn/skip, а не слепой pass).
 *
 * Митигации ложных срабатываний (главный риск программного инжектора):
 *  - Сортировка каталога по длине name DESC: «Ultraformer MPT» раньше «Ultraformer»,
 *    «Лифтинг лица» раньше «Лифтинг» — длинные имена приоритетнее.
 *  - Unicode word-boundary через \p{L} (НЕ \b — он не работает с кириллицей).
 *  - First-occurrence-only: одно упоминание → одна ссылка, без переспама.
 *  - Один URL = одна ссылка (usedUrls Set).
 *  - Пропуск фрагментов уже внутри markdown-ссылки [text](url) или HTML href.
 *  - Пропуск markdown-заголовков (#), ячеек таблиц (|) и inline-code (`).
 *  - maxLinks лимит (default 8).
 *  - Минимальная длина имени ≥ 3-4 символа — не линковать «УЗИ»/«MR» как подстроку.
 *
 * P1d (2026-09-18): UTM-разметка. При truthy GENERAPTOR_UTM_ENABLED
 * каждая поставленная линкером ссылка получает utm_source=generaptor,
 * utm_medium=article и utm_campaign=<opts.utmCampaign> (воркер передаёт id
 * статьи). Дефолт ВЫКЛ — без env поведение линкера не меняется. Подробности
 * и идемпотентность — server/lib/utm-builder.mjs. Аудит: injected[].url —
 * финальный URL как в документе; canonicalServiceUrl — ОЖИДАЕМАЯ форма
 * канона в документе (UTM-форма при включённом флаге: правило постчека
 * CANONICAL-LINK-ZONE сравнивает URL точно, без среза query).
 */

import { isUtmEnabled, buildUrlWithUtm } from './utm-builder.mjs';

const DEFAULT_MAX_LINKS = 8;
const MIN_NAME_LENGTH = 4;
// Каноническая ссылка и название компании — короткие собственные имена
// (бренд из 3 символов легитимен: «ВОЛМА», «МХЦ»).
const MIN_SPECIAL_NAME_LENGTH = 3;
// Норматив 2.2: каноническая ссылка — в пределах первых 1200 симв. текста.
const CANONICAL_ZONE_CHARS = 1200;

// Заголовки FAQ-секций (наши и авторские утечки) — начало no-link зоны.
// Аккуратные корни, чтобы не ловить обычный текст про «вопросы» (проверка
// только на строках-заголовках ATX, вне code-fence).
const FAQ_ZONE_HEADING_RE =
  /необычн[а-яё]*\s+вопрос|вопрос[а-яё]*\s+по\s+тем[а-яё]*|задаваем[а-яё]*\s+вопрос|\bfaq\b/i;
// P2-2: objection-section H2 heading — stems
// «возражени»/«миф», left \p{L} guard (NOT \b — Cyrillic). Copy of
// OBJECTION_HEADING_STEM_RE from lib/objection-block.mjs (keep in sync; no
// import — cycle: objection-block → article-postcheck).
const OBJECTION_ZONE_HEADING_RE = /(?<![\p{L}])(?:возражени|миф)/iu;
// Подпись автора («**Автор статьи:** ФИО») добавляется после линкера —
// защитный гард на повторных сборках.
const SIGNATURE_LINE_RE = /Автор статьи:/;

/**
 * Экранирует спецсимволы regex в имени.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Нормализует URL: пустой → '', без схемы → https:// (относительная ссылка в
 * markdown-статье бесполезна и ломает постчек домена сайта).
 * @param {unknown} url
 * @returns {string}
 */
function normalizeHttpUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Защищён ли фрагмент вокруг позиции от инъекции ссылки?
 * Проверяет контекст ±50 символов вокруг совпадения.
 *
 * Случаи пропуска:
 *  - уже внутри markdown-ссылки [text](url)
 *  - внутри HTML-атрибута href="..."
 *  - внутри inline-code `...`
 *  - внутри ячейки таблицы (текст между | ... |)
 *
 * @param {string} text — весь текст
 * @param {number} start — начало матча
 * @param {number} end — конец матча (start + name.length)
 * @returns {boolean} true если позицию надо ПРОПУСТИТЬ
 */
function isInsideProtectedContext(text, start, end) {
  const before = text.slice(Math.max(0, start - 50), start);
  const after = text.slice(end, Math.min(text.length, end + 50));

  // Уже внутри markdown-ссылки: [до...матч...](  — проверяем что есть открытая [ без закрытой ]
  // и после матча идёт ](
  if (before.includes('[') && after.includes('](')) return true;

  // Внутри HTML href-атрибута
  if (/href\s*=\s*["']?[^"'>\s]*$/.test(before)) return true;

  // Внутри HTML-якоря: <a ...>матч...</a> — между ближайшим <a и </a>.
  // Ищем последний незакрытый <a до матча и </a> после него.
  const lastOpenA = before.lastIndexOf('<a');
  const lastCloseA = before.lastIndexOf('</a>');
  if (lastOpenA > lastCloseA && after.includes('</a>')) return true;

  // Внутри inline-code: нечётное число обратных апострофов до и после позиции
  const backticksBefore = (before.match(/`/g) || []).length;
  const backticksAfter = (after.match(/`/g) || []).length;
  if (backticksBefore % 2 === 1 && backticksAfter % 2 === 1) return true;

  // Внутри ячейки таблицы: | ... match ... | в той же строке
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  // Считаем pipe в строке — если ≥2 и матч между ними, это ячейка таблицы
  if ((line.match(/\|/g) || []).length >= 2) {
    const beforeInLine = line.slice(0, start - lineStart);
    const afterInLine = line.slice(end - lineStart);
    if (beforeInLine.includes('|') && afterInLine.includes('|')) return true;
  }

  // Внутри markdown-заголовка: строка начинается с # (## или ###). Ссылка в
  // заголовке секции выглядит неестественно и бесполезна для SEO-анкора.
  if (/^\s{0,3}#{1,6}\s/.test(line)) return true;

  return false;
}

/**
 * Начало no-link зоны: смещение первой строки-заголовка FAQ-секции или строки
 * подписи автора. Всё от неё и ниже (FAQ-вопросы/ответы, подпись) не линкуем.
 * Заголовки учитываются только вне code-fence (паттерн hasUnusualFaqSection).
 * @param {string} markdown
 * @returns {number} индекс или -1, если зоны нет
 */
function findNoLinkZoneStart(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return -1;
  let inFence = false;
  let offset = 0;
  for (const line of markdown.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^ {0,3}#{1,6}(?=\s)/.test(line) && FAQ_ZONE_HEADING_RE.test(line)) return lineStart;
    if (SIGNATURE_LINE_RE.test(line)) return lineStart;
  }
  return -1;
}

/**
 * P2-2: no-link zone RANGES of objection sections (H2 «возражени…»/
 * «миф…») — [{start, end}] in document CHARACTERS. Unlike FAQ/signature (a
 * tail cut to end of document), an objection section sits mid-article:
 * zone = the heading itself plus the body up to the next heading of level ≤2
 * (the next heading line included — link injection into it is already
 * blocked by isInsideProtectedContext). H2 only (an H3 «миф…» inside an
 * ordinary section does NOT open a zone), outside code fences only.
 * @param {string} markdown
 * @returns {{start: number, end: number}[]}
 */
function findObjectionZoneRanges(markdown) {
  const ranges = [];
  if (typeof markdown !== 'string' || markdown === '') return ranges;
  const lines = markdown.split('\n');
  const totalLen = markdown.length;
  let inFence = false;
  let offset = 0;
  const lineStarts = [];
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  let openRange = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{1,6})(?=\s)/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    if (openRange && level <= 2) {
      // the next H1/H2 section closes the objection zone
      openRange.end = lineStarts[i];
      ranges.push(openRange);
      openRange = null;
    }
    if (!openRange && level === 2 && OBJECTION_ZONE_HEADING_RE.test(line)) {
      openRange = { start: lineStarts[i], end: totalLen };
    }
  }
  if (openRange) ranges.push(openRange);
  return ranges;
}

/** Whether a position falls into one of the objection-zone ranges. */
function inObjectionZone(ranges, pos) {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

/**
 * First safe occurrence of a name: Unicode word boundary, not inside a
 * protected context (link/heading/table/code), before the no-link tail zone
 * (FAQ/signature), outside objection-zone ranges (P2-2) and (optional)
 * not further than maxStart from the start of the text.
 * @param {string} text
 * @param {string} name
 * @param {{ zoneStart?: number, maxStart?: number, objectionRanges?: {{start: number, end: number}[]}} }} [limits]
 * @returns {{ matchStr: string, start: number, end: number } | null}
 */
function findFirstSafeOccurrence(text, name, limits = {}) {
  const zoneStart = typeof limits.zoneStart === 'number' ? limits.zoneStart : -1;
  const maxStart = typeof limits.maxStart === 'number' ? limits.maxStart : Infinity;
  const objectionRanges = Array.isArray(limits.objectionRanges) ? limits.objectionRanges : [];
  const regex = new RegExp(`(?<![\\p{L}])${escapeRegExp(name)}(?![\\p{L}])`, 'gimu');
  let match;
  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    // Matches arrive in ascending position order: past the tail zone or the
    // limit there is no point searching further.
    if (zoneStart >= 0 && start >= zoneStart) break;
    if (start >= maxStart) break;
    // An objection zone is MID-document: skip a match inside it but keep
    // searching (a valid position may follow).
    if (inObjectionZone(objectionRanges, start)) continue;
    const end = start + match[0].length;
    if (!isInsideProtectedContext(text, start, end)) {
      return { matchStr: match[0], start, end };
    }
  }
  return null;
}

/** Оборачивает вхождение в [matchStr](url); возвращает новый текст.
 *  P1d: url проходит через UTM-билдер (при выключенном флаге — без изменений). */
function wrapWithLink(text, occurrence, url, utm = { enabled: false, campaign: '' }) {
  return (
    text.slice(0, occurrence.start) +
    `[${occurrence.matchStr}](${buildUrlWithUtm(url, utm)})` +
    text.slice(occurrence.end)
  );
}

/**
 * Счётчики добавленных ссылок для аудита (returnAudit).
 *
 * Нейтральное имя канала — siteMain; аудит сериализуется как есть,
 * без скрытых алиасов.
 */
function createLinksAdded() {
  return { canonical: 0, siteMain: 0, catalog: 0 };
}

/**
 * Инжектит internal links в markdown статьи.
 *
 * Приоритет 1 — каноническая ссылка на услугу, 2 — сайт → главная,
 * 3 — name-matching по каталогу (см. шапку модуля). Безопасные входы:
 * любой мусор в opts → соответствующий проход молча пропускается.
 *
 * @param {string} markdown — текст статьи
 * @param {{ services?: Array<{name:string, url:string}>, specialists?: Array<{fullName:string, pageUrl:string}> }} catalog
 * @param {{ maxLinks?: number, returnAudit?: boolean,
 *           canonicalServiceUrl?: string, canonicalServiceName?: string,
 *           sourceSiteBaseUrl?: string, siteName?: string,
 *           utmCampaign?: string }} opts
 * @returns {string|{ markdown: string, linkedContent: string, injected: Array<object>,
 *   linksAdded: { canonical: number, siteMain: number, catalog: number },
 *   canonicalServiceUrl: string }}
 *   — string без returnAudit (обратная совместимость), объект при returnAudit:true.
 */
export function injectInternalLinks(markdown, catalog, opts = {}) {
  const returnAudit = opts.returnAudit === true;
  const canonicalServiceUrl = normalizeHttpUrl(opts.canonicalServiceUrl);
  // P1d: UTM-опции прогона — флаг из env (дефолт ВЫКЛ), кампанию передаёт
  // воркер (article id). Бюджет/дедуп/ankor-логика работает по RAW-URL,
  // UTM применяется только в момент оборачивания ссылки.
  const utm = {
    enabled: isUtmEnabled(),
    campaign: typeof opts.utmCampaign === 'string' ? opts.utmCampaign.trim() : '',
  };
  // Ожидаемая форма канона В ДОКУМЕНТЕ: при включённом UTM ссылка ставится
  // UTM-формой, и постчек (CANONICAL-LINK-ZONE, точное сравнение URL) ищет
  // именно её.
  const canonicalServiceUrlExpected = buildUrlWithUtm(canonicalServiceUrl, utm);
  const auditBase = () => ({
    markdown,
    linkedContent: markdown,
    injected: [],
    linksAdded: createLinksAdded(),
    canonicalServiceUrl: canonicalServiceUrlExpected,
  });

  if (!markdown || typeof markdown !== 'string') return returnAudit ? auditBase() : markdown;
  if (!catalog || typeof catalog !== 'object') return returnAudit ? auditBase() : markdown;

  const maxLinks = Math.max(0, opts.maxLinks ?? DEFAULT_MAX_LINKS);
  if (maxLinks === 0) return returnAudit ? auditBase() : markdown;

  // Объединить услуги + специалистов в один массив записей {name, url, kind}.
  // kind (B2): 'specialist' — вне бюджета maxLinks (каждое первое упоминание
  // каждого специалиста обязано получить ссылку); 'service' — бюджетируются.
  const services = Array.isArray(catalog.services) ? catalog.services : [];
  const specialists = Array.isArray(catalog.specialists) ? catalog.specialists : [];

  const entries = [];
  for (const s of services) {
    if (s && s.name && s.url && String(s.name).length >= MIN_NAME_LENGTH) {
      entries.push({ name: String(s.name), url: normalizeHttpUrl(s.url), kind: 'service' });
    }
  }
  for (const s of specialists) {
    if (s && s.fullName && s.pageUrl && String(s.fullName).length >= MIN_NAME_LENGTH) {
      entries.push({ name: String(s.fullName), url: normalizeHttpUrl(s.pageUrl), kind: 'specialist' });
    }
  }

  // Сортировать по длине name DESC — длинные названия приоритетнее
  // (точный/более длинный матч обработается раньше, закрывая partial-match).
  entries.sort((a, b) => b.name.length - a.name.length);

  const canonicalServiceName =
    typeof opts.canonicalServiceName === 'string' ? opts.canonicalServiceName.trim() : '';
  // Название компании/сайта — нейтральный ключ opts.siteName.
  const siteName = typeof opts.siteName === 'string' ? opts.siteName.trim() : '';
  const sourceSiteBaseUrl = normalizeHttpUrl(opts.sourceSiteBaseUrl);

  let result = markdown;
  const linksAdded = createLinksAdded();
  const usedUrls = new Set(); // не дублировать ссылки на один URL
  const injected = []; // аудит: {kind, name, url, position}

  let budget = maxLinks;

  // ── Приоритет 1: каноническая ссылка на страницу услуги (норматив 2.2) ──
  if (budget > 0 && canonicalServiceUrl && canonicalServiceName.length >= MIN_SPECIAL_NAME_LENGTH) {
    let zoneStart = findNoLinkZoneStart(result);
    // P2-2: objection ranges recomputed together with zoneStart (positions
    // shift after every injection).
    let objectionRanges = findObjectionZoneRanges(result);
    const occ = findFirstSafeOccurrence(result, canonicalServiceName, {
      zoneStart,
      maxStart: CANONICAL_ZONE_CHARS,
      objectionRanges,
    });
    if (occ) {
      result = wrapWithLink(result, occ, canonicalServiceUrl, utm);
      usedUrls.add(canonicalServiceUrl);
      linksAdded.canonical = 1;
      budget -= 1;
      injected.push({ kind: 'canonical', name: canonicalServiceName, url: buildUrlWithUtm(canonicalServiceUrl, utm), position: occ.start });
    } else {
      // Fallback БЕЗ генерации текста: первый упомянутый сервис каталога в зоне
      // (по позиции в тексте; при равенстве — более длинное имя). Ссылка — на
      // его собственный URL; совпадение с canonicalServiceUrl = канон найден.
      let best = null;
      for (const entry of entries) {
        if (!entry.url || usedUrls.has(entry.url)) continue;
        const entryOcc = findFirstSafeOccurrence(result, entry.name, {
          zoneStart,
          maxStart: CANONICAL_ZONE_CHARS,
          objectionRanges,
        });
        if (
          entryOcc &&
          (!best || entryOcc.start < best.occ.start ||
            (entryOcc.start === best.occ.start && entry.name.length > best.entry.name.length))
        ) {
          best = { entry, occ: entryOcc };
        }
      }
      if (best) {
        result = wrapWithLink(result, best.occ, best.entry.url, utm);
        usedUrls.add(best.entry.url);
        if (best.entry.url === canonicalServiceUrl) {
          linksAdded.canonical = 1;
          injected.push({ kind: 'canonical', name: best.entry.name, url: buildUrlWithUtm(best.entry.url, utm), position: best.occ.start });
        } else {
          linksAdded.catalog += 1;
          injected.push({ kind: 'catalog', name: best.entry.name, url: buildUrlWithUtm(best.entry.url, utm), position: best.occ.start });
        }
        budget -= 1;
        console.log(
          `[internal-linker] canonical fallback: имя «${canonicalServiceName}» не найдено в первых ` +
            `${CANONICAL_ZONE_CHARS} симв. — в зоне линкуется сервис каталога «${best.entry.name}»` +
            (best.entry.url === canonicalServiceUrl ? ' (URL совпадает с каноном).' : ' (канон-URL не поставлен).')
        );
      } else {
        console.log(
          `[internal-linker] canonical skip: ни «${canonicalServiceName}», ни сервисы каталога ` +
            `не упомянуты в первых ${CANONICAL_ZONE_CHARS} симв. — каноническая ссылка не поставлена.`
        );
      }
    }
  }

  // ── Приоритет 2: сайт → главная (первое упоминание, ровно один раз) ──
  if (budget > 0 && siteName.length >= MIN_SPECIAL_NAME_LENGTH && sourceSiteBaseUrl) {
    const zoneStart = findNoLinkZoneStart(result);
    const objectionRanges = findObjectionZoneRanges(result);
    const occ = findFirstSafeOccurrence(result, siteName, { zoneStart, objectionRanges });
    if (occ) {
      result = wrapWithLink(result, occ, sourceSiteBaseUrl, utm);
      usedUrls.add(sourceSiteBaseUrl);
      linksAdded.siteMain = 1;
      budget -= 1;
      injected.push({ kind: 'site-home', name: siteName, url: buildUrlWithUtm(sourceSiteBaseUrl, utm), position: occ.start });
    } else {
      console.log(
        `[internal-linker] site-home skip: компания «${siteName}» не упомянута в тексте вне protected-зон.`
      );
    }
  }

  // ── Приоритет 3: каталог — прежний name-matching (first-occurrence) ──
  // No-link зона пересчитывается после каждой инъекции: вставка [x](url)
  // сдвигает позиции ниже по тексту.
  // B2: бюджет maxLinks гейтит только УСЛУГИ; СПЕЦИАЛИСТЫ линкуются всегда
  // (каждое первое упоминание каждого специалиста, по одному URL на специалиста)
  // — даже при исчерпанном бюджете: без этого авторские упоминания 2–4 экспертов
  // оставались бы без ссылок, когда бюджет съели канон/сайт/услуги.
  let noLinkZoneStart = findNoLinkZoneStart(result);
  let noLinkObjectionRanges = findObjectionZoneRanges(result);
  for (const entry of entries) {
    if (
      entry.kind === 'service' &&
      linksAdded.canonical + linksAdded.siteMain + linksAdded.catalog >= maxLinks
    ) {
      continue;
    }
    if (!entry.url || usedUrls.has(entry.url)) continue;

    const target = findFirstSafeOccurrence(result, entry.name, {
      zoneStart: noLinkZoneStart,
      objectionRanges: noLinkObjectionRanges,
    });
    if (!target) continue;

    result = wrapWithLink(result, target, entry.url, utm);
    usedUrls.add(entry.url);
    linksAdded.catalog += 1;
    injected.push({ kind: entry.kind === 'specialist' ? 'specialist' : 'catalog', name: entry.name, url: buildUrlWithUtm(entry.url, utm), position: target.start });
    noLinkZoneStart = findNoLinkZoneStart(result);
    noLinkObjectionRanges = findObjectionZoneRanges(result);
  }

  if (returnAudit) {
    return {
      markdown: result,
      linkedContent: result,
      injected,
      linksAdded,
      // P1d: форма, ожидаемая В ДОКУМЕНТЕ (UTM-форма при включённом флаге).
      canonicalServiceUrl: canonicalServiceUrlExpected,
    };
  }
  return result;
}

export const __test__ = {
  escapeRegExp,
  isInsideProtectedContext,
  findNoLinkZoneStart,
  findObjectionZoneRanges,
  normalizeHttpUrl,
  DEFAULT_MAX_LINKS,
  MIN_NAME_LENGTH,
  CANONICAL_ZONE_CHARS,
};
