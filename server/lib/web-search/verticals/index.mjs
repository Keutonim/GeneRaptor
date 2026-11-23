/**
 * Registry of the narrow verticals of the web-search layer.
 *
 * The verticals are NOT a tier of the search chain: they are consulted only
 * when the topic of the request matches the domain of a vertical (see
 * server/lib/web-search/topic-match.mjs). Every vertical is keyless, official
 * and free — there is nothing to configure and nothing to probe.
 *
 * The registry is deliberately separate from the main backend registry
 * (server/lib/web-search/index.mjs): the main registry ids are a published
 * contract of the evidence layer (every id must be a valid research
 * provider), while a vertical is a source that only appears when it fits the
 * topic.
 */
import * as openalex from './openalex.mjs';
import * as crossref from './crossref.mjs';
import * as europepmc from './europepmc.mjs';
import * as gdelt from './gdelt.mjs';
import * as nominatim from './nominatim.mjs';
import * as openlibrary from './openlibrary.mjs';
import * as stackexchange from './stackexchange.mjs';
import * as hn from './hn.mjs';

/** All verticals (display order). */
export const VERTICAL_BACKENDS = Object.freeze({
  openalex,
  crossref,
  europepmc,
  gdelt,
  nominatim,
  openlibrary,
  stackexchange,
  hn,
});

/** The ids of the verticals. */
export const VERTICAL_BACKEND_IDS = Object.freeze(Object.keys(VERTICAL_BACKENDS));

/**
 * @param {string} id
 * @returns {object|null} the vertical module
 */
export function getVerticalBackend(id) {
  return Object.prototype.hasOwnProperty.call(VERTICAL_BACKENDS, id) ? VERTICAL_BACKENDS[id] : null;
}

/**
 * Machine-readable description of the verticals — the same shape the main
 * catalog uses, so the settings page can render both lists.
 *
 * @returns {Array<object>}
 */
export function describeVerticalBackends() {
  return VERTICAL_BACKEND_IDS.map((id, order) => {
    const backend = VERTICAL_BACKENDS[id];
    return {
      id,
      label: backend.label,
      description: backend.description,
      notes: backend.notes,
      requiresKey: false,
      configured: true,
      available: true,
      envKey: null,
      official: true,
      unofficial: false,
      optIn: false,
      inAutoChain: false,
      vertical: true,
      order,
      selected: false,
    };
  });
}
