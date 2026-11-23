import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { prisma, connectDB, disconnectDB } from './db.mjs';
import { createWebSocketServer } from './websocket.mjs';
import { createArticleGenerationWorker } from './workers/article-generation.mjs';
// M2: mounts trimmed to the GeneRaptor surface — articles
// (+research-sources), settings {cover, api-keys, agent-roles}, /api/yandex
// research search, health, auth. Publishing/topic-picking/crawl/frequency-keyword
// trees are deleted with their route files.
import { closeQueues } from './queue.mjs';
import { sweepStaleJobs } from './lib/stale-job-sweep.mjs';
import { articlesRouter } from './routes/articles.mjs';
// Cover wave (2026-10-24, docs/architecture.md §7): cover generation settings API.
import coverSettingsRoutes from './routes/cover-settings.mjs';
// Settings audit (2026-10-26): server-side API key status + real probe.
import apiKeysRoutes from './routes/api-keys.mjs';
// Settings audit (2026-10-26): пользовательские правки промптов ролей.
import agentRolesRoutes from './routes/agent-roles.mjs';
// M3: provider settings (masked ProviderConfig CRUD + probe) and
// the model-catalog proxy.
import providersSettingsRoutes, {
  providerCatalogRoutes,
} from './routes/providers.mjs';
import { loadAgentRoleOverrides } from './lib/agent-role-overrides.mjs';
import yandexSearchRoutes from './routes/yandex-search.mjs';
import webSearchRoutes from './routes/web-search.mjs';
import researchSourceRoutes from './routes/research-sources.mjs';
import { healthRouter } from './routes/health.mjs';
import { authRouter } from './routes/auth.mjs';
import { requireGate, verifyWsConnection } from './lib/auth.mjs';
import { isApiPath, requestPathname } from './lib/api-paths.mjs';
// SEC-05: one resolver for "where do we listen?" — the launcher, the banner
// and the server itself all read the bind host through it.
import { resolveBindHost } from './lib/launcher-args.mjs';
import {
  STATE_CHANGING_METHODS,
  allowedOrigins,
  checkUpgradeOrigin,
  devUiOrigins,
  isAllowedHostHeader,
  isAllowedOrigin,
  ownHostnames,
} from './lib/request-origin.mjs';
// The launcher's dev-topology marker arrives as an argv flag.
import { resolveDevUiOrigin } from './lib/data-dir.mjs';
// CWE-117: the Origin header is client-controlled — never log it raw.
import { sanitizeLogText } from './lib/log-sanitize.mjs';

const app = express();

// M4: `trust proxy` dropped — this is a localhost tool; with
// it, req.ip could be spoofed via X-Forwarded-For from another LAN client,
// defeating the per-IP exchange rate limit.

/**
 * Initialize Express application with middleware and routes.
 * Returns the HTTP server instance (with WebSocket attached).
 */
