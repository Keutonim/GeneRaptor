/**
 * GeneRaptor grep gate for the removed out-of-scope features.
 *
 * The stripped OUT-of-scope features must leave ZERO traces in the shipped
 * source trees (server/ and src/). Tests and docs are excluded per plan —
 * they legitimately talk about the strip itself.
 *
 * Patterns (case-sensitive, substring — mirrors the CI gate):
 *   wordstat | runCrawl | maybeRefreshStaleSource | auto-gener |
 *   platform-adapter | publisher
 *
 * The scan is deliberately line-oriented so a failure prints the offending
 * file:line for immediate fixing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['server', 'src'];
const SCAN_EXT = /\.(mjs|ts|tsx|css|html)$/;
const PATTERNS = [
  'wordstat',
  'runCrawl',
  'maybeRefreshStaleSource',
  'auto-gener',
  'platform-adapter',
  'publisher',
];

/** Recursively collect scanned source files (server/ + src/, code files only). */
function collectFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // runtime outputs and node deps are not shipped source
      if (entry === 'runtime' || entry === 'node_modules') continue;
      collectFiles(full, acc);
    } else if (SCAN_EXT.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** All (file, line, pattern) hits — empty array == gate green. */
function scanHits() {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    let files;
    try {
      files = collectFiles(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const pattern of PATTERNS) {
          if (line.includes(pattern)) {
            hits.push({ file: relative(ROOT, file), line: i + 1, pattern, text: line.trim().slice(0, 120) });
          }
        }
      });
    }
  }
  return hits;
}

describe('M2 strip gate: zero stripped-feature traces in server/ and src/', () => {
  it('no wordstat/runCrawl/maybeRefreshStaleSource/auto-gener/platform-adapter/publisher hits', () => {
    const hits = scanHits();
    if (hits.length) {
      const report = hits
        .slice(0, 40)
        .map((h) => `${h.file}:${h.line} [${h.pattern}] ${h.text}`)
        .join('\n');
      throw new Error(`strip gate failed — ${hits.length} hit(s):\n${report}`);
    }
    expect(hits).toHaveLength(0);
  });
});
