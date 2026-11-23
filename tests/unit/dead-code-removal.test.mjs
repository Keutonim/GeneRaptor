/**
 * Regression test for H-07 (hardening): the dead code removed in this round
 * must not come back, and the modules it was cut out of must still behave.
 *
 * What was removed (each symbol had ZERO references anywhere in the app —
 * the zero-reference proof was taken before the cut):
 *   - server/lib/fields.mjs            (whole file: SPECIALIST_FIELDS, SERVICE_FIELDS)
 *   - server/lib/errors.mjs             (badRequest)
 *   - server/lib/strip-citations.mjs    (hasCitations, HAS_CITATION_PATTERN)
 *   - server/lib/api-key-probe.mjs      (PROBE_LEVELS)
 *   - server/lib/cover-service.mjs      (COVER_FAIL_CODES)
 *   - server/lib/agent-role-overrides.mjs (deleteAgentRoleOverride)
 *
 * The test has two halves:
 *   1. guard   — the removed names/file are absent from the source tree and
 *                from the modules' public surface;
 *   2. behavior — the touched modules still do their job (a test that passes
 *                even when a module returns nothing would be worthless).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import * as errorsModule from '../../server/lib/errors.mjs';
import * as stripCitationsModule from '../../server/lib/strip-citations.mjs';
import * as apiKeyProbeModule from '../../server/lib/api-key-probe.mjs';
import * as coverServiceModule from '../../server/lib/cover-service.mjs';
import * as agentRoleOverridesModule from '../../server/lib/agent-role-overrides.mjs';

import { ValidationError } from '../../server/lib/validation.mjs';
import { stripCitations } from '../../server/lib/strip-citations.mjs';
import { applyAgentRoleOverride, resetAgentRoleOverrideCache, setAgentRoleOverride } from '../../server/lib/agent-role-overrides.mjs';
import { probeRouterAiKey } from '../../server/lib/api-key-probe.mjs';
import { agentRoleMap } from '../../server/agent-role-data.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Names that must not exist anywhere in the app source any more. */
const REMOVED_NAMES = [
  'badRequest',
  'hasCitations',
  'HAS_CITATION_PATTERN',
  'PROBE_LEVELS',
  'COVER_FAIL_CODES',
  'deleteAgentRoleOverride',
  'SPECIALIST_FIELDS',
  'SERVICE_FIELDS',
];

/** Directories that are scanned for the removed names. */
const SCAN_DIRS = ['server', 'src', 'scripts', 'tests'];
const SKIP_FILES = new Set([
  'tests/unit/dead-code-removal.test.mjs', // the guard itself mentions the names
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(mjs|js|ts|tsx|jsx)$/.test(entry)) {
      yield full;
    }
  }
}

describe('H-07 — удалённый мёртвый код не возвращается', () => {
  it('server/lib/fields.mjs удалён, и на Specialist/Service больше нет моделей в схеме', () => {
    expect(existsSync(join(ROOT, 'server/lib/fields.mjs'))).toBe(false);

    // Мёртвый файл описывал select-карты для моделей Specialist/Service,
    // которых в Prisma-схеме нет (дерево вырезано) — значит и карты не нужны.
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(/^model\s+Specialist\b/m.test(schema)).toBe(false);
    expect(/^model\s+Service\b/m.test(schema)).toBe(false);
  });

  it('ни один файл приложения не упоминает удалённые имена', () => {
    const offenders = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split(sep).join('/');
        if (SKIP_FILES.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const name of REMOVED_NAMES) {
          if (text.includes(name)) offenders.push(`${rel}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('удалённые символы не входят в публичную поверхность модулей', () => {
    expect('badRequest' in errorsModule).toBe(false);
    expect('hasCitations' in stripCitationsModule).toBe(false);
    expect('PROBE_LEVELS' in apiKeyProbeModule).toBe(false);
    expect('COVER_FAIL_CODES' in coverServiceModule).toBe(false);
    expect('deleteAgentRoleOverride' in agentRoleOverridesModule).toBe(false);
  });
});

describe('H-07 — очищенные модули продолжают работать', () => {
  it('errors.mjs: ValidationError жив, статусы 400/404 на месте', () => {
    const invalid = new ValidationError('плохой ввод');
    expect(invalid).toBeInstanceOf(Error);
    expect(invalid.status).toBe(400);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.name).toBe('ValidationError');

    const missing = errorsModule.notFound('нет такого');
    expect(missing.status).toBe(404);
    expect(missing.message).toBe('нет такого');
  });

  it('strip-citations.mjs: маркеры {{src:...}} по-прежнему снимаются', () => {
    const markdown = 'Тезис один{{src:3}}. Тезис два {{src:card}}.';
    const cleaned = stripCitations(markdown);

    expect(cleaned).not.toContain('{{src:');
    expect(cleaned).toBe('Тезис один. Тезис два.');
    // Не-строки и пустая строка не должны ронять функцию.
    expect(stripCitations('')).toBe('');
    expect(stripCitations(null)).toBeNull();
  });

  it('agent-role-overrides.mjs: кэш правок роли жив (set → apply)', () => {
    resetAgentRoleOverrideCache();
    const role = agentRoleMap.get('article-author');
    expect(role).toBeTruthy();

    const override = 'СВОЙ ПРОМПТ РОЛИ АВТОРА. '.repeat(12);
    setAgentRoleOverride('article-author', override);

    const applied = applyAgentRoleOverride(role);
    expect(applied.systemPrompt).toBe(override);
    expect(role.systemPrompt).not.toBe(override); // исходная роль не мутируется
    resetAgentRoleOverrideCache();
  });

  it('api-key-probe.mjs: уровни пробы живы (ok при 200, error при 401)', async () => {
    const okFetch = async () => ({ ok: true, status: 200, text: async () => '' });
    const ok = await probeRouterAiKey('sk-test', { fetchImpl: okFetch });
    expect(ok.level).toBe('ok');
    expect(ok.ok).toBe(true);

    const rejectedFetch = async () => ({ ok: false, status: 401, text: async () => 'nope' });
    const rejected = await probeRouterAiKey('sk-test', { fetchImpl: rejectedFetch });
    expect(rejected.level).toBe('error');
    expect(rejected.ok).toBe(false);
  });

  it('cover-service.mjs: skip-коды на месте, а модуль по-прежнему экспортирует фазу обложки', () => {
    expect(coverServiceModule.COVER_SKIP_CODES).toContain('cover_budget_exceeded');
    expect(coverServiceModule.COVER_SKIP_CODES).toContain('cover_disabled');
    expect(typeof coverServiceModule.maybeGenerateCover).toBe('function');
    expect(typeof coverServiceModule.resolveCoverAvailability).toBe('function');
  });
});
