/**
 * Catalog-mirror equality (R4;
 * GeneRaptor role catalog: 13 -> 11 roles).
 *
 * The runtime catalog (server/agent-role-data.mjs) and the frontend mirror
 * (src/data/agentRoles.ts) must carry the SAME systemPrompt for all 11
 * roles — the mirror is what the owner sees in «Настройки → Роли агентов»,
 * the runtime is what the runner actually sends. Roles 12-13
 * (platform-adapter, publisher) are STRIPPED — publishing is out of scope,
 * the chain ends at humanizer; tiers critical 4 / generation 5 / standard 2.
 *
 * Also guards the shape of the v2 structured prompts:
 *   - the 7 rewritten roles carry the six labelled blocks in a fixed order;
 *   - the 4 audited roles keep their rich prompts (pinned substrings);
 *   - the pinned bans still hold (no «FAQ» token in semantic-strategist /
 *     seo-reviewer).
 *
 * Idiom: DOM-free unit test over the real modules (vitest transforms the src
 * TS via vite — same style as tests/unit/cover-checkbox-ui.test.mjs).
 */
import { describe, it, expect } from 'vitest';
import { agentRoleData } from '../../server/agent-role-data.mjs';
import { agentRoles } from '../../src/data/agentRoles';

const ROLE_IDS = [
  'topic-selector',
  'brief-preparer',
  'knowledge-base-curator',
  'research-analyst',
  'semantic-strategist',
  'structure-architect',
  'article-author',
  'factchecker',
  'seo-reviewer',
  'quality-controller',
  'humanizer',
];

/** The roles rewritten into structured branches (v2, audited=true; minus the two stripped). */
const REWRITTEN = [
  'topic-selector',
  'brief-preparer',
  'knowledge-base-curator',
  'research-analyst',
  'semantic-strategist',
  'seo-reviewer',
  'humanizer',
];

/** The four rich roles audited but left untouched (v2, audited=false). */
const AUDITED_UNCHANGED = ['structure-architect', 'article-author', 'factchecker', 'quality-controller'];

const BLOCKS = [
  'РОЛЬ И УРОВЕНЬ',
  'ЗАДАЧА И КРИТЕРИИ ПРИЁМКИ',
  'ИСХОДНЫЕ ДАННЫЕ И ПРИОРИТЕТ ИСТОЧНИКОВ',
  'ЗАПРЕТЫ',
  'ФОРМАТ ОТВЕТА',
  'ПЕРЕДАЧА',
];

const runtimeById = new Map(agentRoleData.map((role) => [role.id, role]));
const mirrorById = new Map(agentRoles.map((role) => [role.id, role]));

describe('agent-role catalogs: same 11 roles (M2 strip)', () => {
  it('runtime catalog has all 11 roles', () => {
    expect(agentRoleData).toHaveLength(11);
    expect([...runtimeById.keys()].sort()).toEqual([...ROLE_IDS].sort());
  });

  it('frontend mirror has all 11 roles', () => {
    expect(agentRoles).toHaveLength(11);
    expect([...mirrorById.keys()].sort()).toEqual([...ROLE_IDS].sort());
  });

  it('stripped roles are gone (platform-adapter, publisher)', () => {
    expect(runtimeById.has('platform-adapter')).toBe(false);
    expect(runtimeById.has('publisher')).toBe(false);
    expect(mirrorById.has('platform-adapter')).toBe(false);
    expect(mirrorById.has('publisher')).toBe(false);
  });

  it('the chain ends at humanizer (no next roles)', () => {
    const humanizer = runtimeById.get('humanizer');
    expect(humanizer.nextRoleIds).toEqual([]);
  });

  it('tier counts: critical 4 / generation 5 / standard 2', () => {
    const tiers = { critical: 0, generation: 0, standard: 0 };
    for (const role of agentRoleData) tiers[role.modelTier] += 1;
    expect(tiers).toEqual({ critical: 4, generation: 5, standard: 2 });
  });
});

describe('agent-role catalogs: byte-equal systemPrompt (R4)', () => {
  it.each(ROLE_IDS)('%s — mirror === runtime', (id) => {
    const runtime = runtimeById.get(id);
    const mirror = mirrorById.get(id);
    expect(runtime, `runtime role ${id} missing`).toBeTruthy();
    expect(mirror, `mirror role ${id} missing`).toBeTruthy();
    expect(mirror.systemPrompt).toBe(runtime.systemPrompt);
    expect(mirror.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe('v2 structured prompts: six labelled blocks in order', () => {
  it.each(REWRITTEN)('%s — blocks present and ordered', (id) => {
    const prompt = runtimeById.get(id).systemPrompt;
    let cursor = -1;
    for (const block of BLOCKS) {
      const at = prompt.indexOf(block);
      expect(at, `${id}: block «${block}» missing`).toBeGreaterThan(-1);
      expect(at, `${id}: block «${block}» out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it.each(REWRITTEN)('%s — a real instruction body follows the first block', (id) => {
    const prompt = runtimeById.get(id).systemPrompt;
    const firstBlockEnd = prompt.indexOf('\n', prompt.indexOf(BLOCKS[0]));
    const body = prompt.slice(firstBlockEnd + 1, prompt.indexOf(BLOCKS[1])).trim();
    expect(body.length, `${id}: empty «${BLOCKS[0]}» body`).toBeGreaterThan(40);
  });
});

describe('v2 structured prompts: audited roles keep their rich prompts', () => {
  it.each(AUDITED_UNCHANGED)('%s — no structured block headers', (id) => {
    const prompt = runtimeById.get(id).systemPrompt;
    for (const block of BLOCKS) {
      expect(prompt.includes(`\n${block}\n`), `${id}: unexpected block «${block}»`).toBe(false);
    }
  });

  it('article-author keeps the pinned source-marker machinery', () => {
    const prompt = runtimeById.get('article-author').systemPrompt;
    expect(prompt).toContain('{{src:N}}');
    expect(prompt).toContain('sourceMapRu');
    expect(prompt).toContain('{{articleLength}}');
  });

  it('structure-architect keeps the pinned heading/section directives', () => {
    const prompt = runtimeById.get('structure-architect').systemPrompt;
    expect(prompt).toContain('ЧИСЛО СЕКЦИЙ ПОД ОБЪЁМ');
    expect(prompt).toContain('БЛОК ВОЗРАЖЕНИЙ');
  });
});

describe('v2 structured prompts: pinned bans still hold', () => {
  it('semantic-strategist never names the FAQ token (pinned ban)', () => {
    expect(runtimeById.get('semantic-strategist').systemPrompt).not.toMatch(/faq/i);
  });

  it('seo-reviewer never names the FAQ token (pinned ban)', () => {
    expect(runtimeById.get('seo-reviewer').systemPrompt).not.toMatch(/faq/i);
  });

  it('topic-selector keeps the frozen revenue-ranking directive verbatim', () => {
    const prompt = runtimeById.get('topic-selector').systemPrompt;
    expect(prompt).toContain('REVENUE-РАНЖИРОВАНИЕ');
    expect(prompt).toContain('РЕАЛЬНЫХ услуг компании');
  });

  it('brief-preparer keeps the frozen tone directive verbatim', () => {
    const prompt = runtimeById.get('brief-preparer').systemPrompt;
    expect(prompt).toContain('ТОНАЛЬНОСТЬ ПО УМОЛЧАНИЮ');
  });
});
