/**
 * Contract tests for the narrow verticals of the web-search layer.
 *
 * Every vertical is keyless, official and free: no credential, a fixed
 * endpoint, the shared research User-Agent and a stable response shape
 * `{ title, url, snippet }`. A broken provider must degrade into a typed
 * error code — never into a thrown exception and never into a wrong result.
 *
 * No network is used here: `fetchImpl` is injected in every case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  VERTICAL_BACKENDS,
  VERTICAL_BACKEND_IDS,
  getVerticalBackend,
} from '../../server/lib/web-search/verticals/index.mjs';

// The throttled verticals keep their state between the requests of the
// process — the tests start every case from a clean throttle.
beforeEach(() => {
  for (const id of VERTICAL_BACKEND_IDS) {
    VERTICAL_BACKENDS[id].resetThrottle?.();
  }
});

function jsonResponse(payload, init = {}) {
  return {
    ok: init.ok !== false,
    status: init.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function captureFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return { calls, fetchImpl };
}

/**
 * One case per vertical: the endpoint it must call, a provider payload and
 * the contract mapping it must produce.
 */
const CASES = [
  {
    id: 'openalex',
    endpoint: 'https://api.openalex.org/works',
    payload: {
      results: [
        {
          display_name: 'Work A',
          doi: 'https://doi.org/10.1/a',
          publication_year: 2024,
          primary_location: {
            landing_page_url: 'https://example.org/work-a',
            source: { display_name: 'Journal A' },
          },
          authorships: [{ author: { display_name: 'Ivanov' } }],
        },
      ],
    },
    expected: { title: 'Work A', url: 'https://example.org/work-a' },
    snippetIncludes: 'Ivanov',
    query: 'research on work a',
  },
  {
    id: 'crossref',
    endpoint: 'https://api.crossref.org/works',
    payload: {
      message: {
        items: [
          {
            title: ['Crossref work'],
            URL: 'https://doi.org/10.1/b',
            DOI: '10.1/b',
            publisher: 'Publisher B',
            'container-title': ['Journal B'],
            issued: { 'date-parts': [[2023]] },
          },
        ],
      },
    },
    expected: { title: 'Crossref work', url: 'https://doi.org/10.1/b' },
    snippetIncludes: 'Journal B',
    query: 'doi of the work',
  },
  {
    id: 'europepmc',
    endpoint: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search',
    payload: {
      resultList: {
        result: [
          {
            title: 'Europe work',
            authorString: 'Petrov P.',
            journalTitle: 'Journal C',
            pubYear: '2022',
            pmid: '12345678',
          },
        ],
      },
    },
    expected: { title: 'Europe work', url: 'https://europepmc.org/article/MED/12345678' },
    snippetIncludes: 'Journal C',
    query: 'clinical study of the therapy',
  },
  {
    id: 'gdelt',
    endpoint: 'https://api.gdeltproject.org/api/v2/doc/doc',
    payload: {
      articles: [
        {
          title: 'World news A',
          url: 'https://news.example/a',
          domain: 'news.example',
          seendate: '20240101T000000Z',
        },
      ],
    },
    expected: { title: 'World news A', url: 'https://news.example/a' },
    snippetIncludes: 'news.example',
    query: 'election news today',
  },
  {
    id: 'nominatim',
    endpoint: 'https://nominatim.openstreetmap.org/search',
    payload: [
      {
        display_name: 'Place A, Country',
        lat: '1.5',
        lon: '2.5',
        type: 'city',
        class: 'place',
        address: { city: 'Place A' },
      },
    ],
    expected: { title: 'Place A, Country', url: 'https://www.openstreetmap.org/?mlat=1.5&mlon=2.5' },
    snippetIncludes: 'city',
    query: 'address of the place',
  },
  {
    id: 'openlibrary',
    endpoint: 'https://openlibrary.org/search.json',
    payload: {
      numFound: 1,
      docs: [
        {
          key: '/works/OL1W',
          title: 'Book A',
          author_name: ['Author A'],
          first_publish_year: 1999,
        },
      ],
    },
    expected: { title: 'Book A', url: 'https://openlibrary.org/works/OL1W' },
    snippetIncludes: 'Author A',
    query: 'the novel of the author',
  },
  {
    id: 'stackexchange',
    endpoint: 'https://api.stackexchange.com/2.3/search/advanced',
    payload: {
      items: [
        {
          title: 'Question about python',
          link: 'https://stackoverflow.com/questions/1/x',
          body_markdown: 'The traceback says ...',
        },
      ],
    },
    expected: { title: 'Question about python', url: 'https://stackoverflow.com/questions/1/x' },
    snippetIncludes: 'traceback',
    query: 'python traceback error',
  },
  {
    id: 'hn',
    endpoint: 'https://hn.algolia.com/api/v1/search',
    payload: {
      hits: [
        {
          title: 'Show HN: project A',
          url: 'https://hn.example/a',
          objectID: '4242',
          story_text: 'a startup story',
          points: 10,
          num_comments: 2,
        },
      ],
    },
    expected: { title: 'Show HN: project A', url: 'https://hn.example/a' },
    snippetIncludes: 'startup',
    query: 'show hn startup launch',
  },
];

