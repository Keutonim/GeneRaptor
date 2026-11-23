/**
 * Brand gate — GeneRaptor must not ship any brand of the original project.
 *
 * NOTE: this file intentionally has NO `#!` shebang. The gate is always run as
 * `node scripts/brand-gate.mjs` (package.json → `lint:brand`), so the shebang
 * is redundant — and it makes this module unimportable on CRLF checkouts:
 * Vite's SSR transform strips a hashbang only when the line ends with LF
 * (Vite's internal hashbang regex — in JavaScript regex `.` does not match
 * `\r`), so
 * on CRLF the hashbang survives the transform and the whole unit suite dies
 * with `SyntaxError: Invalid or unexpected token` while collecting 0 tests.
 * The regression guard lives in tests/unit/brand-gate.test.mjs (defect D-C2-1).
 *
 * The open-source build is brand-neutral: no legacy brand name, no legacy brand
 * domain, no legacy env var, no legacy cookie, no legacy URN/attribute, no
 * legacy CSS prefix. This gate is the permanent guard: it scans the SHIPPED file set
 * (exactly what `npm pack` puts into the tarball) and fails with a
 * `file:line` report on any forbidden token.
 *
 * The forbidden tokens themselves are assembled from fragments, so this file
 * stays clean too — the gate scans itself and still passes.
 *
 * Usage:
 *   node scripts/brand-gate.mjs              # scan the repository (shipped set)
 *   node scripts/brand-gate.mjs --root DIR   # scan another root (used by tests)
 *   node scripts/brand-gate.mjs --json       # machine-readable report
 *
 * Exit code: 0 — no forbidden token found; 1 — at least one hit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
export const DEFAULT_ROOT = resolve(dirname(HERE), '..');

/** Shipped directories — scanned recursively. */
export const SCAN_DIRS = ['src', 'server', 'scripts', 'prisma'];

/** Shipped single files. */
export const SCAN_FILES = [
  'index.html',
  'package.json',
  'start.mjs',
  '.env.example',
  'README.md',
  'README.ru.md',
];

/**
 * Directory names that are never scanned.
 *
 * The scanned set is defined by SCAN_DIRS + SCAN_FILES, so this list only
 * matters for directories that can physically appear INSIDE a shipped folder.
 * It therefore names local toolchain artifacts and nothing else — no catalog
 * of a project that is not published here. Naming such a directory would make
 * the rule branch-dependent: the very same checkout would be judged
 * differently depending on what else happens to sit on the disk.
 */
export const EXCLUDED_DIRS = new Set([
  '.git',
  '.cache',
  '.zcode',
  'build',
  'coverage',
  'dist',
  'docs',
  'node_modules',
  'tests',
]);

/** File name patterns that are never scanned. */
export const EXCLUDED_FILE_PATTERNS = [/\.bak$/i, /\.log$/i, /\.map$/i];

/** Join token fragments — keeps the literal forbidden strings out of this file. */
const t = (...parts) => parts.join('');

/**
 * Forbidden tokens. The bare product name of the origin project is
 * deliberately NOT forbidden: mentioning the origin project in a comment is
 * legitimate provenance.
 * @type {{id: string, re: RegExp, note: string}[]}
 */
