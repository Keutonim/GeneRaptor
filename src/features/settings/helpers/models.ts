/**
 * M6 — pure helpers of the Settings → «Модели» table.
 *
 * The server is the store of record for provider cards
 * (GET /api/settings/providers → { success, data: { providers: [...] } }).
 * The table is derived from the provider catalogue: one row per tier
 * (critical / generation / standard / cover) that some provider serves.
 */
import type { AgentRole, AgentRoleModelTier } from '../../../data/agentRoles';

export type ModelTier = AgentRoleModelTier | 'cover';

export type KeySource = 'local' | 'env' | 'none';

export type ImagesCapability = 'yes' | 'no' | 'unknown';

export interface ProviderModels {
  critical?: string;
  generation?: string;
  standard?: string;
  cover?: string;
}

export interface ProviderCard {
  kind: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  keyConfigured: boolean;
  keySource: KeySource;
  envKey: string | null;
  keyOptional: boolean;
  imagesCapability: ImagesCapability;
  models: ProviderModels;
  probeStatus?: string | null;
  probeCheckedAt?: string | null;
}

export interface ModelRow {
  tier: ModelTier;
  model: string;
  provider: string;
  providerKind: string;
  /** Number of pipeline roles that run on this tier (0 for the cover tier). */
  roles: number;
  /**
   * The cover row is a DERIVED read-only view of cover_settings.model
   * (the single applied source). Text tiers stay editable.
   */
  derived?: boolean;
}

export interface TierRoleCounts {
  critical: number;
  generation: number;
  standard: number;
}

const TIER_ORDER: ModelTier[] = ['critical', 'generation', 'standard', 'cover'];

/** How many pipeline roles work on each text tier. */
export function roleCountsByTier(roles: AgentRole[]): TierRoleCounts {
  const counts: TierRoleCounts = { critical: 0, generation: 0, standard: 0 };
  for (const role of roles ?? []) {
    if (role.modelTier === 'critical' || role.modelTier === 'generation' || role.modelTier === 'standard') {
      counts[role.modelTier] += 1;
    }
  }
  return counts;
}

/**
 * One row per tier that a provider actually serves (enabled provider wins).
 *
 * Single source of truth for the cover model: the cover row is built
 * from `coverModel` (cover_settings.model, the value cover-service applies),
 * NOT from provider.models.cover. The provider tier pin stays a transport
 * field of the unchanged API contract; the UI no longer presents it as an
 * independent choice. `coverModel` null/empty (settings not loaded) → no
 * cover row, honestly, instead of a diverging second source.
 */
export function buildModelRows(
  providers: ProviderCard[],
  counts: TierRoleCounts,
  coverModel: string | null = null,
): ModelRow[] {
  const rows: ModelRow[] = [];
  if (!Array.isArray(providers)) return rows;

  for (const tier of TIER_ORDER) {
    if (tier === 'cover') {
      if (!coverModel) continue;
      // Mirror resolveCoverProvider: the enabled images-capable provider
      // serves covers; fall back to any provider that pins a cover model.
      const provider =
        providers.find((p) => p.enabled && p.imagesCapability === 'yes') ??
        providers.find((p) => p.models?.cover) ??
        providers.find((p) => p.enabled) ??
        null;
      rows.push({
        tier,
        model: coverModel,
        provider: provider?.label ?? '',
        providerKind: provider?.kind ?? '',
        roles: 0,
        derived: true,
      });
      continue;
    }
    const provider =
      providers.find((p) => p.enabled && p.models?.[tier]) ?? providers.find((p) => p.models?.[tier]);
    if (!provider) continue;
    const model = provider.models[tier];
    if (!model) continue;
    rows.push({
      tier,
      model,
      provider: provider.label,
      providerKind: provider.kind,
      roles: counts[tier],
    });
  }

  return rows;
}
