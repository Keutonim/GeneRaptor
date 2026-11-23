/**
 * Contract tests for the topic matcher of the web-search verticals.
 *
 * The matcher is a pure function: it decides which narrow vertical sources
 * fit the topic of a query. It must be deterministic, bilingual (RU + EN),
 * strict enough not to fire on neutral topics and bounded (at most
 * MAX_VERTICALS verticals per request).
 */
import { describe, it, expect } from 'vitest';
import {
  matchVerticals,
  TOPIC_RULES,
  TOPIC_MATCH_THRESHOLD,
  MAX_VERTICALS,
} from '../../server/lib/web-search/topic-match.mjs';

const ids = (matches) => matches.map((m) => m.id);

describe('topic matcher — marker table', () => {
  it('declares a rule per vertical with a topic and both marker weights', () => {
    expect(Array.isArray(TOPIC_RULES)).toBe(true);
    expect(TOPIC_RULES.length).toBeGreaterThanOrEqual(8);
    for (const rule of TOPIC_RULES) {
      expect(typeof rule.id).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
      expect(typeof rule.topic).toBe('string');
      expect(Array.isArray(rule.markers.strong)).toBe(true);
      expect(Array.isArray(rule.markers.weak)).toBe(true);
      expect(rule.markers.strong.length).toBeGreaterThan(0);
    }
  });

  it('carries both Russian and English markers', () => {
    const all = TOPIC_RULES.flatMap((rule) => [...rule.markers.strong, ...rule.markers.weak]);
    expect(all.some((marker) => /[\u0400-\u04ff]/.test(marker))).toBe(true);
    expect(all.some((marker) => /^[a-z0-9 .'-]+$/i.test(marker))).toBe(true);
  });

  it('uses the threshold 2 and the cap of 2 verticals', () => {
    expect(TOPIC_MATCH_THRESHOLD).toBe(2);
    expect(MAX_VERTICALS).toBe(2);
  });
});

describe('topic matcher — selection', () => {
  it('selects the biomedical vertical for a treatment query', () => {
    const matches = matchVerticals('лечение диабета инсулином');
    expect(ids(matches)).toContain('europepmc');
  });

  it('selects the science vertical for an English research query', () => {
    const matches = matchVerticals('climate change research paper');
    expect(ids(matches)).toContain('openalex');
  });

  it('selects the QA vertical for a programming error query', () => {
    const matches = matchVerticals('python traceback how to fix');
    expect(ids(matches)).toContain('stackexchange');
  });

  it('selects the books vertical for a literature query', () => {
    const matches = matchVerticals('роман автора книга');
    expect(ids(matches)).toContain('openlibrary');
  });

  it('selects the news vertical for a world-events query', () => {
    const matches = matchVerticals('выборы и протесты в мире');
    expect(ids(matches)).toContain('gdelt');
  });

  it('does not select any vertical for a neutral history topic', () => {
    expect(matchVerticals('история России XVII века')).toEqual([]);
  });

  it('does not select any vertical for a neutral cooking topic', () => {
    expect(matchVerticals('кулинария и рецепты')).toEqual([]);
  });

  it('does not select a vertical for a word that only looks like a marker', () => {
    // "industrial" contains "trial" as a substring — a substring match would
    // fire the biomedical vertical here.
    expect(ids(matchVerticals('industrial equipment manufacturing'))).not.toContain('europepmc');
  });

  it('does not select a vertical for a word that only contains a marker', () => {
    // "notebook" contains the marker "book", but it is not a book: a
    // substring match would fire the books vertical here.
    expect(ids(matchVerticals('notebook reviews'))).not.toContain('openlibrary');
  });
});

describe('topic matcher — scoring', () => {
  it('does not select a vertical for a single weak marker', () => {
    expect(matchVerticals('код')).toEqual([]);
  });

  it('selects a vertical for two weak markers', () => {
    const matches = matchVerticals('код программирования');
    expect(ids(matches)).toContain('stackexchange');
  });

  it('scores a strong marker as 2 and a weak marker as 1', () => {
    const strong = matchVerticals('диагноз');
    expect(strong.find((m) => m.id === 'europepmc').score).toBeGreaterThanOrEqual(
      TOPIC_MATCH_THRESHOLD,
    );

    const weakOnly = matchVerticals('витамин');
    expect(weakOnly).toEqual([]);
  });

  it('ignores the case and the punctuation of the query', () => {
    expect(ids(matchVerticals('ЛЕЧЕНИЕ Диабета!'))).toEqual(ids(matchVerticals('лечение диабета')));
  });

  it('keeps the result deterministic', () => {
    const query = 'научная публикация про лечение диабета и мировые новости';
    expect(ids(matchVerticals(query))).toEqual(ids(matchVerticals(query)));
  });

  it('caps the number of selected verticals', () => {
    const query = 'научная публикация про лечение диабета и мировые новости';
    const matches = matchVerticals(query);
    expect(matches.length).toBeLessThanOrEqual(MAX_VERTICALS);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query', () => {
    expect(matchVerticals('')).toEqual([]);
    expect(matchVerticals('   ')).toEqual([]);
  });

  it('handles a mixed RU/EN query', () => {
    const matches = matchVerticals('treatment of diabetes: симптомы и терапия');
    expect(ids(matches)).toContain('europepmc');
  });

  it('never returns a vertical with a score below the threshold', () => {
    const matches = matchVerticals('новости книги адрес ошибка');
    for (const match of matches) {
      expect(match.score).toBeGreaterThanOrEqual(TOPIC_MATCH_THRESHOLD);
    }
  });
});
