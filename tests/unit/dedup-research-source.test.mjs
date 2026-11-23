import { describe, it, expect } from 'vitest';
import {
  selectLoserIds,
  groupSourcesBySignature,
} from '../../scripts/dedup-research-source.mjs';

/**
 * These tests cover the PURE, side-effect-free helpers of the dedup script.
 * They do NOT touch the database — the DB walkthrough lives in main() and is
 * verified manually (idempotency run). This keeps the unit test deterministic
 * and fast.
 *
 * The keeper-selection contract (from IMPLEMENTATION-PLAN A1):
 *   Within a group that shares a normalized signature, keep the "most
 *   complete / freshest" record and mark the rest for deletion.
 *   Priority for the keeper:
 *     1. non-empty extractedText  (richest content wins)
 *     2. non-empty snippet
 *     3. newest fetchedAt
 *     4. highest id  (stable tiebreaker)
 */

const baseRow = {
  id: 'a',
  sourceUrl: 'https://site.ru/foo/',
  extractedText: '',
  snippet: '',
  fetchedAt: '2026-01-01T00:00:00Z',
};

describe('groupSourcesBySignature', () => {
  it('groups rows that normalize to the same signature', () => {
    const rows = [
      { ...baseRow, id: 'a', sourceUrl: 'https://site.ru/foo/' },
      { ...baseRow, id: 'b', sourceUrl: 'https://www.site.ru/foo' },
      { ...baseRow, id: 'c', sourceUrl: 'https://other.ru/bar' },
    ];
    const groups = groupSourcesBySignature(rows);
    expect(groups.size).toBe(2);
    // two rows collapsed into one group
    const fooGroup = [...groups.values()].find((g) => g.length === 2);
    expect(fooGroup.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps rows with empty signature (null url) in their own singleton groups', () => {
    const rows = [
      { ...baseRow, id: 'a', sourceUrl: '' },
      { ...baseRow, id: 'b', sourceUrl: null },
    ];
    const groups = groupSourcesBySignature(rows);
    // empty signatures are NOT grouped together (they have no dedup key)
    expect(groups.size).toBe(2);
  });
});

describe('selectLoserIds', () => {
  it('prefers the row with non-empty extractedText as keeper', () => {
    const group = [
      { ...baseRow, id: 'loser-empty', extractedText: '' },
      { ...baseRow, id: 'keeper', extractedText: 'full body text' },
    ];
    expect(selectLoserIds(group).sort()).toEqual(['loser-empty']);
  });

  it('falls back to snippet when extractedText is empty for all', () => {
    const group = [
      { ...baseRow, id: 'no-snippet', extractedText: '', snippet: '' },
      { ...baseRow, id: 'has-snippet', extractedText: '', snippet: 'lead' },
    ];
    expect(selectLoserIds(group).sort()).toEqual(['no-snippet']);
  });

  it('falls back to newest fetchedAt when text fields are equal', () => {
    const group = [
      { ...baseRow, id: 'older', fetchedAt: '2026-01-01T00:00:00Z' },
      { ...baseRow, id: 'newer', fetchedAt: '2026-06-01T00:00:00Z' },
    ];
    expect(selectLoserIds(group).sort()).toEqual(['older']);
  });

  it('returns [] for a single-row group (nothing to delete)', () => {
    const group = [{ ...baseRow, id: 'only' }];
    expect(selectLoserIds(group)).toEqual([]);
  });

  it('returns all but the keeper for a multi-row group', () => {
    const group = [
      { ...baseRow, id: 'a', extractedText: '' },
      { ...baseRow, id: 'b', extractedText: '' },
      { ...baseRow, id: 'c', extractedText: 'winner' },
      { ...baseRow, id: 'd', extractedText: '' },
    ];
    expect(selectLoserIds(group).sort()).toEqual(['a', 'b', 'd']);
  });

  it('is idempotent: running on a single-survivor group deletes nothing', () => {
    // After the first pass, the group has one row — a second pass must no-op.
    const afterFirstPass = [{ ...baseRow, id: 'c', extractedText: 'winner' }];
    expect(selectLoserIds(afterFirstPass)).toEqual([]);
  });

  it('uses highest id as a stable tiebreaker when everything is equal', () => {
    const group = [
      { ...baseRow, id: 'aaa', fetchedAt: '2026-01-01T00:00:00Z' },
      { ...baseRow, id: 'zzz', fetchedAt: '2026-01-01T00:00:00Z' },
    ];
    // keeper = highest id, so 'aaa' is the loser
    expect(selectLoserIds(group)).toEqual(['aaa']);
  });
});
