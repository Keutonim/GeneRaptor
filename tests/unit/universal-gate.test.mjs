/**
 * Universal gate — permanent guard that the role/prompt zone stays
 * business-agnostic.
 *
 * NOTE: this suite deliberately contains single-industry words — they are the
 * RED fixtures the gate has to catch. The gate scans the role/prompt zone
 * (server/agent-role-*.mjs, server/lib/agent-role-overrides.mjs,
 * server/routes/agent-roles.mjs, server/lib/cover-prompt.mjs,
 * src/data/agentRoles.ts), never the test tree.
 *
 * NOTE: no `#!` shebang — same CRLF hazard as the brand gate (D-C2-1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ROOT,
  FORBIDDEN_TOKENS,
  STRUCTURAL_ID_CLASSES,
  ZONE_FILES,
  collectShippedFiles,
  collectZoneFiles,
  loadPending,
  runGate,
  scanText,
} from '../../scripts/universal-gate.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = resolve(REPO_ROOT, 'scripts/universal-gate.mjs');

/** The token list from the brief — every one of them must be enforced. */
const REQUIRED_TOKENS = [
  'клиник',
  'медицинск',
  'врач',
  'пациент',
  'стоматолог',
  'имплант',
  'диагноз',
  'лекарств',
  'минздрав',
  'elibrary',
  'rodvk',
  'роддв',
  'pubmed',
  'клиническ',
  'терапевт',
  'онколог',
  'поликлиник',
  'медсестр',
  'doctor',
  'patient',
  'clinic',
  'dental',
  'medical',
  'physician',
  'therapy',
  'acme',
];

let tmpRoot;
let redFile;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'universal-gate-'));
  redFile = join(tmpRoot, 'server', 'agent-role-data.mjs');
  mkdirSync(join(tmpRoot, 'server'), { recursive: true });
  writeFileSync(redFile, 'const prompt = "подсказка для клиники и пациента";\n', 'utf8');
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('universal-gate — token list', () => {
  it('enforces every token from the brief', () => {
    const enforced = new Set(FORBIDDEN_TOKENS.map((entry) => entry.token));
    expect([...enforced].sort()).toEqual([...REQUIRED_TOKENS].sort());
  });

  it('scans the role/prompt zone of the shipped tree', () => {
    expect(ZONE_FILES).toEqual(
      expect.arrayContaining([
        'server/agent-role-data.mjs',
        'server/agent-role-contracts.mjs',
        'server/agent-role-execution.mjs',
        'server/lib/agent-role-overrides.mjs',
        'server/routes/agent-roles.mjs',
        'server/lib/cover-prompt.mjs',
        'src/data/agentRoles.ts',
      ])
    );
  });
});

describe('universal-gate — matching rules', () => {
  it('finds a Cyrillic domain word with its inflections', () => {
    const hits = scanText('клиника клиники клинике пациента пациентов врачей', 'x.mjs');
    const tokens = hits.map((hit) => hit.token);
    expect(tokens).toContain('клиник');
    expect(tokens).toContain('пациент');
    expect(tokens).toContain('врач');
    expect(hits.every((hit) => hit.line === 1)).toBe(true);
  });

  it('finds a Latin domain word as a whole word', () => {
    const hits = scanText('Clinic and clinics and dental and therapy and physicians', 'x.mjs');
    const tokens = hits.map((hit) => hit.token);
    expect(tokens).toContain('clinic');
    expect(tokens).toContain('dental');
    expect(tokens).toContain('therapy');
    expect(tokens).toContain('physician');
  });

  it('does NOT flag structural identifiers that merely contain a token', () => {
    const hits = scanText(
      'const siteName = context?.siteName; medicalReviewerNoteRu; patientId; dentalImpl;',
      'x.mjs'
    );
    expect(hits).toEqual([]);
  });

  it('reports the file and the line of every hit', () => {
    const hits = scanText('первая строка\nвторая — тут пациент\n', 'server/agent-role-data.mjs');
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('server/agent-role-data.mjs');
    expect(hits[0].line).toBe(2);
    expect(hits[0].token).toBe('пациент');
  });
});

