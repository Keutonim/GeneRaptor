/**
 * The role catalogue owns the chain weight.
 *
 * The 11-role generation chain (M2 stripped 13 -> 11 roles) has an explicit
 * per-role weight: the 1-based position of the role in the chain. The
 * catalogue (server/agent-role-data.mjs) is the ONLY place the value lives,
 * so this unit test locks the invariant "weight === position" — inserting a
 * role without renumbering fails here instead of silently desyncing the
 * settings screen and the progress timeline.
 */
import { describe, expect, it } from 'vitest';

import { agentRoleData } from '../../server/agent-role-data.mjs';

describe('agent role catalogue — chain weight', () => {
  it('every role carries a numeric weight equal to its 1-based chain position', () => {
    expect(agentRoleData).toHaveLength(11);

    agentRoleData.forEach((role, index) => {
      expect(typeof role.weight).toBe('number');
      expect(Number.isInteger(role.weight)).toBe(true);
      expect(role.weight).toBe(index + 1);
    });
  });

  it('weights cover the whole chain 1..11 in catalogue order', () => {
    expect(agentRoleData.map((role) => role.weight)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('the first and the last role of the chain are topic-selector and humanizer', () => {
    expect(agentRoleData[0].id).toBe('topic-selector');
    expect(agentRoleData[0].weight).toBe(1);
    expect(agentRoleData[agentRoleData.length - 1].id).toBe('humanizer');
    expect(agentRoleData[agentRoleData.length - 1].weight).toBe(11);
  });
});
