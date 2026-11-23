/**
 * Comment-drift guard for the pipeline role count (factory hardening round,
 * item H-02).
 *
 * Root cause of the drift: the M2 cut shortened the generation chain from 13
 * roles to 11, but a handful of source comments kept the old number. Nobody
 * noticed because comments are not executable — so the drift had to be
 * pinned by a test.
 *
 * Contract enforced here:
 *   - the runtime catalog is the single source of truth for the chain length;
 *   - EVERY "N ролей / N roles / N генерируемых статусов" statement in the
 *     shipped code must equal the catalog length;
 *   - the only allowed exception is an explicit migration note of the form
 *     "13 -> 11" (historical record of the M2 cut, kept verbatim in the two
 *     historical unit tests).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { agentRoleData } from '../../server/agent-role-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * Join token fragments — keeps the literal names of the two catalogs that are
 * NOT published with this product out of this file. Both of them can sit next
 * to the checkout (a sibling project catalog and the local factory
 * workspace), so the drift scan must skip them — but spelling their names out
 * would leave a dangling pointer to an unpublished directory in the published
 * repository. The behaviour is identical: the same directories are skipped.
 */
const t = (...parts) => parts.join('');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.prisma',
  t('legacy', '-baseline'),
  'docs',
  t('factory', '-workspace'),
  'test-results',
  'playwright-report',
]);

const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.tsx', '.cjs']);

function collectCodeFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectCodeFiles(full, out);
    } else if (CODE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Role-count statements that describe the CURRENT chain.
 * NOTE: `\b` is ASCII-only in JS, so it never fires after a Cyrillic word —
 * the letter-boundary is spelled out with a Unicode lookahead instead.
 */
const COUNT_PATTERNS = [
  /(\d+)[-\s]+рол(?:ей|я|и|ям|ь)(?![\p{L}])/giu,
  /(\d+)[-\s]+roles?(?![\p{L}])/giu,
  /(\d+)\s+генерируемых\s+статусов/giu,
];

/** "13 -> 11" — the documented M2 migration, allowed to mention the old count. */
const MIGRATION_NOTE = /13\s*->\s*11/;

const files = [
  ...collectCodeFiles(join(ROOT, 'server')),
  ...collectCodeFiles(join(ROOT, 'src')),
  ...collectCodeFiles(join(ROOT, 'scripts')),
  ...collectCodeFiles(join(ROOT, 'tests')),
  join(ROOT, 'start.mjs'),
].filter((file) => existsSyncSafe(file));

function existsSyncSafe(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

describe('role-count comment drift (catalog length is the single source of truth)', () => {
  it('the runtime catalog holds the 11-role M2 chain', () => {
    expect(agentRoleData).toHaveLength(11);
  });

  it('no shipped code states a role count other than the catalog length', () => {
    const offenders = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (MIGRATION_NOTE.test(line)) return;
        for (const pattern of COUNT_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(line)) !== null) {
            if (Number(match[1]) !== agentRoleData.length) {
              offenders.push(
                `${relative(ROOT, file)}:${index + 1} — "${match[0].trim()}" (catalog has ${agentRoleData.length})`,
              );
            }
          }
        }
      });
    }
    expect(offenders, `stale role-count statements:\n${offenders.join('\n')}`).toEqual([]);
  });
});
