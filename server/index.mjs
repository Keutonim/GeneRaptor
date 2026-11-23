import { createExpressApp } from './express-app.mjs';
// M1: platform seeding removed together with the Platform
// model (auto-publish tree is stripped from the schema; mounts go in M2).
import { getStartupTokenGate } from './lib/startup-token.mjs';
import {
  formatTokenBanner,
  formatNoAuthWarning,
  shouldPrintNoAuthWarning,
  resolveBindHost,
  isNetworkExposedHost,
  formatHostForUrl,
  formatNetworkExposureWarning,
  shouldPrintNetworkWarning,
  resolveUiAvailability,
} from './lib/launcher-args.mjs';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function main() {
  try {
    const server = await createExpressApp();
    const address = server.address();

    // SEC-05: the banner must show the host the server REALLY listens on —
    // read from the socket, never a hardcoded 127.0.0.1.
    const boundHost = address?.address || resolveBindHost(process.env);
    const boundPort = address?.port;

    // M4 boot banner: print the startup token ONCE. When the
    // launcher provided GENERAPTOR_STARTUP_TOKEN it already printed the
    // banner — re-printing would re-log the token.
    // D8 (hardening): same de-dup for the --no-auth warning — the launcher
    // prints it and marks the env, so the server must not repeat it.
    const gateDisabled = process.env.ACCESS_GATE_DISABLED === 'true';
    if (gateDisabled) {
      if (shouldPrintNoAuthWarning(process.env)) {
        console.warn(formatNoAuthWarning());
      }
    } else if (!process.env.GENERAPTOR_STARTUP_TOKEN) {
      const gate = getStartupTokenGate();
      // FIX-09: the banner must offer an address that REALLY works. The API
      // root serves the SPA only when the built frontend is mounted
      // (server/express-app.mjs mounts dist/ when it exists); without dist/
      // `GET /` there answers 404, so the token must not be sent there —
      // the UI lives in the Vite dev server, which has to be started first.
      const apiUrl = `http://${formatHostForUrl(boundHost)}:${boundPort}`;
      const devUiUrl = `http://${formatHostForUrl(boundHost)}:${process.env.PORT || 5173}`;
      const ui = resolveUiAvailability({
        hasDist: existsSync(join(ROOT, 'dist')),
        viteAvailable: existsSync(join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')),
        devServerRunning: false,
        apiUrl,
        devUiUrl,
      });
      console.log(
        formatTokenBanner({
          token: gate.token,
          url: ui.pasteUrl ?? apiUrl,
          fixed: gate.fixed,
          uiServed: ui.uiServed,
          note: ui.note,
        })
      );
    }

    // SEC-05: a network-reachable bind must be announced — the token is then
    // the only thing between the LAN and the API.
    if (shouldPrintNetworkWarning(process.env)) {
      console.log(
        formatNetworkExposureWarning({
          host: boundHost,
          url: `http://${formatHostForUrl(boundHost)}:${boundPort}`,
        })
      );
    }

    console.log('[GeneRaptor] Server started successfully');
  } catch (err) {
    console.error('[GeneRaptor] Failed to start server:', err);
    process.exit(1);
  }
}

main();
