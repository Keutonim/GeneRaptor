/**
 * Redirect-wrapper unwrapping policy — pure URL parsing, ZERO network.
 *
 * Search providers may return links wrapped in a redirect hop
 * (`google.com/goto?url=…`, `google.com/url?q=…`, `bing.com/ck/a?u=…`,
 * `duckduckgo.com/l/?uddg=…`). The canonical dedup signature drops the query
 * string, so without unwrapping every such link collapses into ONE row
 * (`https://google.com/goto`) and the evidence layer loses N−1 sources.
 *
 * This module is the single rule table of the policy. It is applied in the
 * shared result normalization (`http.mjs: normalizeSearchResults`) — BEFORE
 * deduplication and BEFORE persistence — so every backend is covered by one
 * rule set.
 *
 * Safety contract (verified by tests/unit/web-search-redirect-unwrap.test.mjs):
 *   - the unwrapped target must be http(s), without embedded credentials,
 *     at most 2048 characters; anything else is DROPPED, never "unwrapped"
 *     into garbage;
 *   - at most 2 wrapper levels are unwrapped (wrapper → wrapper → target);
 *   - no network request is ever made here, and an unwrapped URL is NEVER
 *     used as the target of an outgoing request — it is untrusted provider
 *     text that only flows into sourceUrl/normalizedUrl and the UI;
 *   - a URL that matches no rule is returned byte-for-byte unchanged
 *     (`plain`), including ordinary links with a query string;
 *   - unwrapping is idempotent: the target of a wrapper matches no rule, so
 *     a second normalization pass leaves it untouched.
 *
 * Unknown wrapper forms are deliberately NOT guessed: a new form must be
 * added to the rule table explicitly.
 *
 * The legacy DuckDuckGo helper (`unwrapDuckDuckGoUrl`) keeps its historical
 * substring-based semantics verbatim — the strict policy above applies
 * to the wrapper rule table, not to that helper.
 */
import { Buffer } from 'node:buffer';

/** Maximal length of an unwrapped target URL. */
const MAX_TARGET_LENGTH = 2048;
/** Maximal number of wrapper levels unwrapped in one call. */
const MAX_UNWRAP_DEPTH = 2;

/**
 * The rule table — one entry per known wrapper form. Exact host + exact path
 * + presence of the carrier parameter; a "look-alike" URL matches nothing.
 * @type {ReadonlyArray<{id: string, hosts: string[], path: string, param: string, decode: 'percent'|'base64url'}>}
 */
const WRAPPER_RULES = Object.freeze([
  { id: 'google-url', hosts: ['google.com', 'www.google.com'], path: '/url', param: 'q', decode: 'percent' },
  { id: 'google-goto', hosts: ['google.com', 'www.google.com'], path: '/goto', param: 'url', decode: 'percent' },
  { id: 'bing-ck', hosts: ['bing.com', 'www.bing.com'], path: '/ck/a', param: 'u', decode: 'base64url' },
  {
    id: 'ddg-l',
    hosts: ['duckduckgo.com', 'www.duckduckgo.com', 'links.duckduckgo.com'],
    path: '/l/',
    param: 'uddg',
    decode: 'percent',
  },
]);

/** The ids of the known wrapper rules (observability / tests). */
export const REDIRECT_WRAPPER_IDS = Object.freeze(WRAPPER_RULES.map((rule) => rule.id));

/**
 * Match a URL against the rule table.
 *
 * @param {string} rawUrl
 * @returns {{rule: object, url: URL}|null} null when the URL is not a wrapper
 */
