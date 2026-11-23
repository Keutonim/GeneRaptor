/**
 * Health-check router.
 *
 * Verifies DB connectivity and reports service-configuration flags
 * (RouterAI / Yandex keys present, model names). NEVER returns the actual
 * secret values — only booleans and non-sensitive model names.
 *
 * M1 (GeneRaptor): Redis check removed (no Redis in the stack — in-process
 * runner). M2: the integration-token store is deleted with the rest of the
 * frequency-keyword tree; route surface trimmed per.
 *
 * Extracted from server/express-app.mjs so it can be tested in isolation
 * (tests/helpers.mjs createTestApp() mounts this router) and reused by
 * future admin/scaffolding entrypoints.
 */
import { Router } from 'express';
import { prisma } from '../db.mjs';

export const healthRouter = Router();

/**
 * Returns true when `value` looks like a real, non-placeholder secret.
 * Rejects the obvious placeholders used in .env.example.
 */
function isConfigured(value) {
  if (!value || typeof value !== 'string') return false;
  return !/^put_.*_here$|^change_me|^your_.*$/.test(value.trim());
}

/**
 * Build the configuration block included in every health response
 * (both 'ok' and 'degraded' branches).
 */
async function buildConfigBlock() {
  return {
    routeraiConfigured: isConfigured(process.env.ROUTERAI_API_KEY),
    yandexConfigured: isConfigured(process.env.YANDEX_SEARCH_API_KEY),
    models: {
      critical: process.env.ROUTERAI_MODEL_CRITICAL || null,
      generation: process.env.ROUTERAI_MODEL_GENERATION || null,
      standard: process.env.ROUTERAI_MODEL_STANDARD || null,
    },
  };
}

healthRouter.get('/health', async (req, res) => {
  try {
    const dbCheck = await prisma.$queryRaw`SELECT 1 as ok`;

    res.json({
      status: 'ok',
      db: dbCheck ? 'connected' : 'error',
      timestamp: new Date().toISOString(),
      ...(await buildConfigBlock()),
    });
  } catch (err) {
    // Health is now public (sits before the access gate), so the degraded
    // response must NOT leak internals (R-08). Log the detail server-side only.
    console.error('[Health] degraded:', err.message);
    res.status(503).json({
      status: 'degraded',
      error: 'degraded',
      timestamp: new Date().toISOString(),
      ...(await buildConfigBlock()),
    });
  }
});
