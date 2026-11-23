/**
 * Unit tests: путь промпта агентской роли с учётом пользовательских правок.
 *
 * Смоук на уровне buildRoleExecutionMessages (server/agent-role-execution.mjs):
 *   - без override системное сообщение БАЙТ-В-БАЙТ равно каталожному промпту;
 *   - с override системное сообщение содержит текст правки владельца;
 *   - подстановка {{articleLength}} работает и для override-текста.
 *
 * Тест НЕ ходит в БД: кэш заполняется через setAgentRoleOverride().
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { agentRoleMap } from '../../server/agent-role-data.mjs';
import { buildRoleExecutionMessages } from '../../server/agent-role-execution.mjs';
import {
  resetAgentRoleOverrideCache,
  setAgentRoleOverride,
} from '../../server/lib/agent-role-overrides.mjs';

const ROLE_ID = 'article-author';

function systemMessageFor(roleId, params = {}) {
  const messages = buildRoleExecutionMessages({ roleId, ...params });
  const system = messages.find((m) => m?.role === 'system');
  expect(system).toBeTruthy();
  return system.content;
}

describe('путь промпта роли — пользовательские правки (override)', () => {
  beforeEach(() => {
    resetAgentRoleOverrideCache();
  });

  it('без override системный промпт побайтово равен каталожному', () => {
    const catalogPrompt = agentRoleMap.get(ROLE_ID).systemPrompt;

    const system = systemMessageFor(ROLE_ID);

    expect(system).toBe(catalogPrompt);
    expect(system.length).toBe(catalogPrompt.length);
  });

  it('с override системный промпт = тексту правки', () => {
    const catalogPrompt = agentRoleMap.get(ROLE_ID).systemPrompt;
    const overrideText = 'СВОЙ ПРОМПТ ВЛАДЕЛЬЦА ДЛЯ АВТОРА. '.repeat(12);

    setAgentRoleOverride(ROLE_ID, overrideText);

    const system = systemMessageFor(ROLE_ID);

    // Рантайм нормализует промпт через asNonEmptyString (trim) — сравниваем
    // с тем же значением, которое реально уходит в LLM.
    expect(system).toBe(overrideText.trim());
    expect(system).not.toBe(catalogPrompt);
    expect(system).not.toContain(catalogPrompt.slice(0, 120));
  });

  it('подстановка {{articleLength}} работает и для override-текста', () => {
    const overrideText = `Объём статьи — ровно {{articleLength}} символов. ${'Подробности роли. '.repeat(20)}`;

    setAgentRoleOverride(ROLE_ID, overrideText);

    const system = systemMessageFor(ROLE_ID, { articleLength: 12345 });

    expect(system).toContain('12345');
    expect(system).not.toContain('{{articleLength}}');
  });

  it('подстановка {{articleLength}} в каталожном промпте не сломана', () => {
    const catalogPrompt = agentRoleMap.get(ROLE_ID).systemPrompt;

    const system = systemMessageFor(ROLE_ID, { articleLength: 12345 });

    expect(system).not.toContain('{{articleLength}}');
    expect(system).toBe(catalogPrompt.split('{{articleLength}}').join('12345'));
  });

  it('override другой роли не влияет на промпт этой роли', () => {
    setAgentRoleOverride('humanizer', 'ПРОМПТ ХЮМАНАЙЗЕРА. '.repeat(20));

    const system = systemMessageFor(ROLE_ID);

    expect(system).toBe(agentRoleMap.get(ROLE_ID).systemPrompt);
  });
});
