/**
 * Contract tests for the universal gate allowance of the vertical markers.
 *
 * The marker table of the narrow verticals carries the vocabulary of those
 * domains on purpose — that vocabulary IS the matching mechanism. The gate
 * therefore gets exactly ONE narrow, file-scoped and explicitly enumerated
 * allowance for it — and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ROOT,
  STRUCTURAL_ID_CLASSES,
  runGate,
  scanText,
} from '../../scripts/universal-gate.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = resolve(REPO_ROOT, 'scripts/universal-gate.mjs');
const MARKER_TABLE = 'server/lib/web-search/topic-match.mjs';

describe('universal gate — vertical domain markers', () => {
  it('declares exactly one narrow category for the vertical markers', () => {
    const classes = STRUCTURAL_ID_CLASSES.filter((cls) => cls.id.startsWith('vertical-domain-marker:'));

    expect(classes).toHaveLength(1);
    const [cls] = classes;
    expect(cls.files).toContain(MARKER_TABLE);
    expect(Array.isArray(cls.identifiers)).toBe(true);
    expect(cls.identifiers.length).toBeGreaterThan(0);
    expect(String(cls.reason).trim().length).toBeGreaterThan(20);
  });

  it('keeps the allowance inside the marker table', () => {
    const [cls] = STRUCTURAL_ID_CLASSES.filter((c) => c.id.startsWith('vertical-domain-marker:'));

    for (const file of cls.files) {
      expect(file.startsWith('server/lib/web-search/')).toBe(true);
    }
  });

  it('reports the domain words of the marker table as findings without the allowance', () => {
    const table = readFileSync(resolve(REPO_ROOT, MARKER_TABLE), 'utf8');
    const hits = scanText(table, MARKER_TABLE);

    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not report the marker table as a finding of the shipped gate', () => {
    const { hits } = runGate({ root: DEFAULT_ROOT });

    expect(hits.filter((hit) => hit.file === MARKER_TABLE)).toEqual([]);
  });

  it('still reports the same words outside the allowed scope', () => {
    const hits = scanText('const marker = "диагноз";', 'server/lib/web-search/not-allowed.mjs');

    expect(hits.length).toBeGreaterThan(0);
  });

  it('keeps the universal gate green on the shipped tree', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 forbidden tokens');
  });
});
