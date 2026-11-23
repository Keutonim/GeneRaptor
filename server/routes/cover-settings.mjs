/**
 * Cover wave (2026-10-24, docs/architecture.md §7): cover generation
 * settings API. Envelope pattern mirrors the retired moderated-settings
 * {success:true,data}, validation errors carry a machine `code`), mounted
 * behind the existing requireGate cookie gate — no new auth logic.
 *
 * route family: the cover endpoint
 * answers 200 with COVER_SETTINGS_DEFAULTS + configured:false when no row exists — the
 * settings panel renders defaults and the row is created on the first PUT.
 */
import { Router } from 'express';
import {
  COVER_SETTINGS_DEFAULTS,
  getCoverSettings,
  saveCoverSettings,
  CoverSettingsError,
} from '../lib/cover-settings.mjs';
// M5 (D9): availability follows the images capability of the active
// provider — the resolution lives in the cover service (one place, one truth).
import { resolveCoverAvailability } from '../lib/cover-service.mjs';
import {
  estimateImageCostRub,
  spentThisMonthRub,
} from '../lib/cover-pricing.mjs';

const router = Router();

function success(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, message, status = 400, code) {
  return res.status(status).json({ success: false, error: message, ...(code ? { code } : {}) });
}

/** GET / — the effective settings (defaults when no row; NEVER 404). */
router.get('/', async (req, res) => {
  try {
    const settings = await getCoverSettings();

    // Cover checkbox wave: the ArticleForm
    // checkbox needs the integration-readiness signal the settings payload
    // never carried. Additive fields only — old clients ignore them.
    //
    // available uses the SAME formula as GET /articles/:id/content
    // (coverAvailable) — M5 (D9): settings.enabled && the active provider
    // can generate images. WordPress is NOT part of the cover flow anymore.
    // `configured === false` (no settings row) does NOT block: defaults are
    // enabled:true, so the checkbox stays active when integrations exist.
    // unavailableReason names the FIRST blocking cause for the disabled hint.
    const availability = await resolveCoverAvailability();
    const unavailableReason = availability.reason;

    // «+~5 ₽» hint: the flat per-image price for the effective
    // model/resolution/quality, null when unknown (token-priced models,
    // quality:auto — the hint then degrades to
    // «Цена зависит от модели» client-side.
    const estimatedCoverCostRub = estimateImageCostRub(
      settings.model,
      settings.resolution,
      settings.quality,
    );

    // P2 budget line («Из лимита 300 ₽ в месяц использовано 13 ₽»). A ledger
    // read failure must not break the settings fetch — degrade to null.
    let spentThisMonthRubValue = null;
    try {
      spentThisMonthRubValue = await spentThisMonthRub(new Date());
    } catch (spendErr) {
      console.warn(`[CoverSettings] spend read failed: ${spendErr?.message || spendErr}`);
    }

    return success(res, {
      ...settings,
      available: unavailableReason === null,
      unavailableReason,
      estimatedCoverCostRub,
      spentThisMonthRub: spentThisMonthRubValue,
    });
  } catch (err) {
    console.error('[CoverSettings] GET settings failed:', err);
    return fail(res, 'Failed to load cover settings', 500);
  }
});

/**
 * PUT / — partial merge onto the existing row (or defaults), validated as a
 * complete object; unknown body keys rejected BEFORE anything persists.
 * The multiline promptTemplate is stored and returned byte-identically
 * (merge/validation never re-format it).
 */
router.put('/', async (req, res) => {
  try {
    const body = req.body || {};

    const unknown = Object.keys(body).filter((k) => !(k in COVER_SETTINGS_DEFAULTS));
    if (unknown.length > 0) {
      return fail(res, `Unknown field: ${unknown[0]}`, 400, 'cover_settings_unknown_field');
    }

    const saved = await saveCoverSettings(body);
    return success(res, saved);
  } catch (err) {
    if (err instanceof CoverSettingsError) {
      return fail(res, err.message, 400, err.code);
    }
    console.error('[CoverSettings] PUT settings failed:', err);
    return fail(res, 'Failed to save cover settings', 500);
  }
});

export default router;
