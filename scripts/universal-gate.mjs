/**
 * Universal gate — the shipped GeneRaptor tree must stay business-agnostic.
 *
 * NOTE: this file intentionally has NO `#!` shebang — it is always run as
 * `node scripts/universal-gate.mjs` (package.json → `lint:universal`), and a
 * hashbang makes the module unimportable on CRLF checkouts (Vite's SSR
 * transform strips a hashbang only on an LF-terminated first line).
 * The regression guard for that lives in tests/unit/brand-gate.test.mjs.
 *
 * GeneRaptor is a universal expert-article generator: it works for ANY
 * business — SaaS, e-commerce, services, manufacturing, education, finance.
 * A leftover single-industry word in a shipped file silently re-biases every
 * generated article (the model copies the example domain of its instructions)
 * and puts a wrong word in the customer's page, so the bias is treated as a
 * build defect, not as a wording nit.
 *
 * SCOPE — the whole shipped set, not a single folder:
 *   - directories: src/, server/, scripts/, prisma/ (recursive)
 *   - single files: index.html, start.mjs, package.json
 *   - never scanned: tests/, docs/, node_modules/, dist/, build/, coverage/,
 *     README*, *.bak|log|map — plus the local artifact directories listed in
 *     EXCLUDED_DIRS (see the comment there for why that list is short)
 *
 * PENDING LIST — a migration ledger of the files that still carry a
 * single-industry word (scripts/universal-gate.pending.json, one entry per
 * file with an owner). A hit inside a pending file is reported as a WARNING;
 * a hit anywhere else FAILS the gate. The ledger is CLOSED in this round:
 * the file is deleted, so the gate runs with an empty ledger and every
 * remaining hit fails. The mechanism itself stays for the next round.
 *
 * STRUCTURAL ID CLASSES — the frozen contract strings that still embed an
 * old word are declared explicitly in STRUCTURAL_ID_CLASSES: every class
 * names the files it owns, the exact pattern it tolerates and why. A class is
 * a scoped allowance, not a general exemption — the very same text outside
 * the declared files is still a finding.
 *
 * Matching rules (see tests/unit/universal-gate.test.mjs):
 *   - Cyrillic tokens are matched as a WORD PREFIX (stem), so every inflection
 *     of a domain word is caught.
 *   - Latin tokens are matched as a WHOLE WORD: the token matches on its own
 *     (plus a plain plural suffix), but NOT inside a camelCase identifier —
 *     a structural name is not a domain word.
 *
 * The forbidden tokens themselves are assembled from fragments, so this file
 * stays clean too — the gate scans itself and still passes.
 *
 * Usage:
 *   node scripts/universal-gate.mjs              # scan the shipped set
 *   node scripts/universal-gate.mjs --root DIR   # scan another root (used by tests)
 *   node scripts/universal-gate.mjs --json       # machine-readable report
 *
 * Exit code: 0 — no forbidden token outside the pending list; 1 — at least one hit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
export const DEFAULT_ROOT = resolve(dirname(HERE), '..');

/**
 * The original role/prompt zone. Kept as an explicit list: the gate now
 * scans the whole shipped set, but the zone stays the strictest part of it
 * (no pending entries are allowed for these files).
 * @type {string[]}
 */
export const ZONE_FILES = [
  'server/agent-role-data.mjs',
  'server/agent-role-contracts.mjs',
  'server/agent-role-execution.mjs',
  'server/lib/agent-role-overrides.mjs',
  'server/routes/agent-roles.mjs',
  'server/lib/cover-prompt.mjs',
  'src/data/agentRoles.ts',
];

/** Shipped directories — scanned recursively. */
export const SCAN_DIRS = ['src', 'server', 'scripts', 'prisma'];

/** Shipped single files. */
export const SCAN_FILES = ['index.html', 'start.mjs', 'package.json'];

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

/** File names that are never scanned (the ledger itself names the offenders). */
export const SKIP_FILES = new Set(['universal-gate.pending.json']);

/** The migration ledger: pending files, their owner and the reason. */
export const PENDING_LIST_FILE = 'scripts/universal-gate.pending.json';

