#!/usr/bin/env node
/**
 * GeneRaptor launcher + CLI (M1; M9 open-source packaging).
 *
 *   npm start                 # dev: API + Vite frontend, one command
 *   npx generaptor            # published package: API + the built frontend
 *   npx generaptor --help
 *
 * Starts the API (server/index.mjs, with the in-process article-generation
 * runner) and — in dev — the Vite frontend, with graceful shutdown on Ctrl+C.
 *
 * No external services: SQLite under the data dir (default ~/.generaptor,
 * override with --data-dir or GENERAPTOR_DATA_DIR). On first run the database
 * file is created via `prisma db push`.
 *
 * The one-time startup token is printed ONCE, on the owner console (this
 * launcher), and never in the application logs.
 */
import { spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';

// `quiet: true` silences the dotenv v17 tips banner — the CLI must not print
// anything but its own output.
dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = __dirname;

// Resolves packages through the normal node_modules lookup — in an installed
// package the Prisma CLI is hoisted into the *consumer's* node_modules, so a
// hardcoded `<root>/node_modules/prisma/...` path does not exist there.
const require = createRequire(import.meta.url);

import { resolveDataDir, resolveDatabaseUrl, hardenDataPermissions, DATABASE_FILE_NAME } from './server/lib/data-dir.mjs';
// M5: the bootstrap guard treats a zero-length db file as "not a database".
// The file helpers are reused as-is; the `prisma db push` call itself lives
// in the launcher (see bootstrapDatabase) because the CLI path must be
// resolved through node_modules, not through a fixed directory.
import { needsDatabaseBootstrap, prepareDatabaseFile } from './server/lib/db-bootstrap.mjs';
// M4 auth & network: launcher flags + one-time startup token.
import {
  parseAuthFlags,
  applyAuthFlags,
  formatTokenBanner,
  formatFrontendStatusLine,
  resolveUiAvailability,
  announceNoAuth,
  LauncherUsageError,
  resolveBindHost,
  formatHostForUrl,
  announceNetworkExposure,
  isNetworkExposedHost,
  resolveLauncherPorts,
  resolveDevUiOrigin,
  devUiOriginArgs,
} from './server/lib/launcher-args.mjs';
import { generateStartupToken, TOKEN_ACCEPTANCE_WINDOW_MS } from './server/lib/startup-token.mjs';
// Auto-open the app in the default browser (the one-time token rides
// the URL fragment, never the query — the HTTP logger prints req.url).
import {
  shouldAutoOpenBrowser,
  buildAutoOpenUrl,
  openBrowser,
  waitForUiReady,
} from './server/lib/open-browser.mjs';

const processes = [];
let shuttingDown = false;

/**
 * The Vite dev server proxies `/api` and `/ws` to this fixed port
 * (see vite.config.ts). The launcher cannot retarget it from here, so when
 * the API runs on another port the operator has to be told that the manually
 * started dev server will not reach it.
 */
const VITE_DEV_PROXY_API_PORT = 8787;

/* ------------------------------------------------------------------ */
/*  CLI (M9): --port / --data-dir / --no-auth / --help / --version     */
/* ------------------------------------------------------------------ */

/**
 * Parse the launcher-owned CLI flags.
 *
 * `--data-dir`, `--no-auth`, `--token`, `--token-ttl` and `--host` are owned by
 * server/lib/data-dir.mjs and server/lib/launcher-args.mjs (they map onto the
 * environment the server consumes); this function owns the rest.
 *
 * @param {string[]} argv
 * @returns {{ port: number|null, help: boolean, version: boolean, apiOnly: boolean, noBrowser: boolean }}
 *   `port` is null when the flag is absent and NaN when the value is invalid.
 */
export function parseCliFlags(argv = []) {
  const out = { port: null, help: false, version: false, apiOnly: false, noBrowser: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--version' || arg === '-v') {
      out.version = true;
    } else if (arg === '--api-only') {
      out.apiOnly = true;
    } else if (arg === '--no-browser') {
      // Soft rollback to the manual scenario (banner + manual entry).
      out.noBrowser = true;
    } else if (arg === '--port') {
      out.port = toPort(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      out.port = toPort(arg.slice('--port='.length));
    }
  }
  return out;
}

/**
 * @param {string|undefined} raw
 * @returns {number|null} the port, null when absent, NaN when invalid
 */
function toPort(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return NaN;
  return value;
}

/** @returns {string} the version from the package manifest */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Print the CLI help (owner console only). */
function printHelp() {
  console.log(
    [
      `GeneRaptor ${readVersion()} — local AI article studio (MIT)`,
      '',
      'Usage:',
      '  generaptor [options]            # published package (npx generaptor)',
      '  npm start -- [options]           # dev mode: API + Vite frontend',
      '',
      'Options:',
      '  --port <port>       Port of the local app (packaged: 8787, dev UI: 5173, --api-only: API port)',
      '  --data-dir <dir>    SQLite data directory (default: ~/.generaptor)',
      '  --api-only          Start only the API server (no frontend process)',
      '  --no-browser        Do not open the browser automatically',
      '  --no-auth           Disable the access gate — prints a loud warning',
      '  --token <token>     Use a fixed reusable token instead of the one-time token',
      '  --token-ttl <v>     One-time token lifetime (session|24h|7d|30d)',
      '  --host <addr>       Bind address (default: 127.0.0.1 — loopback only)',
      '  -h, --help          Show this help and exit',
      '  -v, --version       Print the version and exit',
      '',
      'Environment: see .env.example (ROUTERAI_API_KEY, GENERAPTOR_DATA_DIR,',
      'ACCESS_GATE_DISABLED, JWT_SECRET, ...).',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ */
/*  Data dir + SQLite bootstrap                                        */
/* ------------------------------------------------------------------ */

function bootstrapDatabase() {
  const dataDir = resolveDataDir();
  const derivedUrl = resolveDatabaseUrl(dataDir);
  // M2: an explicit DATABASE_URL (shell env or
  // .env) wins — the launcher derives the bundled SQLite URL only when the
  // user has not chosen one, and never rewrites a user-provided URL.
  const userDatabaseUrl = (process.env.DATABASE_URL || '').trim();
  const dbUrl = userDatabaseUrl || derivedUrl;
  process.env.DATABASE_URL = dbUrl; // inherited by spawned children

  const dbFile = join(dataDir, DATABASE_FILE_NAME);
  // A ZERO-LENGTH db file is not a database —
  // `prisma db push` skips it and the app dies at boot with P2021. The
  // bootstrap guard removes the empty file and recreates the schema.
  if (!userDatabaseUrl) {
    const prepared = prepareDatabaseFile(dbFile);
    if (prepared.removed) {
      console.log(
        `   Empty database file found — removing it so the schema can be recreated (${dbFile}).`,
      );
    }
    if (needsDatabaseBootstrap(dbFile)) {
      const prismaCli = resolvePrismaCli();
      if (!prismaCli) {
        console.error('   The Prisma CLI is missing (the `prisma` package is not installed).');
        process.exit(1);
      }
      console.log(`   Creating the database schema at ${dbFile} (prisma db push)...`);
      const result = spawnSync(
        process.execPath,
        [prismaCli, 'db', 'push', '--skip-generate'],
        { cwd: ROOT, env: process.env, encoding: 'utf8' },
      );
      if (result.status !== 0) {
        console.error(result.stdout);
        console.error(result.stderr);
        console.error('   Failed to create the database. Run `npx prisma db push` manually.');
        process.exit(1);
      }
    }
  }
  // SEC-04: the data dir (0700) and the freshly created SQLite file (0600)
  // hold the encrypted provider keys — tighten the modes right after the
  // database exists.
  hardenDataPermissions({ dataDir, databaseUrl: dbUrl });
  return { dataDir, dbUrl };
}

/* ------------------------------------------------------------------ */
/*  Prisma client bootstrap                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve the Prisma CLI entry point.
 *
 * The CLI is a runtime dependency (the launcher runs `prisma db push` and
 * `prisma generate`), but npm hoists it into the *consumer's* node_modules
 * when GeneRaptor is installed as a package. A fixed
 * `<root>/node_modules/prisma/build/index.js` path only works in a checkout,
 * so the lookup goes through the normal node_modules resolution instead.
 *
 * @returns {string|null} the CLI path, or null when `prisma` is not installed
 */
function resolvePrismaCli() {
  try {
    return require.resolve('prisma/build/index.js');
  } catch {
    return null;
  }
}

/**
 * Is the generated Prisma client usable?
 *
 * Prisma 5 writes it to `node_modules/.prisma/client`; the probe below also
 * covers other layouts and, most importantly, the *un-generated stub* — that
 * one throws on require, so it is correctly reported as "not ready".
 *
 * The probe uses CJS `require` on purpose: ESM caches module-evaluation
 * failures, so a dynamic `import()` that ran before `prisma generate` would
 * keep failing afterwards. The CJS loader drops a module from its cache when
 * the evaluation throws, so the next probe sees the freshly generated client.
 *
 * @returns {boolean}
 */
function prismaClientReady() {
  if (existsSync(join(ROOT, 'node_modules', '.prisma', 'client', 'default.js'))) {
    return true;
  }
  try {
    const mod = require('@prisma/client');
    return typeof mod.PrismaClient === 'function';
  } catch {
    return false;
  }
}

/**
 * Boot-time Prisma bootstrap (M9).
 *
 * `npm install` runs scripts/ensure-prisma-client.mjs, which generates the
 * client — but npm (>= 12) reinstalls/prunes `node_modules` AFTER the root
 * lifecycle scripts, and it blocks install scripts altogether unless they are
 * approved. The launcher therefore regenerates the client on demand instead
 * of dying with "Prisma client is not ready".
 *
 * @returns {Promise<boolean>} true when the client is ready afterwards
 */
async function ensurePrismaClient() {
  if (prismaClientReady()) return true;

  const prismaCli = resolvePrismaCli();
  if (!prismaCli) {
    console.error('   The Prisma CLI is missing (the `prisma` package is not installed).');
    return false;
  }

  console.log('   Prisma client is missing — generating it (prisma generate)...');
  const env = { ...process.env };
  if (!env.DATABASE_URL) {
    // Placeholder only: `generate` never opens the database.
    env.DATABASE_URL = 'file:./.prisma-bootstrap-placeholder.db';
  }
  const result = spawnSync(process.execPath, [prismaCli, 'generate'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('   prisma generate failed — run `npx prisma generate` manually.');
    return false;
  }
  return prismaClientReady();
}

/* ------------------------------------------------------------------ */
/*  Process management                                                 */
/* ------------------------------------------------------------------ */

function startProcess(name, cmd, args, cwd = ROOT) {
  const proc = spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  proc.on('error', (err) => {
    console.error(`\n[ERROR] ${name} failed to start: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.log(`\n[EXIT] ${name} exited (code=${code}, signal=${signal})`);
    }
  });

  processes.push({ name, proc });
  return proc;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[STOP] Stopping all processes...');

  for (const { name, proc } of processes) {
    if (!proc.killed) {
      console.log(`   stop ${name} (PID ${proc.pid})`);
      proc.kill('SIGTERM');
    }
  }

  // Force-kill after 3s if anything is still alive.
  setTimeout(() => {
    for (const { name, proc } of processes) {
      if (!proc.killed) {
        console.log(`   FORCE KILL ${name}`);
        proc.kill('SIGKILL');
      }
    }
    process.exit(0);
  }, 3000);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const cli = parseCliFlags(process.argv.slice(2));

  // --help / --version must work everywhere (no DB, no server, no tokens).
  if (cli.help) {
    printHelp();
    return 0;
  }
  if (cli.version) {
    console.log(`generaptor ${readVersion()}`);
    return 0;
  }
  if (Number.isNaN(cli.port)) {
    console.error('[ERROR] --port must be an integer between 1 and 65535.');
    process.exit(1);
  }

  // --- M4 auth & network block --------------------------------
  // Flags -> env for the server child; the one-time token is generated here
  // so the launcher can print the boot banner exactly once.
  //
  // SEC-05: the flags are parsed BEFORE anything is started, so a usage
  // error (`--host` without an address) fails fast with a non-zero exit
  // instead of silently widening the bind.
  let authFlags;
  try {
    authFlags = parseAuthFlags(process.argv.slice(2));
  } catch (err) {
    if (err instanceof LauncherUsageError) {
      console.error(`[ERROR] ${err.message}`);
      console.error('   Run "generaptor --help" for the list of options.');
      process.exit(1);
    }
    throw err;
  }

  const hasDist = existsSync(join(ROOT, 'dist'));
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteAvailable = existsSync(viteBin);
  // Packaged install: vite is a devDependency (absent) and dist/ is shipped ->
  // serve the prebuilt frontend from the API server. A source checkout keeps
  // the Vite dev server unless NODE_ENV=production.
  const useProdBuild = hasDist && (process.env.NODE_ENV === 'production' || !viteAvailable);
  if (!hasDist && !viteAvailable) {
    console.error('   The GeneRaptor frontend build is missing (dist/).');
    console.error('   Reinstall the package, or run `npm run build` in a source checkout.');
    process.exit(1);
  }

  // Ports: the packaged app is a single server (UI + API); in dev the UI runs
  // on the Vite port and the API keeps its own port. With --api-only there is
  // no Vite server at all, so --port describes the API itself (O-1).
  const { apiPort, uiPort, env: portEnv } = resolveLauncherPorts({
    port: cli.port,
    apiOnly: cli.apiOnly,
    useProdBuild,
    env: process.env,
  });
  Object.assign(process.env, portEnv);

  console.log(
    `=== GeneRaptor startup (${useProdBuild ? 'production' : 'development'}) ===\n`,
  );
  console.log('[1/3] Preparing the local database...');

  // --- M4 auth & network block --------------------------------
  // The flags were parsed (and validated) at the top of main(); here they are
  // mapped onto the env the server child inherits.
  applyAuthFlags(authFlags);
  if (authFlags.noAuth) {
    // D8 (hardening): the launcher owns the warning — it marks the env so
    // the API server it spawns does not print the very same banner again.
    announceNoAuth(process.env);
  }
  if (!authFlags.noAuth && !authFlags.token) {
    process.env.GENERAPTOR_STARTUP_TOKEN = generateStartupToken();
  }
  // SEC-05: a network-reachable bind is announced here (the launcher owns
  // the warning; the spawned server stays silent through the env marker).
  const bindHost = resolveBindHost(process.env);
  if (isNetworkExposedHost(bindHost)) {
    announceNetworkExposure(process.env);
  }
  // ----------------------------------------------------------------------

  const { dataDir } = bootstrapDatabase();
  // The server child has no --data-dir in its argv — without this env
  // its resolveDataDir() falls back to ~/.generaptor, so cover binaries and
  // the secret key file land OUTSIDE the instance dir and the delete cascade
  // (removeArticleCovers) cleans the wrong covers dir. Export the resolved
  // dir so the server, the in-process worker and every file operation share
  // ONE data dir. Default installs keep ~/.generaptor (same value as before).
  process.env.GENERAPTOR_DATA_DIR = dataDir;

  if (!(await ensurePrismaClient())) {
    console.error('\nPrisma client is not ready. Run: npx prisma generate');
    process.exit(1);
  }
  console.log(`   Data dir: ${dataDir}`);

  console.log('\n[2/3] Starting services...\n');

  // SEC-05: the banner reports the host the app really listens on — never a
  // hardcoded 127.0.0.1.
  const hostForUrl = formatHostForUrl(bindHost);
  const apiUrl = `http://${hostForUrl}:${apiPort}`;
  const devUiUrl = `http://${hostForUrl}:${uiPort}`;

  // The dev UI origin must be an allowed Origin for the exchange
  // POST proxied by Vite. Only when the operator has not chosen CORS_ORIGIN,
  // and only in the dev mode where the UI really is a separate origin.
  if (!cli.apiOnly && !useProdBuild && !process.env.CORS_ORIGIN) {
    process.env.CORS_ORIGIN = `http://${hostForUrl}:${uiPort}`;
  }

  // The dev-topology marker for the API child. The browser may
  // open EITHER loopback spelling of the Vite UI origin (localhost vs
  // 127.0.0.1); the SEC-03 Origin guard accepts both spellings of that SAME
  // origin only when WE started Vite. The marker is an argv flag — no new env
  // variable, nothing inherited from the operator's environment — and it is
  // emitted ONLY in the dev topology. Packaged and --api-only runs get an empty
  // fragment, so their origin set is never widened.
  //
  // NODE_ENV takes NO part here: the owner's .env sets NODE_ENV=production
  // while this launcher still starts Vite (no dist/ in that checkout), and a
  // NODE_ENV-based rule left his 403 «Запрещённый Origin» bug unfixed.
  const devUiOrigin = resolveDevUiOrigin({
    useProdBuild,
    apiOnly: cli.apiOnly,
    hostForUrl,
    uiPort,
  });

  // FIX-08/FIX-09: ONE shared helper decides where the UI really is. The API
  // server mounts dist/ whenever it exists — in EVERY mode — so `--api-only`
  // cannot claim that the UI is disabled in a packaged build.
  const ui = resolveUiAvailability({
    hasDist,
    viteAvailable,
    devServerRunning: !cli.apiOnly && !useProdBuild,
    apiUrl,
    devUiUrl,
  });

  // 1) API + in-process article runner (always needed). The dev-UI-origin
  // marker rides in argv (empty fragment outside the dev topology).
  startProcess('API', 'node', ['server/index.mjs', ...devUiOriginArgs(devUiOrigin)], ROOT);

  // 2) Frontend
  if (cli.apiOnly || useProdBuild) {
    console.log(
      `   Frontend: ${formatFrontendStatusLine({ mode: ui.mode, apiOnly: cli.apiOnly })}`
    );
  } else {
    // Dev: Vite dev server with HMR. Spawned via node + the vite bin —
    // `npx` is not spawnable on Windows without a shell.
    // SEC-05: the UI must listen on the SAME host the banner advertises.
    startProcess(
      'Frontend',
      process.execPath,
      [viteBin, 'dev', '--port', String(uiPort), '--host', bindHost],
      ROOT
    );
  }

  console.log('\n[3/3] Ready.\n');
  console.log('=============================================================');
  console.log('  GeneRaptor is running!');
  if (cli.apiOnly) {
    console.log(`     API:         ${apiUrl}`);
  }
  console.log(`     UI:          ${ui.uiLabel}`);
  if (cli.apiOnly && apiPort !== VITE_DEV_PROXY_API_PORT) {
    // The UI hint above tells the operator to start the Vite dev server, but
    // that server proxies /api to a fixed port (vite.config.ts) — say so
    // instead of leaving a silent dead end.
    console.log(
      `     Note:        the Vite dev server proxies /api to 127.0.0.1:${VITE_DEV_PROXY_API_PORT} — the UI will not reach the API on ${apiPort}`
    );
  }
  console.log(
    `     Bind:        ${bindHost}:${apiPort} (${
      isNetworkExposedHost(bindHost) ? 'network-reachable' : 'loopback only'
    })`
  );
  console.log(`     API health:  http://${hostForUrl}:${apiPort}/api/health`);
  console.log(`     WS:          ws://${hostForUrl}:${apiPort}/ws`);
  console.log(`     Data dir:    ${dataDir}`);
  // --- M4 token banner: printed once, never re-logged ---------
  if (authFlags.noAuth) {
    console.log('     Auth:        DISABLED (--no-auth) — see the warning above');
  } else if (authFlags.token) {
    console.log('     Auth:        fixed token (--token), reusable');
  } else {
    // FIX-08/FIX-09: the banner must point at an address that REALLY works.
    // The UI lives at the API root only when the built frontend is mounted
    // (server/express-app.mjs serves dist/ when it exists); otherwise it
    // lives in the Vite dev server, which the operator has to start first.
    console.log(
      formatTokenBanner({
        token: process.env.GENERAPTOR_STARTUP_TOKEN,
        url: ui.pasteUrl ?? apiUrl,
        windowMinutes: TOKEN_ACCEPTANCE_WINDOW_MS / 60000,
        uiServed: ui.uiServed,
        note: ui.note,
      })
    );
  }
  // -----------------------------------------------------------------------

  // --- Auto-open the app; the one-time token rides the URL fragment ---
  // The fragment never reaches the server (not in the request line, not in
  // Referer), so the [HTTP] logger cannot leak it. Every printed line here is
  // token-free: the banner above already printed the value exactly once.
  const tokenMode = authFlags.noAuth ? 'no-auth' : authFlags.token ? 'fixed' : 'one-time';
  const decision = shouldAutoOpenBrowser({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    noBrowserFlag: cli.noBrowser,
    ui,
    tokenMode,
  });
  if (decision.open) {
    const openUrl = buildAutoOpenUrl({
      uiUrl: ui.uiUrl,
      token: tokenMode === 'one-time' ? process.env.GENERAPTOR_STARTUP_TOKEN : null,
    });
    console.log('[Auth] Opening the app in your default browser…');
    const ready = await waitForUiReady(ui.uiUrl);
    const opened = ready ? await openBrowser(openUrl) : { ok: false };
    if (!opened.ok) {
      console.log(
        `[Auth] Browser did not open — open ${ui.uiUrl} manually${
          tokenMode === 'one-time' ? ' and paste the token above' : ''
        }.`
      );
    }
  }
  // -----------------------------------------------------------------------
  console.log('=============================================================');
  console.log('\n  Ctrl+C stops all processes\n');
  return 0;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
