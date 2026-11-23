/**
 * Line-ending contract guard (factory hardening round, item 7a).
 *
 * Root cause of the D-C2-1 blocker: the repository shipped NO `.gitattributes`,
 * so a checkout on a host with `core.autocrlf=true` materialised CRLF line
 * endings. Vite's SSR transform strips a `#!` hashbang only when the line is
 * LF-terminated (`hashbangRE = /^#!.*\n/`), so a CRLF-terminated shebang
 * survived the transform, the imported module failed to parse and the whole
 * vitest suite collected 0 tests.
 *
 * The guard pins git's OWN behaviour (attribute resolution + index content),
 * not the text of the attribute file: every text file of the repository must
 * resolve to `eol=lf`, the index must keep LF blobs and the NUL-byte fixture
 * must stay excluded from text normalisation.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const ATTRS_PATH = join(ROOT, '.gitattributes');

/** Run git inside the repository; returns stdout or null when git fails. */
function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout;
}

const isGitCheckout = git(['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';

const TEXT_FILES = [
  'server/index.mjs',
  'server/agent-role-data.mjs',
  'src/main.tsx',
  'package.json',
  'README.md',
  '.github/workflows/ci.yml',
  'prisma/schema.prisma',
  'index.html',
  'src/styles.css',
];

describe('.gitattributes — line-ending contract (D-C2-1 portability)', () => {
  it('the repository root ships a non-empty .gitattributes', () => {
    expect(
      existsSync(ATTRS_PATH),
      '.gitattributes is missing at the repository root — CRLF checkouts can break Vite imports',
    ).toBe(true);
    expect(readFileSync(ATTRS_PATH, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it.skipIf(!isGitCheckout)('git resolves eol=lf for every tracked text file', () => {
    for (const file of TEXT_FILES) {
      const out = git(['check-attr', 'eol', '--', file]);
      expect(out, `git check-attr failed for ${file}`).not.toBeNull();
      expect(out.trim(), `${file} must be checked out with LF line endings`).toBe(`${file}: eol: lf`);
    }
  });

  it.skipIf(!isGitCheckout)('the index stores LF blobs — no CRLF is committed', () => {
    const out = git(['ls-files', '--eol']);
    expect(out, 'git ls-files --eol failed').not.toBeNull();
    const crlf = out.split('\n').filter((line) => line.startsWith('i/crlf'));
    expect(crlf, `CRLF blobs found in the index: ${crlf.join(' | ')}`).toHaveLength(0);
  });

  it.skipIf(!isGitCheckout)('the NUL-byte fixture stays excluded from text normalisation', () => {
    const out = git(['check-attr', 'text', '--', 'tests/unit/db-bootstrap.test.mjs']);
    expect(out.trim()).toBe('tests/unit/db-bootstrap.test.mjs: text: unset');
  });
});
