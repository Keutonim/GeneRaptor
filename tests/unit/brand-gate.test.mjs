import { beforeAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  DEFAULT_ROOT,
  FORBIDDEN_PATTERNS,
  collectShippedFiles,
  runGate,
  scanText,
} from '../../scripts/brand-gate.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE_ROOT = resolve(REPO_ROOT, 'tests/fixtures/brand-gate');
const SCRIPT = resolve(REPO_ROOT, 'scripts/brand-gate.mjs');
const SUITE_PATH = fileURLToPath(import.meta.url);

/**
 * The fixture carries ONE catalog directory that the gate must not scan.
 * Its name is the name of an unpublished project catalog, so it is DISCOVERED
 * from the fixture tree instead of being spelled out here: a shipped test must
 * not carry a dangling pointer to a directory that is not published.
 */
const FIXTURE_CATALOG_DIRS = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      !['src', 'server', 'scripts', 'prisma', 'docs', 'tests'].includes(entry.name)
  )
  .map((entry) => entry.name);

/**
 * Regression guard for D-C2-1 — an imported module must not start with a `#!`
 * hashbang.
 *
 * A `#!` hashbang on the first line of an imported module is stripped by Vite's
 * SSR transform ONLY when that line is LF-terminated: the transform matches
 * the hashbang with a pattern whose line terminator is `\n` alone, and in
 * JavaScript regex `.` does not match `\r`.
 * On a CRLF checkout (`core.autocrlf=true`, no `.gitattributes`) the hashbang
 * therefore survives the transform, the module cannot be parsed
 * (`SyntaxError: Invalid or unexpected token`) and the whole suite collects
 * 0 tests. `scripts/brand-gate.mjs` is imported by this suite, so the gate
 * script has to stay shebang-free. The assertions below make a regression
 * impossible to merge unnoticed and are independent of the checkout's line
 * endings.
 */
const GATE_SOURCE = readFileSync(SCRIPT, 'utf8');
const SUITE_SOURCE = readFileSync(SUITE_PATH, 'utf8');

beforeAll(() => {
  // 1. Root-cause invariant: the imported gate module must not carry a hashbang.
  expect(
    GATE_SOURCE.startsWith('#!'),
    'brand-gate regression guard: scripts/brand-gate.mjs must not start with a "#!" hashbang — it breaks CRLF checkouts (D-C2-1)'
  ).toBe(false);

  // 2. Same failure mode for this suite file itself.
  expect(
    SUITE_SOURCE.startsWith('#!'),
    'brand-gate regression guard: tests/unit/brand-gate.test.mjs must not start with a "#!" hashbang'
  ).toBe(false);

  // 3. The runner must really be executing THIS file (the suite is not silently skipped).
  expect(
    String(expect.getState().testPath ?? '').replace(/\\/g, '/'),
    'brand-gate regression guard: the runner is not executing tests/unit/brand-gate.test.mjs'
  ).toBe(SUITE_PATH.replace(/\\/g, '/'));

  // 4. The suite must really declare its 13 cases (no silent case removal).
  const declaredCases = (SUITE_SOURCE.match(/^\s*it\(/gm) ?? []).length;
  expect(
    declaredCases,
    'brand-gate regression guard: the suite must declare its 13 test cases'
  ).toBeGreaterThanOrEqual(13);
});

describe('brand gate — forbidden token list', () => {
  it('covers every forbidden token of the brand contract', () => {
    const ids = FORBIDDEN_PATTERNS.map((p) => p.id);
    expect(ids.length).toBeGreaterThanOrEqual(14);
    // every pattern must have a stable id and a global regex
    for (const { id, re } of FORBIDDEN_PATTERNS) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(re.flags).toContain('g');
    }
  });

  it('detects a legacy token in a blob', () => {
    const hits = scanText('const COOKIE = "initech_auth";', 'sample.js');
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('sample.js');
    expect(hits[0].line).toBe(1);
    expect(hits[0].id).toBe('cookie:legacy-auth-cookie');
  });

  it('detects a legacy CSS class prefix', () => {
    const hits = scanText('.initech-sidebar { color: red; }', 'styles.css');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.id === 'css:legacy-sidebar')).toBe(true);
  });

  it('does NOT flag the bare product name (provenance is allowed)', () => {
    const hits = scanText('// The original project was called Initech.', 'comment.js');
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag the current GeneRaptor contract', () => {
    const hits = scanText(
      [
        "export const GATE_COOKIE_NAME = 'generaptor_auth';",
        "const port = process.env.GENERAPTOR_API_PORT || 8787;",
        "const raw = env ? env.GENERAPTOR_UTM_ENABLED : undefined;",
        "utm_source=generaptor",
        'urn:generaptor:article:42',
        'data-generaptor="article-schema"',
        'GeneRaptorResearchBot/1.0 (+https://generaptor.local; …)',
        '.generaptor-sidebar { color: red; }',
      ].join('\n'),
      'current.js'
    );
    expect(hits).toHaveLength(0);
  });
});

