/**
 * GeneRaptor data-dir resolution (M1).
 *
 * One decision in one place: every consumer (start.mjs launcher, server/db.mjs
 * fallback, tests) resolves the data directory and the SQLite database URL
 * through this module.
 *
 * Precedence:
 *   1. --data-dir <path> | --data-dir=<path> CLI flag
 *   2. GENERAPTOR_DATA_DIR environment variable
 *   3. default: <homedir>/.generaptor
 *
 * The directory is created (recursive) on resolution. The Prisma SQLite URL
 * always uses forward slashes so it works on Windows too.
 */
import { chmodSync, mkdirSync, statSync } from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export const DEFAULT_DATA_DIR_NAME = '.generaptor';
export const DATABASE_FILE_NAME = 'generaptor.db';

/**
 * Expand a leading `~` to the given home directory.
 * @param {string} p
 * @param {string} homeDir
 * @returns {string}
 */
function expandTilde(p, homeDir) {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homeDir, p.slice(2));
  return p;
}

/**
 * Extract a --data-dir value from a Node argv array.
 * Supports both `--data-dir <path>` and `--data-dir=<path>`.
 * @param {string[]} argv
 * @returns {string | null}
 */
function parseDataDirFlag(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-dir') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return null;
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length);
      if (value) return value;
    }
  }
  return null;
}

/**
 * Extract the launcher's dev-UI-origin marker from argv.
 *
 * The marker travels as a FLAG (`--dev-ui-origin <origin>`), not as an env
 * variable — the director ruled out new env variables, and a flag cannot be
 * inherited from the operator's environment: the launcher builds the child's
 * argv itself and emits the flag ONLY when it starts Vite itself.
 *
 * This module owns the launcher-argv extraction (next to --data-dir); the
 * ACCEPTANCE rules for the value (one loopback origin, explicit port, one
 * alias) live in server/lib/request-origin.mjs → devUiOrigins.
 *
 * Supports both `--dev-ui-origin <value>` and `--dev-ui-origin=<value>`.
 * @param {string[]} argv
 * @returns {string | null}
 */
function parseDevUiOriginFlag(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev-ui-origin') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return null;
    }
    if (arg.startsWith('--dev-ui-origin=')) {
      const value = arg.slice('--dev-ui-origin='.length);
      if (value) return value;
    }
  }
  return null;
}

/**
 * The dev-UI-origin marker of THIS process (null when the launcher did not
 * start a dev UI — packaged build, --api-only, or a direct server start).
 *
 * Pure extraction: no NODE_ENV participation, no env variable. The value is
 * still untrusted here — devUiOrigins() validates it fail-closed.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] - CLI args (default: process.argv)
 * @returns {string|null}
 */
export function resolveDevUiOrigin(opts = {}) {
  return parseDevUiOriginFlag(opts.argv ?? process.argv);
}

/**
 * Resolve the GeneRaptor data directory (creates it).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] - CLI args (default: process.argv)
 * @param {Record<string, string|undefined>} [opts.env] - env (default: process.env)
 * @param {string} [opts.home] - home dir for `~` and the default (default: os.homedir())
 * @returns {string} absolute data dir path
 */
export function resolveDataDir(opts = {}) {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  const flagValue = parseDataDirFlag(argv);
  const raw =
    flagValue ??
    (env.GENERAPTOR_DATA_DIR && String(env.GENERAPTOR_DATA_DIR).trim()
      ? String(env.GENERAPTOR_DATA_DIR)
      : null) ??
    join(home, DEFAULT_DATA_DIR_NAME);

  const expanded = expandTilde(raw, home);
  const dir = isAbsolute(expanded) ? expanded : resolve(expanded);
  // SEC-04: the data dir holds the database AND the per-install secret key
  // file — it must not be readable by other users (POSIX: 0700).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * CWE-276/CWE-732: is the data dir NOT private?
 *
 * The operator may point --data-dir at a shared location. The modes are
 * tightened best effort (hardenDataPermissions), but when the location is
 * still readable by others the operator must be told — the provider key file
 * lives there. The message carries the PATH only, never key material.
 *
 * Platform rules (results/s5-security-pre.md §4.3 п.5):
 *   - POSIX: the directory mode grants group/other access (mode & 0o077);
 *   - Windows: POSIX bits are not the boundary (NTFS ACLs are), so the rule is
 *     "the path lies outside the user profile".
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] - absolute data directory
 * @param {string} [opts.home] - the user profile (default: os.homedir())
 * @param {string} [opts.platform] - default: process.platform
 * @returns {string|null} the warning line, or null when the location is private
 */