describe('universal-gate — run over the repository zone', () => {
  it('the shipped role/prompt zone is clean', () => {
    const { files, hits } = runGate({ root: DEFAULT_ROOT });
    expect(files.length).toBeGreaterThan(0);
    expect(
      hits,
      `universal-gate findings:\n${hits.map((hit) => `${hit.file}:${hit.line}: ${hit.token}`).join('\n')}`
    ).toEqual([]);
  });

  it('collects every zone file that exists in the tree', () => {
    const files = collectZoneFiles(REPO_ROOT);
    expect(files.length).toBe(ZONE_FILES.length);
  });
});

describe('universal-gate — CLI', () => {
  it('exits 1 and prints file:line: token when a zone file carries a forbidden word', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', tmpRoot], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('server/agent-role-data.mjs:1:');
    expect(result.stdout).toContain('клиник');
    expect(result.stdout).toContain('пациент');
  });

  it('exits 0 on a clean root', () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), 'universal-gate-clean-'));
    try {
      mkdirSync(join(cleanRoot, 'server'), { recursive: true });
      writeFileSync(
        join(cleanRoot, 'server', 'agent-role-data.mjs'),
        'const prompt = "пиши от лица компании, без отраслевых примеров";\n',
        'utf8'
      );
      const result = spawnSync(process.execPath, [SCRIPT, '--root', cleanRoot], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('0 forbidden tokens');
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  it('prints a machine-readable report with --json', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', tmpRoot, '--json'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.files).toBe(1);
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.hits[0]).toHaveProperty('token');
    expect(report.hits[0]).toHaveProperty('line');
  });

  it('prints usage with --help and exits 0', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/universal-gate.mjs');
  });
});

describe('universal-gate — self-check', () => {
  it('the gate script itself carries no forbidden token and no shebang', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source.startsWith('#!')).toBe(false);
    expect(scanText(source, 'scripts/universal-gate.mjs')).toEqual([]);
  });
});

/* ── extended gate: the whole shipped set ───────────────────────────────── */

describe('universal-gate — shipped set scope', () => {
  it('scans src/, server/, scripts/, prisma/ and the shipped single files', () => {
    const rel = collectShippedFiles(REPO_ROOT).map((file) =>
      file.slice(REPO_ROOT.length + 1).split(/[\\/]/).join('/')
    );
    expect(rel).toContain('server/lib/internal-linker.mjs');
    expect(rel).toContain('src/data/faqs.ts');
    expect(rel).toContain('scripts/universal-gate.mjs');
    expect(rel).toContain('index.html');
    expect(rel).toContain('start.mjs');
    expect(rel).toContain('package.json');
  });

  it('never scans tests/, docs/, node_modules/, README* and the ledger itself', () => {
    const rel = collectShippedFiles(REPO_ROOT).map((file) =>
      file.slice(REPO_ROOT.length + 1).split(/[\\/]/).join('/')
    );
    expect(rel.some((file) => file.startsWith('tests/'))).toBe(false);
    expect(rel.some((file) => file.startsWith('docs/'))).toBe(false);
    expect(rel.some((file) => file.startsWith('node_modules/'))).toBe(false);
    expect(rel.some((file) => /(^|\/)README/i.test(file))).toBe(false);
    expect(rel).not.toContain('scripts/universal-gate.pending.json');
    // The scanned set is the published roots only. Asserting that (instead of
    // naming one particular sibling checkout) is stronger: no file of ANY
    // directory that is not published can be in the scanned set.
    const PUBLISHED_ROOTS = ['src/', 'server/', 'scripts/', 'prisma/'];
    const PUBLISHED_ROOT_FILES = ['index.html', 'start.mjs', 'package.json'];
    expect(
      rel.filter(
        (file) =>
          !PUBLISHED_ROOTS.some((root) => file.startsWith(root)) &&
          !PUBLISHED_ROOT_FILES.includes(file)
      )
    ).toEqual([]);
  });
});