describe('brand gate — fixture with violations FAILS', () => {
  it('reports hits for the fixture tree', () => {
    const { files, hits } = runGate({ root: FIXTURE_ROOT });
    expect(files.length).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThanOrEqual(10);
  });

  it('reports every forbidden token family', () => {
    const { hits } = runGate({ root: FIXTURE_ROOT });
    const ids = new Set(hits.map((h) => h.id));
    for (const { id } of FORBIDDEN_PATTERNS) {
      expect(ids.has(id), `pattern ${id} did not match the fixture`).toBe(true);
    }
  });

  it('reports file:line locations', () => {
    const { hits } = runGate({ root: FIXTURE_ROOT });
    for (const hit of hits) {
      expect(hit.file).toMatch(/\.[a-z]+$/);
      expect(hit.line).toBeGreaterThan(0);
      expect(hit.match.length).toBeGreaterThan(0);
    }
    expect(hits.some((h) => h.file === 'src/legacy-widget.js')).toBe(true);
    expect(hits.some((h) => h.file === 'server/legacy-config.mjs')).toBe(true);
    expect(hits.some((h) => h.file === 'index.html')).toBe(true);
  });

  it('exits non-zero from the CLI and prints file:line', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', FIXTURE_ROOT], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/brand-gate: FAIL/);
    expect(result.stdout).toMatch(/src\/legacy-widget\.js:\d+:/);
  });

  it('ignores tests/, docs/, node_modules/, dist/ and the fixture catalog directory', () => {
    const { hits } = runGate({ root: FIXTURE_ROOT });
    for (const hit of hits) {
      expect(hit.file.startsWith('tests/')).toBe(false);
      expect(hit.file.startsWith('docs/')).toBe(false);
      expect(hit.file.startsWith('node_modules/')).toBe(false);
      expect(hit.file.startsWith('dist/')).toBe(false);
      for (const dir of FIXTURE_CATALOG_DIRS) {
        expect(hit.file.startsWith(`${dir}/`)).toBe(false);
      }
    }
    // Non-vacuous: the catalog fixture still carries a forbidden token — the
    // gate does not report it only because the directory is not scanned.
    expect(FIXTURE_CATALOG_DIRS).toHaveLength(1);
    const catalogFile = `${FIXTURE_CATALOG_DIRS[0]}/legacy.js`;
    const fixtureText = readFileSync(resolve(FIXTURE_ROOT, catalogFile), 'utf8');
    expect(scanText(fixtureText, catalogFile).length).toBeGreaterThan(0);
  });
});

describe('brand gate — the shipped tree PASSES', () => {
  it('finds no forbidden token in the shipped file set', () => {
    const { files, hits } = runGate();
    expect(files.length).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });

  it('scans src, server, scripts, prisma and the shipped root files', () => {
    const files = collectShippedFiles(DEFAULT_ROOT);
    const rel = files.map((f) => f.slice(DEFAULT_ROOT.length + 1).replace(/\\/g, '/'));
    expect(rel).toContain('index.html');
    expect(rel).toContain('package.json');
    expect(rel).toContain('start.mjs');
    expect(rel).toContain('.env.example');
    expect(rel).toContain('README.md');
    expect(rel).toContain('README.ru.md');
    expect(rel.some((f) => f.startsWith('src/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('server/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('scripts/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('prisma/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('tests/'))).toBe(false);
    expect(rel.some((f) => f.startsWith('docs/'))).toBe(false);
    expect(rel.some((f) => f.startsWith('node_modules/'))).toBe(false);
    // The shipped set is the published roots only. Asserting that (instead of
    // naming one particular sibling checkout) is stronger: no file of ANY
    // directory that is not published can be in the scanned set.
    const PUBLISHED_ROOTS = ['src/', 'server/', 'scripts/', 'prisma/'];
    const PUBLISHED_ROOT_FILES = [
      'index.html',
      'package.json',
      'start.mjs',
      '.env.example',
      'README.md',
      'README.ru.md',
    ];
    expect(
      rel.filter(
        (f) =>
          !PUBLISHED_ROOTS.some((root) => f.startsWith(root)) &&
          !PUBLISHED_ROOT_FILES.includes(f)
      )
    ).toEqual([]);
  });

  it('exits zero from the CLI', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/brand-gate: OK/);
  });
});
