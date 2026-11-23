/**
 * Topic matcher — decides which narrow vertical sources fit the topic of a
 * query.
 *
 * The verticals (OpenAlex, Crossref, Europe PMC, GDELT, Nominatim,
 * OpenLibrary, StackExchange, Hacker News) are NOT a tier of the search
 * chain: they are consulted only when the topic of the request matches the
 * domain of a vertical. The predicate lives here, as a pure function, so the
 * decision is testable without a network.
 *
 * Rules:
 *   - a STRONG marker adds 2, a WEAK marker adds 1;
 *   - a vertical is selected when its score reaches TOPIC_MATCH_THRESHOLD (2),
 *     i.e. one strong marker or two weak ones;
 *   - at most MAX_VERTICALS verticals are selected per request (quota guard:
 *     Nominatim allows 1 request/s, StackExchange 300 keyless requests/day/IP);
 *   - the order is deterministic: score desc, then priority asc, then the
 *     declaration order of the rule;
 *   - markers are bilingual (RU + EN) — a query may be mixed;
 *   - a marker matches a word by PREFIX (stems), never by a bare substring:
 *     "industrial" must not fire the "trial" marker of the biomedical
 *     vertical, and "подход" must not fire the "код" marker.
 *
 * The marker table is intentionally hardcoded: it is product knowledge about
 * the domains, not a user setting.
 */

/** Score of one matched strong marker. */
export const STRONG_MARKER_WEIGHT = 2;

/** Score of one matched weak marker. */
export const WEAK_MARKER_WEIGHT = 1;

/** Minimal score of a vertical to be selected. */
export const TOPIC_MATCH_THRESHOLD = 2;

/** Maximal number of verticals per request. */
export const MAX_VERTICALS = 2;

/**
 * The marker table.
 *
 * `priority` fixes the order of verticals with an equal score (lower first).
 *
 * NOTE: the biomedical rule carries domain vocabulary on purpose — it is the
 * vocabulary of that vertical. The universal gate has exactly one narrow
 * allowance for this file (see scripts/universal-gate.mjs, the
 * `vertical-domain-marker:*` class).
 *
 * @type {ReadonlyArray<{id: string, topic: string, priority: number, markers: {strong: string[], weak: string[]}}>}
 */
