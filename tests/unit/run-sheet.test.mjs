/**
 * M6 — pure helper of the generation run sheet (docs/ui-design.md §5, state C).
 *
 * Контракт под тестом: 11 строк = 11 ролей конвейера в порядке цепочки;
 * стадия «текущая» подсвечивается, пройденные — «готово», будущие — «ждёт».
 */
import { describe, it, expect } from 'vitest';
import { buildRunSheet } from '../../src/features/generation/helpers/runSheet';
import { agentRoles } from '../../src/data/agentRoles';

describe('buildRunSheet — лист запуска', () => {
  it('строит 11 строк по 11 ролям конвейера', () => {
    const rows = buildRunSheet(agentRoles, 0);
    expect(rows).toHaveLength(11);
    expect(rows[0].roleId).toBe('topic-selector');
    expect(rows[10].roleId).toBe('humanizer');
    expect(rows[0].index).toBe(1);
  });

  it('отмечает пройденные стадии как готовые, текущую — как текущую', () => {
    const rows = buildRunSheet(agentRoles, 3);
    expect(rows[0].state).toBe('done');
    expect(rows[1].state).toBe('done');
    expect(rows[2].state).toBe('current');
    expect(rows[3].state).toBe('pending');
  });

  it('до старта все стадии ждут, после финиша все готовы', () => {
    expect(buildRunSheet(agentRoles, 0).every((r) => r.state === 'pending')).toBe(true);
    expect(buildRunSheet(agentRoles, 11).every((r) => r.state === 'done')).toBe(true);
  });

  it('не теряет уровень модели роли (tier) — он нужен в подписи', () => {
    const rows = buildRunSheet(agentRoles, 1);
    expect(rows[0].tier).toBe('generation');
    expect(rows[3].tier).toBe('critical');
  });

  it('пустой список ролей не роняет функцию', () => {
    expect(buildRunSheet([], 2)).toEqual([]);
  });
});