describe('verticals — registry', () => {
  it('registers the eight narrow verticals', () => {
    expect(VERTICAL_BACKEND_IDS).toEqual([
      'openalex',
      'crossref',
      'europepmc',
      'gdelt',
      'nominatim',
      'openlibrary',
      'stackexchange',
      'hn',
    ]);
  });

  it('exposes a backend module per vertical', () => {
    for (const id of VERTICAL_BACKEND_IDS) {
      const backend = getVerticalBackend(id);
      expect(backend).toBeTruthy();
      expect(backend.id).toBe(id);
      expect(typeof backend.search).toBe('function');
    }
    expect(getVerticalBackend('nope')).toBeNull();
  });

  it('marks every vertical as keyless and official', () => {
    for (const id of VERTICAL_BACKEND_IDS) {
      const backend = VERTICAL_BACKENDS[id];
      expect(backend.requiresKey).toBe(false);
      expect(backend.envKey).toBeNull();
      expect(backend.official).toBe(true);
      expect(backend.vertical).toBe(true);
      expect(backend.isConfigured()).toBe(true);
      expect(typeof backend.description).toBe('string');
      expect(backend.description.length).toBeGreaterThan(0);
    }
  });
});

describe('verticals — contract', () => {
  for (const testCase of CASES) {
    it(`maps the payload of ${testCase.id} to the contract shape`, async () => {
      const backend = getVerticalBackend(testCase.id);
      const { calls, fetchImpl } = captureFetch(async () => jsonResponse(testCase.payload));

      const results = await backend.search(testCase.query, { limit: 5, fetchImpl });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe(testCase.expected.title);
      expect(results[0].url).toBe(testCase.expected.url);
      expect(typeof results[0].snippet).toBe('string');
      expect(results[0].snippet).toContain(testCase.snippetIncludes);
      expect(calls[0].url.startsWith(testCase.endpoint)).toBe(true);
    });

    it(`sends the research User-Agent and no credential to ${testCase.id}`, async () => {
      const backend = getVerticalBackend(testCase.id);
      const { calls, fetchImpl } = captureFetch(async () => jsonResponse(testCase.payload));

      await backend.search(testCase.query, { limit: 5, fetchImpl });

      const ua = String(calls[0].options.headers?.['User-Agent'] || '');
      expect(ua).toContain('GeneRaptor');
      const headers = JSON.stringify(calls[0].options.headers || {});
      expect(headers).not.toContain('X-API-KEY');
      expect(headers).not.toContain('Authorization');
    });

    it(`maps HTTP 429 of ${testCase.id} to an exhausted quota`, async () => {
      const backend = getVerticalBackend(testCase.id);
      const fetchImpl = async () => jsonResponse({}, { ok: false, status: 429 });

      await expect(backend.search(testCase.query, { limit: 5, fetchImpl }))
        .rejects.toMatchObject({ code: 'quota_exhausted' });
    });

    it(`maps HTTP 402 of ${testCase.id} to an exhausted quota`, async () => {
      const backend = getVerticalBackend(testCase.id);
      const fetchImpl = async () => jsonResponse({}, { ok: false, status: 402 });

      await expect(backend.search(testCase.query, { limit: 5, fetchImpl }))
        .rejects.toMatchObject({ code: 'quota_exhausted' });
    });

    it(`maps HTTP 403 of ${testCase.id} to a not-configured error`, async () => {
      const backend = getVerticalBackend(testCase.id);
      const fetchImpl = async () => jsonResponse({}, { ok: false, status: 403 });

      await expect(backend.search(testCase.query, { limit: 5, fetchImpl }))
        .rejects.toMatchObject({ code: 'not_configured' });
    });

    it(`maps a broken response of ${testCase.id} to an invalid response`, async () => {
      const backend = getVerticalBackend(testCase.id);
      const fetchImpl = async () => jsonResponse({});

      await expect(backend.search(testCase.query, { limit: 5, fetchImpl }))
        .rejects.toMatchObject({ code: 'invalid_response' });
    });
  }

  it('returns an empty list when the provider has no hits', async () => {
    const backend = getVerticalBackend('openalex');
    const fetchImpl = async () => jsonResponse({ results: [] });

    const results = await backend.search('nothing at all', { limit: 5, fetchImpl });

    expect(results).toEqual([]);
  });

  it('drops an entry without a usable http url', async () => {
    const backend = getVerticalBackend('openalex');
    const fetchImpl = async () =>
      jsonResponse({
        results: [{ display_name: 'No url', doi: null, primary_location: null }],
      });

    const results = await backend.search('broken record', { limit: 5, fetchImpl });

    expect(results).toEqual([]);
  });
});

