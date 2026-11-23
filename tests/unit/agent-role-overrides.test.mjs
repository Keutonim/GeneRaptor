/**
 * Unit tests: кэш пользовательских правок systemPrompt агентских ролей.
 *
 * Модуль server/lib/agent-role-overrides.mjs держит правки владельца в памяти
 * (Map<roleId, {systemPrompt, updatedAt}>) и подставляет их в роль по запросу.
 * Тесты НЕ ходят в БД: кэш заполняется сеттером setAgentRoleOverride(),
 * чтение БД (loadAgentRoleOverrides) тут не задействовано.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * БД замокана: loadAgentRoleOverrides() ходит в prisma.agentRoleSetting.
 * Тесты кэша (без БД) от этого не зависят — мок нужен только для кейса
 * «сбой БД не стирает уже загруженные правки» (TL P2-1).
 */
const dbState = vi.hoisted(() => ({ mode: 'fail', rows: [] }));

vi.mock('../../server/db.mjs', () => ({
  prisma: {
    agentRoleSetting: {
      findMany: async () => {
        if (dbState.mode === 'fail') throw new Error('БД недоступна');
        return dbState.rows;
      },
    },
  },
}));

import { agentRoleMap } from '../../server/agent-role-data.mjs';
import {
  applyAgentRoleOverride,
  getAgentRoleOverride,
  loadAgentRoleOverrides,
  resetAgentRoleOverrideCache,
  setAgentRoleOverride,
} from '../../server/lib/agent-role-overrides.mjs';

const ROLE_ID = 'article-author';

describe('agent-role-overrides — applyAgentRoleOverride', () => {
  beforeEach(() => {
    resetAgentRoleOverrideCache();
  });

  it('без override роль возвращается без изменений (systemPrompt каталожный)', () => {
    const role = agentRoleMap.get(ROLE_ID);
    expect(role).toBeTruthy();

    const result = applyAgentRoleOverride(role);

    expect(result.id).toBe(ROLE_ID);
    expect(result.systemPrompt).toBe(role.systemPrompt);
    expect(getAgentRoleOverride(ROLE_ID)).toBeNull();
  });

  it('с override systemPrompt подменяется', () => {
    const role = agentRoleMap.get(ROLE_ID);
    const overrideText = 'СВОЙ ПРОМПТ РОЛИ АВТОРА. '.repeat(12);

    setAgentRoleOverride(ROLE_ID, overrideText);

    const result = applyAgentRoleOverride(role);
    expect(result.systemPrompt).toBe(overrideText);
    expect(result.id).toBe(ROLE_ID);
    // Остальные поля роли не теряются.
    expect(result.nameRu).toBe(role.nameRu);
  });

  it('исходный объект роли НЕ мутирован (override отдаётся копией)', () => {
    const role = agentRoleMap.get(ROLE_ID);
    const originalPrompt = role.systemPrompt;
    const overrideText = 'ДРУГОЙ ПРОМПТ. '.repeat(20);

    setAgentRoleOverride(ROLE_ID, overrideText);
    const result = applyAgentRoleOverride(role);

    expect(result).not.toBe(role);
    expect(role.systemPrompt).toBe(originalPrompt);
    expect(role.systemPrompt).not.toBe(overrideText);
  });

  it('неизвестный roleId → без исключения, роль без изменений', () => {
    const role = { id: 'no-such-role', nameRu: 'Нет такой роли', systemPrompt: 'каталог' };

    expect(() => applyAgentRoleOverride(role)).not.toThrow();

    const result = applyAgentRoleOverride(role);
    expect(result.systemPrompt).toBe('каталог');
    expect(result.id).toBe('no-such-role');
    expect(getAgentRoleOverride('no-such-role')).toBeNull();
  });

  it('resetAgentRoleOverrideCache очищает кэш', () => {
    setAgentRoleOverride(ROLE_ID, 'что-то закешированное');
    expect(getAgentRoleOverride(ROLE_ID)).not.toBeNull();

    resetAgentRoleOverrideCache();

    expect(getAgentRoleOverride(ROLE_ID)).toBeNull();
  });
});

describe('loadAgentRoleOverrides — сбой БД не стирает загруженные правки (TL P2-1)', () => {
  beforeEach(() => {
    resetAgentRoleOverrideCache();
    dbState.mode = 'fail';
    dbState.rows = [];
  });

  it('успешная загрузка → правка в кэше', async () => {
    dbState.mode = 'ok';
    dbState.rows = [{ roleId: ROLE_ID, systemPrompt: 'ЗАГРУЖЕННЫЙ ПРОМПТ', updatedAt: new Date() }];

    await loadAgentRoleOverrides();

    expect(getAgentRoleOverride(ROLE_ID)?.systemPrompt).toBe('ЗАГРУЖЕННЫЙ ПРОМПТ');
  });

  it('сбой БД после успешной загрузки → last-known-good сохранён', async () => {
    dbState.mode = 'ok';
    dbState.rows = [{ roleId: ROLE_ID, systemPrompt: 'ЗАГРУЖЕННЫЙ ПРОМПТ', updatedAt: new Date() }];
    await loadAgentRoleOverrides();
    expect(getAgentRoleOverride(ROLE_ID)?.systemPrompt).toBe('ЗАГРУЖЕННЫЙ ПРОМПТ');

    dbState.mode = 'fail';
    await loadAgentRoleOverrides();

    // Правка НЕ потеряна: кратковременная недоступность БД не должна
    // молча откатывать промпты, уже применяемые в процессе.
    expect(getAgentRoleOverride(ROLE_ID)?.systemPrompt).toBe('ЗАГРУЖЕННЫЙ ПРОМПТ');
    const role = agentRoleMap.get(ROLE_ID);
    expect(applyAgentRoleOverride(role).systemPrompt).toBe('ЗАГРУЖЕННЫЙ ПРОМПТ');
  });

  it('сбой БД при пустом кэше → поведение каталожное, без исключения', async () => {
    dbState.mode = 'fail';

    await expect(loadAgentRoleOverrides()).resolves.toBeDefined();

    expect(getAgentRoleOverride(ROLE_ID)).toBeNull();
    const role = agentRoleMap.get(ROLE_ID);
    expect(applyAgentRoleOverride(role).systemPrompt).toBe(role.systemPrompt);
  });
});