export const TOPIC_RULES = Object.freeze([
  {
    id: 'openalex',
    topic: 'наука, публикации, цитируемость',
    priority: 10,
    markers: {
      strong: [
        'научн', 'исследован', 'публикац', 'цитируем', 'препринт', 'рецензир',
        'реферат', 'h-index', 'research', 'peer-review', 'citation', 'preprint',
        'journal', 'abstract', 'paper',
      ],
      weak: ['учен', 'студент', 'диссертац', 'монографи', 'study', 'studies', 'university', 'thesis'],
    },
  },
  {
    id: 'crossref',
    topic: 'DOI, издания и журналы',
    priority: 20,
    markers: {
      strong: ['doi', 'издател', 'выпуск', 'issn', 'isbn', 'volume', 'issue', 'citation', 'publish'],
      weak: ['публикац', 'журнал', 'производств', 'publication', 'proceedings'],
    },
  },
  {
    id: 'europepmc',
    topic: 'медицина, здоровье, терапия',
    priority: 30,
    markers: {
      strong: [
        'лечен', 'диагноз', 'симптом', 'терапи', 'препарат', 'лекарств', 'медицинск',
        'болезн', 'заболеван', 'пациент', 'дозиров', 'вакцин', 'клиник', 'диабет',
        'инсулин', 'diagnos', 'symptom', 'drug', 'clin', 'patien', 'medicin', 'disease',
        'vaccin', 'therap',
      ],
      weak: ['здоровь', 'витамин', 'иммунитет', 'белок', 'health', 'vitamin', 'protein', 'diet'],
    },
  },
  {
    id: 'gdelt',
    topic: 'мировые новости и события',
    priority: 40,
    markers: {
      strong: [
        'новост', 'событи', 'конфликт', 'выборы', 'происшестви', 'переговор', 'санкци',
        'протест', 'news', 'breaking', 'election', 'conflict', 'sanction', 'protest', 'headline',
      ],
      weak: ['сегодня', 'вчера', 'недавно', 'today', 'yesterday', 'recently', 'latest'],
    },
  },
  {
    id: 'nominatim',
    topic: 'география, адреса и координаты',
    priority: 50,
    markers: {
      strong: [
        'адрес', 'координат', 'широт', 'долгот', 'геокод', 'геолокац', 'местоположен',
        'где находится', 'address', 'coordinates', 'latitude', 'longitude', 'geocode',
        'where is', 'map of',
      ],
      weak: ['район', 'область', 'регион', 'district', 'region', 'vicinity'],
    },
  },
  {
    id: 'openlibrary',
    topic: 'книги, авторы и издания',
    priority: 60,
    markers: {
      strong: ['книг', 'роман', 'повест', 'писател', 'литератур', 'поэм', 'book', 'novel', 'author', 'literature', 'poem', 'fiction'],
      weak: ['издани', 'читать', 'чтение', 'publish', 'read', 'edition'],
    },
  },
  {
    id: 'stackexchange',
    topic: 'программирование и практические вопросы',
    priority: 70,
    markers: {
      strong: [
        'ошибк', 'исключени', 'stacktrace', 'traceback', 'segfault', 'не работает',
        'python', 'javascript', 'typescript', 'react.js', 'postgres', 'docker', 'kubernetes',
        'undefined is not', 'how to', 'error', 'exception', 'segmentation fault',
      ],
      weak: ['код', 'программирован', 'api', 'функци', 'code', 'programming', 'developer', 'framework', 'library', 'function'],
    },
  },
  {
    id: 'hn',
    topic: 'стартапы и технологические обсуждения',
    priority: 80,
    markers: {
      strong: [
        'стартап', 'y combinator', 'seed round', 'show hn', 'привле инвестиции', 'венчурн',
        'startup', 'launched', 'founder', 'venture', 'seed', 'raise',
      ],
      weak: ['разработк', 'технологи', 'программирован', 'продакшн', 'tech', 'engineer', 'hacker', 'developer', 'product'],
    },
  },
]);

/**
 * Normalises a query for the marker lookup: lower case, "ё" → "е",
 * punctuation → spaces, spaces collapsed.
 *
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[-\/]+/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does one marker match the query?
 *
 * A multi-word marker is a phrase (matched in the normalised text), a
 * single-word marker matches a word by prefix.
 *
 * @param {string} marker
 * @param {string[]} words
 * @param {string} text normalised query
 * @returns {boolean}
 */
export function markerMatches(marker, words, text) {
  const needle = String(marker ?? '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!needle) return false;
  if (needle.includes(' ')) return text.includes(needle);
  return words.some((word) => word.startsWith(needle));
}

/**
 * Scores one rule against the query.
 *
 * Every DISTINCT marker counts once — a word that repeats does not inflate
 * the score.
 *
 * @param {object} rule
 * @param {string[]} words
 * @param {string} text normalised query
 * @returns {number}
 */
export function scoreRule(rule, words, text) {
  let score = 0;
  for (const marker of rule?.markers?.strong || []) {
    if (markerMatches(marker, words, text)) score += STRONG_MARKER_WEIGHT;
  }
  for (const marker of rule?.markers?.weak || []) {
    if (markerMatches(marker, words, text)) score += WEAK_MARKER_WEIGHT;
  }
  return score;
}

/**
 * Selects the verticals that fit the topic of the query.
 *
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Array<{id: string, score: number, topic: string}>}
 */
export function matchVerticals(query, options = {}) {
  const text = normalizeQuery(query);
  if (!text) return [];
  const words = text.split(' ').filter(Boolean);

  const scored = [];
  TOPIC_RULES.forEach((rule, index) => {
    const score = scoreRule(rule, words, text);
    if (score < TOPIC_MATCH_THRESHOLD) return;
    scored.push({ id: rule.id, score, topic: rule.topic, priority: rule.priority, index });
  });

  scored.sort((a, b) => (b.score - a.score) || (a.priority - b.priority) || (a.index - b.index));

  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : MAX_VERTICALS;

  return scored.slice(0, limit).map(({ id, score, topic }) => ({ id, score, topic }));
}