export function dataDirPrivacyWarning(opts = {}) {
  const { dataDir, home = homedir(), platform = process.platform } = opts;
  if (!dataDir) return null;
  const dir = resolve(String(dataDir));

  if (platform === 'win32') {
    const profile = resolve(String(home)).toLowerCase();
    const candidate = dir.toLowerCase();
    const inside = candidate === profile || candidate.startsWith(profile + sep);
    if (inside) return null;
    return `[Data] WARNING: data dir ${dir} is outside the user profile — other users may be able to read the provider key file`;
  }

  let mode;
  try {
    mode = statSync(dir).mode;
  } catch {
    return null; // nothing to judge (the dir may not exist yet)
  }
  if ((mode & 0o077) === 0) return null;
  return `[Data] WARNING: data dir ${dir} is readable by other users (mode 0${(mode & 0o777).toString(8)}) — the provider key file may be exposed`;
}

/**
 * SEC-04: a caller may hand over the database FILE PATH directly instead of a
 * Prisma 'file:' URL. Hardening must not silently skip the file in that case —
 * a group/other-readable SQLite file exposes the encrypted provider keys.
 * URL schemes (postgres://, mysql:, sqlserver:, …) are never treated as paths;
 * a single-letter Windows drive prefix ('C:\…') is NOT a scheme.
 *
 * @param {string} [value] - a bare filesystem path (relative or absolute)
 * @returns {string|null} absolute path, or null when the value is not a path
 */
function bareDatabaseFilePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('file:') || /^[a-z][a-z0-9+.-]+:/i.test(raw)) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * Tightens the permissions of the data dir and of the SQLite file (SEC-04).
 *
 * POSIX semantics: the dir becomes 0700, the database file 0600. On Windows
 * the POSIX mode bits are not the security boundary (NTFS ACLs are), so the
 * chmod calls are best effort and may be a no-op there.
 *
 * After the best-effort hardening the location is re-checked and, when
 * it is still not private, the operator is warned (see dataDirPrivacyWarning).
 *
 * @param {object} opts
 * @param {string} [opts.dataDir] - absolute data directory
 * @param {string} [opts.databaseUrl] - Prisma database URL ('file:<path>') or a bare database file path
 * @param {string} [opts.home] - the user profile for the privacy check
 * @param {string} [opts.platform] - platform for the privacy check
 * @param {(message: string) => void} [opts.log] - warning sink (console.warn)
 * @returns {boolean} true when at least one path was hardened
 */
export function hardenDataPermissions(opts = {}) {
  const { dataDir, databaseUrl, home, platform, log = console.warn } = opts;
  let touched = false;
  if (dataDir) {
    try {
      chmodSync(dataDir, 0o700);
      touched = true;
    } catch {
      /* best effort (Windows / unsupported filesystem) */
    }
  }
  const dbFile = databaseFilePathFromUrl(databaseUrl) ?? bareDatabaseFilePath(databaseUrl);
  if (dbFile) {
    try {
      chmodSync(dbFile, 0o600);
      touched = true;
    } catch {
      /* best effort (the file may not exist yet) */
    }
  }
  const warning = dataDirPrivacyWarning({ dataDir, home, platform });
  if (warning) log(warning);
  return touched;
}

/**
 * Extracts the local file path from a Prisma 'file:' URL.
 * @param {string} [databaseUrl]
 * @returns {string|null}
 */
export function databaseFilePathFromUrl(databaseUrl) {
  const url = String(databaseUrl || '').trim();
  if (!url.startsWith('file:')) return null;
  const raw = url.slice('file:'.length).split('?')[0];
  if (!raw) return null;
  const absolute = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return absolute.split('/').join(sep);
}

/**
 * Build the Prisma SQLite URL for <dataDir>/generaptor.db.
 * Forward slashes only — Prisma `file:` URLs on Windows require them.
 *
 * @param {string} dataDir - absolute data directory
 * @returns {string} e.g. 'file:C:/Users/x/.generaptor/generaptor.db'
 */
export function resolveDatabaseUrl(dataDir) {
  const normalized = dataDir.split(sep).join('/');
  return `file:${normalized}/${DATABASE_FILE_NAME}`;
}

// Re-export for convenience of programmatic consumers (keeps a single import site).
export { fileURLToPath };