/** Join token fragments — keeps the literal forbidden strings out of this file. */
const t = (...parts) => parts.join('');

/**
 * A token is a word: the neighbours must not be letters, digits or `_`.
 * `\b` cannot be used for the Cyrillic stems — in JavaScript `\w` is
 * `[A-Za-z0-9_]` only, so `\b` never fires next to a Cyrillic letter.
 */
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

/** Escape a literal for use inside a RegExp. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * STRUCTURAL ID CLASSES — the explicit list of frozen identifiers that are
 * allowed to keep an old domain word.
 *
 * Every class declares:
 *   - `id`         — stable class name (quoted in the migration report);
 *   - `files`      — the files the class owns (the allowance is file-scoped);
 *   - `identifiers`— the frozen literals of the class (enumerated explicitly);
 *   - `re`         — the exact pattern tolerated inside those files;
 *   - `reason`     — why the class exists.
 *
 * The same text outside the declared files is still a finding, so a class can
 * never turn into a general exemption.
 *
 * @type {{id: string, files: string[], identifiers: string[], re: RegExp, reason: string}[]}
 */
export const STRUCTURAL_ID_CLASSES = [
  {
    // The marker table of the narrow web-search verticals lists the
    // vocabulary of those domains on purpose: the markers ARE the mechanism
    // that decides whether a query fits a vertical (see
    // server/lib/web-search/topic-match.mjs). Those words are a technical
    // dictionary of the source domains, not a bias of the generated text.
    //
    // The allowance is deliberately narrow:
    //   - ONE category, ONE file (the marker table itself);
    //   - the tolerated literals are enumerated explicitly — a word that is
    //     not on the list is still a finding, even in this file;
    //   - the very same words in any other file are still a finding.
    id: 'vertical-domain-marker:topic-match',
    files: ['server/lib/web-search/topic-match.mjs'],
    identifiers: [
      t('диаг', 'ноз'),
      t('лекар', 'ств'),
      t('медиц', 'инск'),
      t('пацие', 'нт'),
      t('клини', 'к'),
    ],
    reason:
      'The marker table of the narrow search verticals carries the vocabulary of those domains on purpose — the markers are the matching mechanism. The allowance is file-scoped and enumerated: the same words anywhere else are still a finding.',
  },
].map((cls) => ({
  ...cls,
  re: new RegExp(cls.identifiers.map(escapeRegExp).join('|'), 'g'),
}));

/**
 * Frozen vocabulary that still embeds a domain word: the marker table of
 * the narrow search verticals. The gate tolerates it — in the owning file
 * only, and nowhere else.
 * @type {Record<string, string[]>}
 */
export const PRESERVED_IDENTIFIERS = Object.fromEntries(
  STRUCTURAL_ID_CLASSES.filter((cls) => cls.identifiers.length).flatMap((cls) =>
    cls.files.map((file) => [file, cls.identifiers])
  )
);

/**
 * Forbidden domain tokens.
 *
 * `kind: 'stem'` — Cyrillic, matched as a word prefix (all inflections).
 * `kind: 'word'` — Latin, matched as a whole word (with a plain plural
 * suffix), so identifiers such as `medicalReviewerNote` are NOT domain hits.
 *
 * @type {{token: string, kind: 'stem'|'word', note: string}[]}
 */
