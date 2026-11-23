/**
 * M6 — pure helper of the generation run sheet (state C).
 *
 * The run sheet has one row per pipeline role (11 roles, chain order).
 * `currentStage` is the amount of stages the server already reported
 * (GET /api/articles/:id/progress → currentStage, totalStages = 11):
 *   - 0            → nothing started yet, every row waits;
 *   - 1..N         → the stage `currentStage` is running, the ones before it
 *                    are done, the ones after it wait;
 *   - N or more    → the run is finished, every row is done.
 */
import type { AgentRole } from '../../../data/agentRoles';

export type RunSheetState = 'done' | 'current' | 'pending';

export interface RunSheetRow {
  /** Role id from the pipeline catalogue. */
  roleId: string;
  /** Human readable role name (RU in the current catalogue). */
  name: string;
  /** Model tier of the role — shown next to the stage name. */
  tier: AgentRole['modelTier'];
  /** 1-based position of the stage in the run sheet. */
  index: number;
  /** Visual state of the stage. */
  state: RunSheetState;
}

export function buildRunSheet(roles: AgentRole[], currentStage: number): RunSheetRow[] {
  if (!Array.isArray(roles) || roles.length === 0) return [];

  const total = roles.length;
  const stage = Number.isFinite(currentStage) ? Math.trunc(currentStage) : 0;

  return roles.map((role, position) => {
    let state: RunSheetState = 'pending';
    if (stage >= total) {
      state = 'done';
    } else if (stage > 0) {
      if (position < stage - 1) state = 'done';
      else if (position === stage - 1) state = 'current';
    }

    return {
      roleId: role.id,
      name: role.nameRu,
      tier: role.modelTier,
      index: position + 1,
      state,
    };
  });
}