export const FORBIDDEN_PATTERNS = [
  { id: 'brand:legacy-domain', re: new RegExp(t('ac', 'me'), 'gi'), note: 'brand' },
  {
    id: 'brand:legacy-name',
    re: new RegExp(t('ac', 'me', '[\\s_-]+', 'corp'), 'gi'),
    note: 'brand',
  },
  {
    id: 'brand:second',
    re: new RegExp(t('glob', 'ex'), 'gi'),
    note: 'brand',
  },
  {
    id: 'env:legacy-env-prefix',
    re: new RegExp(t('\\bINI', 'TECH_[A-Z0-9_]+'), 'g'),
    note: 'legacy env var',
  },
  {
    id: 'cookie:legacy-auth-cookie',
    re: new RegExp(t('\\bini', 'tech_auth'), 'g'),
    note: 'legacy cookie',
  },
  { id: 'urn:legacy', re: new RegExp(t('\\burn:ini', 'tech'), 'g'), note: 'legacy URN' },
  {
    id: 'attr:legacy-schema-marker',
    re: new RegExp(t('\\bdata-ini', 'tech'), 'g'),
    note: 'legacy DOM attribute',
  },
  {
    id: 'ua:legacy-research-bot',
    re: new RegExp(t('\\bIni', 'techResearch', 'Bot'), 'g'),
    note: 'legacy user agent',
  },
  {
    id: 'host:legacy-frontend',
    re: new RegExp(t('\\bini', 'tech-frontend'), 'g'),
    note: 'legacy host',
  },
  {
    id: 'host:legacy-local',
    re: new RegExp(t('\\bini', 'tech\\.local'), 'g'),
    note: 'legacy host',
  },
  {
    id: 'host:legacy-ru',
    re: new RegExp(t('\\bini', 'tech\\.example'), 'g'),
    note: 'legacy host',
  },
  {
    id: 'css:legacy-sidebar',
    re: new RegExp(t('\\bini', 'tech-sidebar'), 'g'),
    note: 'legacy CSS class',
  },
  {
    id: 'css:legacy-main',
    re: new RegExp(t('\\bini', 'tech-main'), 'g'),
    note: 'legacy CSS class',
  },
  {
    id: 'css:legacy-settings',
    re: new RegExp(t('\\bini', 'tech-settings'), 'g'),
    note: 'legacy CSS class',
  },
  {
    id: 'css:legacy-prefix',
    re: new RegExp(t('\\.ini', 'tech-[a-z0-9-]+'), 'gi'),
    note: 'legacy CSS class prefix',
  },
];

/**
 * Collect the shipped file set under `root`.
 * @param {string} root
 * @returns {string[]} absolute paths, sorted
 */
export function collectShippedFiles(root = DEFAULT_ROOT) {
  const base = resolve(root);
  const out = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
        out.push(full);
      }
    }
  };

  for (const dir of SCAN_DIRS) walk(join(base, dir));
  for (const file of SCAN_FILES) {
    const full = join(base, file);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* shipped file missing — nothing to scan */
    }
  }

  return [...new Set(out)].sort();
}

/**
 * Scan one text blob.
 * @param {string} text
 * @param {string} file
 * @returns {{file: string, line: number, id: string, note: string, match: string}[]}
 */
export function scanText(text, file) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { id, re, note } of FORBIDDEN_PATTERNS) {
      const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let match;
      while ((match = pattern.exec(line)) !== null) {
        hits.push({
          file,
          line: index + 1,
          id,
          note,
          match: match[0].trim(),
        });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  });
  return hits;
}

/**
 * Run the gate.
 * @param {{root?: string, files?: string[]}} [options]
 * @returns {{files: string[], hits: ReturnType<typeof scanText>}}
 */
export function runGate(options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const files = options.files ?? collectShippedFiles(root);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    hits.push(...scanText(text, relative(root, file).split(sep).join('/')));
  }
  return { files, hits };
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv) {
  let root = DEFAULT_ROOT;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      root = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--json') {
      json = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(
        'Usage: node scripts/brand-gate.mjs [--root DIR] [--json]\n' +
          'Scans the shipped file set for forbidden legacy brand tokens.\n'
      );
      return 0;
    }
  }

  const { files, hits } = runGate({ root });

  if (json) {
    process.stdout.write(`${JSON.stringify({ files: files.length, hits }, null, 2)}\n`);
  } else if (hits.length === 0) {
    process.stdout.write(
      `brand-gate: OK — ${files.length} shipped files scanned, 0 forbidden tokens\n`
    );
  } else {
    process.stdout.write(
      `brand-gate: FAIL — ${hits.length} forbidden token(s) in ${files.length} shipped files\n`
    );
    for (const hit of hits) {
      process.stdout.write(`${hit.file}:${hit.line}: ${hit.id} — ${hit.match}\n`);
    }
    process.stdout.write(
      'The open-source build must stay brand-neutral: rename the identifier to its GeneRaptor counterpart.\n'
    );
  }

  return hits.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) {
  process.exitCode = main(process.argv.slice(2));
}