export const FORBIDDEN_TOKENS = [
  { token: t('клини', 'к'), kind: 'stem', note: 'domain stem' },
  { token: t('медици', 'нск'), kind: 'stem', note: 'domain stem' },
  { token: t('вра', 'ч'), kind: 'stem', note: 'domain stem' },
  { token: t('пацие', 'нт'), kind: 'stem', note: 'domain stem' },
  { token: t('стомато', 'лог'), kind: 'stem', note: 'domain stem' },
  { token: t('импла', 'нт'), kind: 'stem', note: 'domain stem' },
  { token: t('диагно', 'з'), kind: 'stem', note: 'domain stem' },
  { token: t('лекарст', 'в'), kind: 'stem', note: 'domain stem' },
  { token: t('минздр', 'ав'), kind: 'stem', note: 'domain stem' },
  { token: t('родд', 'в'), kind: 'stem', note: 'domain stem' },
  { token: t('клиничес', 'к'), kind: 'stem', note: 'domain stem' },
  { token: t('терапев', 'т'), kind: 'stem', note: 'domain stem' },
  { token: t('онко', 'лог'), kind: 'stem', note: 'domain stem' },
  { token: t('поликлини', 'к'), kind: 'stem', note: 'domain stem' },
  { token: t('медсест', 'р'), kind: 'stem', note: 'domain stem' },
  { token: t('elibra', 'ry'), kind: 'word', note: 'legacy source' },
  { token: t('rodv', 'k'), kind: 'word', note: 'legacy source' },
  { token: t('pub', 'med'), kind: 'word', note: 'legacy source' },
  { token: t('doc', 'tor'), kind: 'word', note: 'domain word' },
  { token: t('patie', 'nt'), kind: 'word', note: 'domain word' },
  { token: t('clin', 'ic'), kind: 'word', note: 'domain word' },
  { token: t('dent', 'al'), kind: 'word', note: 'domain word' },
  { token: t('medi', 'cal'), kind: 'word', note: 'domain word' },
  { token: t('physi', 'cian'), kind: 'word', note: 'domain word' },
  { token: t('thera', 'py'), kind: 'word', note: 'domain word' },
  { token: t('ac', 'me'), kind: 'word', note: 'legacy brand' },
];

/**
 * Compiled matcher for one token.
 * @param {{token: string, kind: 'stem'|'word'}} entry
 * @returns {RegExp}
 */
export function tokenPattern(entry) {
  if (entry.kind === 'stem') {
    return new RegExp(`${WORD_BEFORE}${entry.token}`, 'giu');
  }
  return new RegExp(`${WORD_BEFORE}${entry.token}(?:s|es|ies)?${WORD_AFTER}`, 'giu');
}

/**
 * Collect the original role/prompt zone files under `root`.
 * @param {string} root
 * @returns {string[]} absolute paths, sorted
 */