describe('universal-gate — closed pending ledger', () => {
  it('the migration ledger is closed: no pending entries and no ledger file', () => {
    expect(loadPending(REPO_ROOT)).toEqual([]);
    expect(existsSync(join(REPO_ROOT, 'scripts', 'universal-gate.pending.json'))).toBe(false);
  });

  it('the gate works without the ledger file: every hit fails, nothing warns', () => {
    const root = mkdtempSync(join(tmpdir(), 'universal-gate-noledger-'));
    try {
      mkdirSync(join(root, 'server', 'lib'), { recursive: true });
      writeFileSync(join(root, 'server', 'lib', 'module.mjs'), 'const note = "текст для пациента";\n', 'utf8');
      expect(existsSync(join(root, 'scripts', 'universal-gate.pending.json'))).toBe(false);
      const { hits, pendingHits, pending } = runGate({ root });
      expect(hits).toHaveLength(1);
      expect(pendingHits).toEqual([]);
      expect(pending).toEqual([]);
      const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('server/lib/module.mjs:1:');
      expect(result.stdout).not.toContain('WARNING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('universal-gate — structural id classes', () => {
  it('every allowed structural id class is declared explicitly', () => {
    expect(Array.isArray(STRUCTURAL_ID_CLASSES)).toBe(true);
    expect(STRUCTURAL_ID_CLASSES.length).toBeGreaterThan(0);
    for (const cls of STRUCTURAL_ID_CLASSES) {
      expect(typeof cls.id, cls.id).toBe('string');
      expect(cls.id.trim().length, cls.id).toBeGreaterThan(0);
      expect(Array.isArray(cls.files), cls.id).toBe(true);
      expect(cls.files.length, cls.id).toBeGreaterThan(0);
      expect(cls.re, cls.id).toBeInstanceOf(RegExp);
      expect(typeof cls.reason, cls.id).toBe('string');
      expect(cls.reason.trim().length, cls.id).toBeGreaterThan(0);
      for (const file of cls.files) {
        expect(existsSync(join(REPO_ROOT, file)), `${cls.id}: ${file}`).toBe(true);
      }
    }
  });

  it('only the functional vertical-marker allowance remains', () => {
    // The obsolete allowances (frozen postcheck ids, brand-gate vocabulary)
    // are removed: their carriers are neutral, and a scoped allowance with
    // no owner left would be a general exemption.
    expect(STRUCTURAL_ID_CLASSES.map((cls) => cls.id)).toEqual([
      'vertical-domain-marker:topic-match',
    ]);
  });

  it('the frozen ids are tolerated inside their own scope only', () => {
    const { hits } = runGate({ root: DEFAULT_ROOT });
    for (const file of [
      'scripts/brand-gate.mjs',
      'server/lib/article-postcheck.mjs',
      'server/workers/article-generation.mjs',
    ]) {
      expect(
        hits.filter((hit) => hit.file === file),
        `findings in ${file}`
      ).toEqual([]);
    }
  });

  it('the same marker words outside their scope are still findings', () => {
    const root = mkdtempSync(join(tmpdir(), 'universal-gate-scope-'));
    try {
      mkdirSync(join(root, 'server', 'lib'), { recursive: true });
      // The words of the surviving functional class (vertical-domain-marker)
      // are tolerated ONLY inside the marker table — anywhere else they fail.
      writeFileSync(
        join(root, 'server', 'lib', 'scope-leak.mjs'),
        'const marker = "диагноз";\nconst other = "пациент";\n',
        'utf8'
      );
      const { hits } = runGate({ root });
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits.every((hit) => hit.file === 'server/lib/scope-leak.mjs')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('universal-gate — preserved marker vocabulary', () => {
  it('the marker vocabulary is tolerated in the file that owns it', () => {
    const { hits } = runGate({ root: DEFAULT_ROOT });
    const markerHits = hits.filter(
      (hit) => hit.file === 'server/lib/web-search/topic-match.mjs'
    );
    expect(markerHits).toEqual([]);
  });

  it('the same word is still a finding anywhere else', () => {
    const hits = scanText('const marker = "диагноз";', 'server/lib/internal-linker.mjs');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('universal-gate — CLI (shipped set)', () => {
  it('exits 0 on the shipped tree and prints no warning', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 forbidden tokens');
    expect(result.stdout).not.toContain('WARNING');
    expect(result.stdout).not.toContain('universal-gate: pending');
  });

  it('--json reports an empty pending report', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.hits).toEqual([]);
    expect(report.pendingHits).toEqual([]);
    expect(report.pendingFiles).toEqual([]);
    expect(report.pending).toEqual([]);
  });
});
