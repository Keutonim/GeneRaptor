/**
 * Dev-11 (D4) — the e2e run must not touch TRACKED files.
 *
 * The defect: the Playwright HTML reporter wrote into
 * `tests/report/` and the e2e helper wrote screenshots into
 * `tests/screenshots/` — both were TRACKED in git, so every `npx playwright
 * test` run rewrote tracked artifacts and left the working tree dirty.
 *
 * The rule this test locks in: every artifact the e2e run produces lives under
 * ONE ignored directory (`tests/.artifacts/`), and the legacy directories are
 * ignored too, so a leftover file can never dirty the tree again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACT_DIR = 'tests/.artifacts';
const LEGACY_DIRS = ['tests/report', 'tests/screenshots'];

const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const playwrightConfig = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
const e2eHelpers = readFileSync(join(ROOT, 'tests', 'e2e', 'helpers.ts'), 'utf8');

/** The ignore patterns of the .gitignore, comments and blanks stripped. */
const ignorePatterns = gitignore
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

describe('the e2e run leaves the working tree clean (D4)', () => {
  it('the HTML reporter writes into the ignored artifacts dir', () => {
    const match = playwrightConfig.match(/outputFolder:\s*'([^']+)'/);
    expect(match, 'playwright.config.ts must declare an html reporter outputFolder').not.toBeNull();
    expect(match[1].replace(/\\/g, '/')).toMatch(new RegExp(`^${ARTIFACT_DIR}/`));
  });

  it('the e2e screenshots go into the ignored artifacts dir', () => {
    const line = e2eHelpers
      .split('\n')
      .find((l) => l.includes('SCREENSHOT_DIR') && l.includes('='));
    expect(line, 'tests/e2e/helpers.ts must define SCREENSHOT_DIR').toBeDefined();
    // The path is built from quoted segments: join(process.cwd(), 'tests', ...).
    const segments = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.join('/')).toMatch(new RegExp(`^${ARTIFACT_DIR}/`));
  });

  it('.gitignore covers the artifacts dir and the legacy artifact dirs', () => {
    for (const dir of [ARTIFACT_DIR, ...LEGACY_DIRS]) {
      expect(
        ignorePatterns,
        `.gitignore must ignore "${dir}" — otherwise an e2e run dirties the tree`,
      ).toContain(`${dir}/`);
    }
  });

  it('no tracked file is left under the legacy artifact dirs', () => {
    let tracked;
    try {
      tracked = execFileSync('git', ['ls-files', '--', 'tests/report', 'tests/screenshots'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Not a git checkout (e.g. an exported tarball) — the static assertions
      // above already carry the regression guard.
      return;
    }
    expect(tracked.trim(), 'the generated e2e artifacts must not be tracked any more').toBe('');
  });
});