describe('verticals — provider limits', () => {
  it('keeps the GDELT request inside the published limits', async () => {
    const backend = getVerticalBackend('gdelt');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ articles: [] }));

    await backend.search('world news', { limit: 5, fetchImpl });

    const url = calls[0].url;
    expect(url).toContain('maxrecords=');
    expect(Number(new URL(url).searchParams.get('maxrecords'))).toBeLessThanOrEqual(250);
    expect(new URL(url).searchParams.get('timespan')).toBe('3m');
  });

  it('sends the officially documented output mode of GDELT (mode=ArtList)', async () => {
    const backend = getVerticalBackend('gdelt');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ articles: [] }));

    await backend.search('world news', { limit: 5, fetchImpl });

    // The official GDELT DOC 2.0 documentation names the output mode `ArtList`
    // (capital A and L) — see results/search-verticals-api-spec.md §6.1 [оф].
    expect(new URL(calls[0].url).searchParams.get('mode')).toBe('ArtList');
    expect(new URL(calls[0].url).searchParams.get('format')).toBe('json');
  });

  it('throttles the GDELT vertical to one request per five seconds', async () => {
    // The live 429 body of GDELT asks for "one every 5 seconds" —
    // results/search-verticals-api-spec.md §6.3 / conflict 8 [live].
    const backend = getVerticalBackend('gdelt');
    backend.resetThrottle?.();
    const sleeps = [];
    const fetchImpl = async () => jsonResponse({ articles: [] });

    await backend.search('world news a', {
      limit: 3,
      fetchImpl,
      now: () => 30_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await backend.search('world news b', {
      limit: 3,
      fetchImpl,
      now: () => 30_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(5000);
  });

  it('keeps the StackExchange request inside the published limits', async () => {
    const backend = getVerticalBackend('stackexchange');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ items: [] }));

    await backend.search('python error', { limit: 5, fetchImpl });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('site')).toBe('stackoverflow');
    expect(Number(url.searchParams.get('pagesize'))).toBeLessThanOrEqual(100);
  });

  it('throttles the Nominatim vertical to one request per second', async () => {
    const backend = getVerticalBackend('nominatim');
    backend.resetThrottle();
    const sleeps = [];
    const fetchImpl = async () => jsonResponse([]);

    await backend.search('place a', {
      limit: 3,
      fetchImpl,
      now: () => 10_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await backend.search('place b', {
      limit: 3,
      fetchImpl,
      now: () => 10_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it('throttles the OpenLibrary vertical to one request per second', async () => {
    const backend = getVerticalBackend('openlibrary');
    backend.resetThrottle();
    const sleeps = [];
    const fetchImpl = async () => jsonResponse({ numFound: 0, docs: [] });

    await backend.search('book a', {
      limit: 3,
      fetchImpl,
      now: () => 20_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await backend.search('book b', {
      limit: 3,
      fetchImpl,
      now: () => 20_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it('turns the StackExchange backoff signal into an exhausted quota', async () => {
    const backend = getVerticalBackend('stackexchange');
    const fetchImpl = async () => jsonResponse({ items: [], backoff: 30 });

    await expect(backend.search('python error', { limit: 5, fetchImpl }))
      .rejects.toMatchObject({ code: 'quota_exhausted' });
  });
});

/**
 * Alignment with results/search-verticals-api-spec.md (2026-11-17): the
 * mapping formulas below follow the fields confirmed [оф]/[live] there.
 */
describe('verticals — API spec alignment', () => {
  it('reconstructs the OpenAlex abstract from the inverted index', async () => {
    // OpenAlex ships no plaintext abstract — the snippet must be rebuilt
    // from abstract_inverted_index (spec §3.2 [оф+live]).
    const backend = getVerticalBackend('openalex');
    const fetchImpl = async () => jsonResponse({
      results: [{
        display_name: 'Work B',
        primary_location: { landing_page_url: 'https://example.org/work-b' },
        abstract_inverted_index: {
          growing: [1], Despite: [0], interest: [2], in: [3], science: [4],
        },
      }],
    });

    const results = await backend.search('research work b', { limit: 5, fetchImpl });

    expect(results[0].snippet).toContain('Despite growing interest in science');
  });

  it('falls back to the OpenAlex title alias when display_name is null', async () => {
    // display_name is "String or null"; title is its official alias
    // (spec §3.2 [оф]).
    const backend = getVerticalBackend('openalex');
    const fetchImpl = async () => jsonResponse({
      results: [{
        display_name: null,
        title: 'Alias title',
        primary_location: { landing_page_url: 'https://example.org/work-c' },
      }],
    });

    const results = await backend.search('research work c', { limit: 5, fetchImpl });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Alias title');
  });

  it('prefers the abstractText and the DOI full-text url of Europe PMC core records', async () => {
    // spec §5.2 [live]: abstractText → snippet, fullTextUrlList (site DOI)
    // → url; the constructed article url stays the fallback.
    const backend = getVerticalBackend('europepmc');
    const fetchImpl = async () => jsonResponse({
      resultList: {
        result: [{
          title: 'Core work',
          pmid: '999',
          authorString: 'Sidorov S.',
          journalTitle: 'Journal D',
          pubYear: '2021',
          abstractText: '<p>A clinical abstract.</p>',
          fullTextUrlList: {
            fullTextUrl: [
              { availability: 'Open', site: 'DOI', url: 'https://doi.org/10.1/core' },
            ],
          },
        }],
      },
    });

    const results = await backend.search('clinical core work', { limit: 5, fetchImpl });

    expect(results[0].url).toBe('https://doi.org/10.1/core');
    expect(results[0].snippet).toContain('A clinical abstract.');
    expect(results[0].snippet).not.toContain('<p>');
  });

  it('asks Europe PMC for the core result type that carries the abstract', async () => {
    const backend = getVerticalBackend('europepmc');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ resultList: { result: [] } }));

    await backend.search('clinical study', { limit: 5, fetchImpl });

    expect(new URL(calls[0].url).searchParams.get('resultType')).toBe('core');
    expect(new URL(calls[0].url).searchParams.get('format')).toBe('json');
  });

  it('maps an HN comment with title:null to the story title and the discussion url', async () => {
    // spec §10 [live]: a comment hit has title:null and url:null; the title
    // comes from story_title, the url falls back to the HN discussion item.
    const backend = getVerticalBackend('hn');
    const fetchImpl = async () => jsonResponse({
      hits: [{
        title: null,
        url: null,
        story_title: 'Ask HN: Who is hiring?',
        story_url: null,
        comment_text: '<p>ABI Research | Oyster Bay</p>',
        objectID: '777',
        author: 'someone',
      }],
    });

    const results = await backend.search('who is hiring', { limit: 5, fetchImpl });

    expect(results[0].title).toBe('Ask HN: Who is hiring?');
    expect(results[0].url).toBe('https://news.ycombinator.com/item?id=777');
    expect(results[0].snippet).toContain('ABI Research');
    expect(results[0].snippet).not.toContain('<p>');
  });

  it('does not restrict the HN request to stories — comments must be able to arrive', async () => {
    // The title:null nuance of the brief only matters when comment hits can
    // reach the mapper (spec §10 [live]) — a tags=story filter would make the
    // comment mapping dead code.
    const backend = getVerticalBackend('hn');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ hits: [] }));

    await backend.search('startup discussion', { limit: 5, fetchImpl });

    expect(new URL(calls[0].url).searchParams.get('tags')).toBeNull();
  });

  it('prefers the story_url of an HN hit without its own url', async () => {
    const backend = getVerticalBackend('hn');
    const fetchImpl = async () => jsonResponse({
      hits: [{
        title: null,
        url: null,
        story_title: 'Story',
        story_url: 'https://story.example/x',
        objectID: '778',
      }],
    });

    const results = await backend.search('story', { limit: 5, fetchImpl });

    expect(results[0].url).toBe('https://story.example/x');
  });

  it('prefers the Crossref abstract (cleaned of XML) over the journal line', async () => {
    // spec §4.2 [live]: snippet priority is abstract (strip the JATS-like
    // XML) → container-title + issued. The abstract is not on every record.
    const backend = getVerticalBackend('crossref');
    const fetchImpl = async () => jsonResponse({
      message: {
        items: [{
          title: ['Crossref abstract work'],
          URL: 'https://doi.org/10.1/d',
          'container-title': ['Journal F'],
          issued: { 'date-parts': [[2024]] },
          abstract: '<jats:p>An abstract of the work.</jats:p>',
        }],
      },
    });

    const results = await backend.search('doi abstract work', { limit: 5, fetchImpl });

    expect(results[0].snippet).toContain('An abstract of the work.');
    expect(results[0].snippet).not.toContain('jats');
  });

  it('sends Accept-Encoding: gzip to StackExchange (the compression contract)', async () => {
    // spec §9.4 [оф]: "always set the Accept-Encoding header". Node fetch
    // decompresses the response transparently, so the body parses as JSON.
    const backend = getVerticalBackend('stackexchange');
    const { calls, fetchImpl } = captureFetch(async () => jsonResponse({ items: [] }));

    await backend.search('python error', { limit: 5, fetchImpl });

    expect(calls[0].options.headers['Accept-Encoding']).toBe('gzip');
  });

  it('turns an exhausted StackExchange quota_remaining into an exhausted quota', async () => {
    // spec conflict 1 [live]: the keyless quota is read from the wrapper
    // (quota_max/quota_remaining), not from a hardcoded constant.
    const backend = getVerticalBackend('stackexchange');
    const fetchImpl = async () => jsonResponse({ items: [], quota_max: 300, quota_remaining: 0 });

    await expect(backend.search('python error', { limit: 5, fetchImpl }))
      .rejects.toMatchObject({ code: 'quota_exhausted' });
  });
});