export function collectZoneFiles(root = DEFAULT_ROOT) {
  const base = resolve(root);
  const out = [];
  for (const rel of ZONE_FILES) {
    const full = join(base, rel);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* zone file missing — nothing to scan */
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Collect the whole shipped set under `root` (the scope of the gate).
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
        if (SKIP_FILES.has(entry.name)) continue;
        if (/^README/i.test(entry.name)) continue;
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
 * Load the pending ledger of `root` (a missing/broken ledger = no pending
 * files — the gate then fails on every hit).
 * @param {string} root
 * @returns {{path: string, owner: string, reason: string}[]}
 */
export function loadPending(root = DEFAULT_ROOT) {
  const full = join(resolve(root), PENDING_LIST_FILE);
  let raw;
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.pending) ? parsed.pending : [];
  return list
    .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
    .map((entry) => ({
      path: entry.path.trim(),
      owner: typeof entry.owner === 'string' && entry.owner.trim() ? entry.owner.trim() : 'unassigned',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    }));
}

/**
 * Does the ledger cover this relative path? A ledger path may be exact or a
 * single-star glob (`server/lib/*-search.mjs`).
 * @param {string} relPath
 * @param {{path: string}[]} pending
 * @returns {boolean}
 */
export function isPendingPath(relPath, pending) {
  return pending.some((entry) => {
    if (entry.path === relPath) return true;
    if (!entry.path.includes('*')) return false;
    const escaped = entry.path.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(relPath);
  });
}

/**
 * Mask the frozen contract strings of one file before scanning: they are
 * allowed to stay, so they must not be reported as findings.
 * @param {string} text
 * @param {string} file relative path
 * @returns {string}
 */
export function maskPreservedIdentifiers(text, file) {
  const literals = PRESERVED_IDENTIFIERS[file];
  if (!literals || !literals.length) return text;
  let out = text;
  for (const literal of literals) {
    if (!literal) continue;
    out = out.split(literal).join('_'.repeat(literal.length));
  }
  return out;
}

/**
 * Mask the frozen structural ids of one file before scanning: the declared
 * classes are allowed to stay, so they must not be reported as findings.
 * The mask is file-scoped — the same text in any other file is still a hit.
 * @param {string} text
 * @param {string} file relative path
 * @returns {string}
 */
export function maskStructuralIdentifiers(text, file) {
  let out = text;
  for (const cls of STRUCTURAL_ID_CLASSES) {
    if (!cls.files.includes(file)) continue;
    out = out.replace(cls.re, (match) => '_'.repeat(match.length));
  }
  return out;
}

/**
 * Scan one text blob.
 * @param {string} text
 * @param {string} file
 * @returns {{file: string, line: number, token: string, note: string, match: string}[]}
 */
export function scanText(text, file) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const entry of FORBIDDEN_TOKENS) {
      const pattern = tokenPattern(entry);
      let match;
      while ((match = pattern.exec(line)) !== null) {
        hits.push({
          file,
          line: index + 1,
          token: entry.token,
          note: entry.note,
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
 *
 * `hits` — findings outside the pending ledger: they fail the gate.
 * `pendingHits` — findings inside the ledger: reported as a warning.
 *
 * @param {{root?: string, files?: string[], pending?: {path: string}[]}} [options]
 * @returns {{files: string[], hits: ReturnType<typeof scanText>, pendingHits: ReturnType<typeof scanText>, pending: {path: string, owner: string, reason: string}[]}}
 */
export function runGate(options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const files = options.files ?? collectShippedFiles(root);
  const pending = options.pending ?? loadPending(root);
  const hits = [];
  const pendingHits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, file).split(sep).join('/');
    const masked = maskStructuralIdentifiers(maskPreservedIdentifiers(text, rel), rel);
    const found = scanText(masked, rel);
    if (isPendingPath(rel, pending)) pendingHits.push(...found);
    else hits.push(...found);
  }
  return { files, hits, pendingHits, pending };
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
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
        'Usage: node scripts/universal-gate.mjs [--root DIR] [--json]\n' +
          'Scans the shipped set for forbidden single-industry domain tokens.\n'
      );
      return 0;
    }
  }

  const { files, hits, pendingHits, pending } = runGate({ root });
  const pendingFiles = [...new Set(pendingHits.map((hit) => hit.file))].sort();

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          files: files.length,
          hits,
          pendingHits,
          pendingFiles,
          pending: pending.map((entry) => ({ path: entry.path, owner: entry.owner })),
        },
        null,
        2
      )}\n`
    );
  } else if (hits.length === 0) {
    process.stdout.write(
      `universal-gate: OK — ${files.length} shipped files scanned, 0 forbidden tokens\n`
    );
    if (pendingHits.length > 0) {
      process.stdout.write(
        `universal-gate: WARNING — ${pendingFiles.length} pending file(s) still carry ${pendingHits.length} forbidden token(s); see ${PENDING_LIST_FILE}\n`
      );
      for (const file of pendingFiles) {
        const owner = pending.find((entry) => isPendingPath(file, [entry]))?.owner ?? 'unassigned';
        process.stdout.write(`universal-gate: pending ${file} (owner: ${owner})\n`);
      }
    }
  } else {
    process.stdout.write(
      `universal-gate: FAIL — ${hits.length} forbidden token(s) in ${files.length} shipped files\n`
    );
    for (const hit of hits) {
      process.stdout.write(`${hit.file}:${hit.line}: ${hit.token} — ${hit.match}\n`);
    }
    if (pendingHits.length > 0) {
      process.stdout.write(
        `universal-gate: WARNING — ${pendingFiles.length} pending file(s) still carry ${pendingHits.length} forbidden token(s); see ${PENDING_LIST_FILE}\n`
      );
    }
    process.stdout.write(
      'The generator is universal: shipped files must not carry a single industry. Rewrite the wording with a neutral business example.\n'
    );
  }

  return hits.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) {
  process.exitCode = main(process.argv.slice(2));
}