function matchWrapperRule(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  let value = rawUrl.trim();
  if (!value) return null;
  // Protocol-relative wrapper hrefs are resolved against https for matching.
  if (value.startsWith('//')) value = `https:${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  for (const rule of WRAPPER_RULES) {
    if (rule.hosts.includes(host) && parsed.pathname === rule.path && parsed.searchParams.has(rule.param)) {
      return { rule, url: parsed };
    }
  }
  return null;
}

/**
 * @param {string} rawUrl
 * @returns {boolean} true when the URL has a known wrapper shape (host + path
 *   + carrier parameter present), regardless of the target validity.
 */
export function isRedirectWrapperUrl(rawUrl) {
  return matchWrapperRule(rawUrl) !== null;
}

/**
 * Decode the carrier parameter of a matched wrapper.
 * `searchParams.get` already percent-decodes once; percent rules get one
 * fallback pass for a double-encoded value, base64url rules strip the optional
 * `a1` prefix and decode without padding.
 *
 * @param {object} rule
 * @param {URL} parsedUrl
 * @returns {{ok: true, value: string}|{ok: false, reason: string}}
 */
function decodeCarrier(rule, parsedUrl) {
  const raw = parsedUrl.searchParams.get(rule.param) ?? '';
  if (!raw) return { ok: false, reason: 'empty-parameter' };

  if (rule.decode === 'base64url') {
    const payload = raw.startsWith('a1') ? raw.slice(2) : raw;
    if (!payload) return { ok: false, reason: 'empty-parameter' };
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return { ok: true, value: decoded };
  }

  let value = raw;
  // One fallback pass ONLY for the clear double-encoding signature
  // (`https%3A…` after the first decode) — a legitimate target containing
  // percent sequences is never decoded twice.
  if (/^https?%3A/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the single-decoded value; validation below decides its fate.
    }
  }
  return { ok: true, value };
}

/**
 * Validate an unwrapped target: http(s) only, no credentials, bounded length.
 *
 * @param {string} target
 * @returns {{ok: true, url: string}|{ok: false, reason: string}}
 */
function validateTarget(target) {
  const value = String(target ?? '').trim();
  if (!value) return { ok: false, reason: 'empty-parameter' };
  if (value.length > MAX_TARGET_LENGTH) return { ok: false, reason: 'target-too-long' };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid-target' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'bad-scheme' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials-in-url' };
  }
  return { ok: true, url: value };
}

/**
 * Unwrap a redirect wrapper to its real target — pure parsing, no network.
 *
 * @param {string} rawUrl
 * @returns {{status: 'plain'|'unwrapped'|'dropped', url: string, wrapper: string|null, reason: string|null}}
 *   `plain`     — not a known wrapper; `url` is the input byte-for-byte;
 *   `unwrapped` — `url` is the validated target, `wrapper` the outer rule id;
 *   `dropped`   — a wrapper that cannot be unwrapped safely; `url` is '',
 *                 `reason` a stable code (empty-parameter / invalid-target /
 *                 bad-scheme / credentials-in-url / target-too-long /
 *                 depth-exceeded).
 */
export function unwrapRedirectUrl(rawUrl) {
  const original = typeof rawUrl === 'string' ? rawUrl : '';
  const first = matchWrapperRule(original);
  if (!first) return { status: 'plain', url: original, wrapper: null, reason: null };

  const wrapperId = first.rule.id;
  let current = first;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const decoded = decodeCarrier(current.rule, current.url);
    if (!decoded.ok) return { status: 'dropped', url: '', wrapper: wrapperId, reason: decoded.reason };
    const validated = validateTarget(decoded.value);
    if (!validated.ok) return { status: 'dropped', url: '', wrapper: wrapperId, reason: validated.reason };

    const next = matchWrapperRule(validated.url);
    if (!next) return { status: 'unwrapped', url: validated.url, wrapper: wrapperId, reason: null };
    current = next;
  }
  // A further wrapper level exceeds the depth limit — drop, do not guess.
  return { status: 'dropped', url: '', wrapper: wrapperId, reason: 'depth-exceeded' };
}

/**
 * Unwraps the DuckDuckGo redirect wrapper (`/l/?uddg=<encoded target>`).
 *
 * LEGACY SEMANTICS — moved verbatim from duckduckgo.mjs: `uddg=` is
 * searched as a substring, protocol-relative hrefs become https, and anything
 * non-http(s) yields ''. The strict rule-table policy above does NOT apply
 * here; this helper exists for the opt-in HTML scraper contract.
 *
 * @param {string} href
 * @returns {string} an absolute http(s) URL, or '' when unusable
 */
export function unwrapDuckDuckGoUrl(href) {
  if (!href || typeof href !== 'string') return '';
  let value = href.trim();
  if (!value) return '';

  if (value.startsWith('//')) value = `https:${value}`;

  const uddgIndex = value.indexOf('uddg=');
  if (uddgIndex !== -1) {
    const raw = value.slice(uddgIndex + 5).split('&')[0];
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
  }

  if (!/^https?:\/\//i.test(value)) return '';
  return value;
}