export async function createExpressApp() {
  // CORS — the READING surface. ACAO stays exactly the configured CORS_ORIGIN:
  // the dev loopback alias below is a GUARD allowance (may this Origin mutate?),
  // never a grant to read responses with cookies. In the dev topology the UI
  // calls the API through the Vite proxy with relative URLs, so the browser
  // request is same-origin and CORS is not involved at all.
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  // The dev-topology marker, read ONCE and passed to both the HTTP guard
  // and the WS handshake. It is present only when the launcher started Vite
  // itself (`--dev-ui-origin`); packaged and --api-only runs carry no flag, so
  // their origin set is never widened — NODE_ENV takes no part in the decision.
  const devUiOrigin = resolveDevUiOrigin();
  const devUiAliasOrigins = devUiOrigins(devUiOrigin);

  // JSON body parser
  app.use(express.json({ limit: '10mb' }));

  // Cookie parser — must run before requireGate reads req.cookies.
  app.use(cookieParser());

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(
        `[HTTP] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`
      );
    });
    next();
  });

  // --- SEC-03: Host / Origin validation -------------------------------------
  // The server is reachable from a browser, so a forged Host (DNS rebinding)
  // or a foreign Origin must not be processed like a request from the local
  // UI. The Host must name one of the server's own hosts with the port the
  // server REALLY listens on; a state-changing /api request with an Origin
  // (or Referer) that is not the server's own origin is refused.
  const bindHost = resolveBindHost(process.env);
  app.use((req, res, next) => {
    const actualPort = req.socket?.localPort;
    if (!isAllowedHostHeader(req.headers.host, actualPort, { hostnames: ownHostnames(bindHost) })) {
      return res.status(403).json({ error: 'Запрещённый Host' });
    }
    if (STATE_CHANGING_METHODS.has(req.method) && isApiPath(requestPathname(req))) {
      const candidate = req.headers.origin || req.headers.referer;
      if (candidate) {
        const allowed = allowedOrigins({ actualPort, bindHost, corsOrigin, devUiOrigin });
        if (!isAllowedOrigin(candidate, { allowedOrigins: allowed })) {
          // CWE-778: a silent 403 is what made the owner's "delete is broken"
          // bug undiagnosable. CWE-117: the value is client-controlled, so it
          // goes through sanitizeLogText (CR/LF/C0/C1 flattened, bounded).
          console.warn(`[Origin] rejected origin: ${sanitizeLogText(candidate)}`);
          return res.status(403).json({ error: 'Запрещённый Origin' });
        }
      }
    }
    next();
  });

  // --- Public routes (before the gate) -------------------------------------
  // Health check is public so Docker/Playwright healthchecks work without a
  // cookie (R-08). It returns only booleans/non-sensitive config — never secrets.
  app.use('/api', healthRouter);

  // Auth endpoints must be reachable before the user has a session cookie
  // (M4: POST /api/auth/exchange + GET /api/auth/status + POST /api/auth/logout).
  app.use('/api/auth', authRouter);

  // --- The gate (R-08, G6) -------------------------------------------------
  // Every /api/* request below requires a valid `generaptor_auth` session cookie.
  // Non-/api GETs (SPA shell, assets) pass so the React TokenGate can load —
  // it is the client-side full-screen lock.
  app.use(requireGate);

  // Route mounting (M2: trimmed)
  app.use('/api', articlesRouter);
  app.use('/api/articles', researchSourceRoutes);
  // Cover wave (2026-10-24): cover settings API, same place, before the 404.
  app.use('/api/settings/cover', coverSettingsRoutes);
  // Settings audit (2026-10-26): API key status + real probe.
  app.use('/api/settings/api-keys', apiKeysRoutes);
  // Settings audit (2026-10-26): правки systemPrompt агентских ролей.
  app.use('/api/settings/agent-roles', agentRolesRoutes);
  // M3: провайдеры/ключи (маскированный CRUD + проба) и каталог
  // моделей провайдера.
  app.use('/api/settings/providers', providersSettingsRoutes);
  app.use('/api/providers', providerCatalogRoutes);
  app.use('/api/yandex', yandexSearchRoutes);
  // Generic web-search layer (keyless by default) — one contract, several
  // backends, degrades gracefully instead of failing the request.
  app.use('/api/search', webSearchRoutes);

  // API 404 — any unmatched /api/* request returns JSON, never the SPA shell.
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // Serve the built frontend (dist/) when it exists. In dev, Vite handles this.
  // SPA history fallback: any non-API GET returns index.html so client-side
  // routing works on deep links.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distDir = join(__dirname, '..', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      // SEC-01: the API surface is matched case-insensitively by Express, so
      // the "never serve the SPA shell for an API path" rule must be too.
      if (req.method !== 'GET' || isApiPath(requestPathname(req))) return next();
      res.sendFile(join(distDir, 'index.html'));
    });
    console.log(`[Express] Serving frontend from ${distDir}`);
  }

  // 404 handler (only reached when dist/ is absent, e.g. a dev run without build)
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[Express] Unhandled error:', err);
    const status = err.status || err.statusCode || 500;
    const message = status === 500 ? 'Internal server error' : (err.message || 'Internal server error');
    res.status(status).json({
      success: false,
      error: message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  });

  // M1: mark articles left in queued|running by a previous
  // process as failed BEFORE the server listens — no request can enqueue a
  // fresh job before the sweep settles, and swept articles become
  // restartable via /start (allowedStartStatuses excludes queued|running).
  await sweepStaleJobs();

  // Start HTTP server — loopback-only by default. GENERAPTOR_HOST
  // (launcher `--host`) is the explicit opt-in to expose other interfaces.
  const port = process.env.GENERAPTOR_API_PORT || 8787;
  const host = resolveBindHost(process.env);
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.log(`[Express] Server listening on ${srv.address().address}:${srv.address().port}`);
      resolve(srv);
    });
    srv.on('error', reject);
  });

  // CWE-778: the effective trust set is observable at boot — the
  // operator sees exactly which Origins may mutate state and whether the dev
  // loopback alias is active. Origins only, never secrets.
  const boundPort = server.address()?.port ?? port;
  const effectiveOrigins = allowedOrigins({
    actualPort: boundPort,
    bindHost: host,
    corsOrigin,
    devUiOrigin,
  });
  console.log(`[Origin] allowed origins: ${[...effectiveOrigins].sort().join(', ')}`);
  if (devUiAliasOrigins.length > 0) {
    const [markerOrigin, aliasOrigin] = devUiAliasOrigins;
    console.log(
      aliasOrigin
        ? `[Origin] dev UI origin: ${markerOrigin} (loopback alias enabled: ${aliasOrigin})`
        : `[Origin] dev UI origin: ${markerOrigin} (no loopback alias for this host)`,
    );
    // The owner's .env says production while the launcher starts Vite. The
    // alias follows the TOPOLOGY (the marker), so say so instead of letting
    // the operator believe NODE_ENV decided it.
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        `[Origin] WARNING: NODE_ENV=production but the launcher started a dev UI (${markerOrigin}) — the loopback alias follows the topology, not NODE_ENV`,
      );
    }
  }

  // Attach WebSocket server. WS upgrade bypasses Express middleware, so the
  // cookie check happens in verifyClient at handshake time (R-01, G10).
  createWebSocketServer(server, {
    verifyClient: (info, cb) => {
      // SEC-03: the upgrade bypasses the Express middleware, so the origin
      // rule is applied here, at handshake time — with the SAME marker.
      const originCheck = checkUpgradeOrigin(info, { bindHost, corsOrigin, devUiOrigin });
      if (!originCheck.allowed) {
        // CWE-778 / CWE-117: the WS refusal is logged like the HTTP one, and
        // the client-controlled value is sanitized before it reaches the log.
        const candidate = info?.origin || info?.req?.headers?.origin || info?.req?.headers?.referer;
        console.warn(`[Origin] rejected origin: ${sanitizeLogText(candidate)}`);
        return cb(false, originCheck.status || 403, 'Forbidden');
      }
      const ok = verifyWsConnection(info);
      if (ok) return cb(true);
      return cb(false, 401, 'Unauthorized');
    },
  });

  // Start article generation worker (in-process runner, M1)
  const articleGenerationWorker = createArticleGenerationWorker();

  // Settings audit (2026-10-26): подтягиваем правки промптов агентских
  // ролей в кэш рантайма. Fire-and-forget: падение БД не должно ронять старт
  // сервера — тогда агенты работают по статическому каталогу.
  loadAgentRoleOverrides().catch((err) => {
    console.error('[AgentRoles] boot overrides load failed:', err?.message || err);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[Express] Received ${signal}, starting graceful shutdown...`);

    server.close(async () => {
      console.log('[Express] HTTP server closed');
      try {
        await articleGenerationWorker.close();
        console.log('[Express] Article generation worker closed');
      } catch (err) {
        console.error('[Express] Error closing article generation worker:', err.message);
      }
      try {
        await closeQueues();
        console.log('[Express] Queue shim drained and closed');
      } catch (err) {
        console.error('[Express] Error closing queues:', err.message);
      }
      await disconnectDB();
      console.log('[Express] Graceful shutdown complete');
      process.exit(0);
    });

    // Force exit after 15 seconds
    setTimeout(() => {
      console.error('[Express] Forced shutdown after timeout');
      process.exit(1);
    }, 15000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

export { app };
