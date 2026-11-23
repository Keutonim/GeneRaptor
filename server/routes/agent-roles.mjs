/**
 * API ролей агентов (settings-audit).
 *
 *   GET    /api/settings/agent-roles      → 11 ролей каталога + эффективный systemPrompt
 *   PUT    /api/settings/agent-roles      → сохранить правку промпта (upsert)
 *   DELETE /api/settings/agent-roles/:id  → сброс к каталогу (идемпотентно;
 *                                           неизвестная роль → 404)
 *
 * Правки владельца лежат в таблице agent_role_settings (по строке на роль);
 * рантайм генерации читает их через server/lib/agent-role-overrides.mjs.
 * Текст промпта в логи НЕ пишется — только roleId и длина.
 */
import { Router } from 'express';

import { agentRoleData, agentRoleMap } from '../agent-role-data.mjs';
import { prisma } from '../db.mjs';
import { loadAgentRoleOverrides } from '../lib/agent-role-overrides.mjs';

const router = Router();

/** Границы длины systemPrompt (после trim). */
const MIN_PROMPT_LENGTH = 200;
const MAX_PROMPT_LENGTH = 10000;

/**
 * Грубая, но обязательная гигиена: в промпт не должны попадать API-ключи
 * (текст уходит в LLM). Проверяем типовые префиксы sk-… и AQVN….
 */
const API_KEY_PATTERNS = [
  /(?:^|[^\w-])sk-[A-Za-z0-9_-]{16,}/,
  /(?:^|[^\w-])AQVN[A-Za-z0-9_-]{16,}/,
];

function success(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, message, status = 400) {
  return res.status(status).json({ success: false, error: message });
}

function looksLikeApiKey(text) {
  return API_KEY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * GET /api/settings/agent-roles
 *
 * Все 11 ролей каталога в порядке server/agent-role-data.mjs. systemPrompt —
 * эффективный (override ?? каталог), weight — позиция роли в цепочке
 * генерации (1..11), всегда из каталога. Если БД недоступна → каталог и HTTP 200
 * (не 500): редактор должен работать «на каталоге».
 */
router.get('/', async (req, res) => {
  // Кэш перечитывается из БД на каждый GET: сервер — источник правды.
  const overrides = await loadAgentRoleOverrides();

  const roles = agentRoleData.map((role) => {
    const override = overrides.get(role.id);
    const updatedAt = override?.updatedAt ? new Date(override.updatedAt).toISOString() : null;
    return {
      id: role.id,
      nameRu: role.nameRu,
      // Chain weight = 1-based position of the role in the 11-step chain.
      // Lives in the catalogue only (server/agent-role-data.mjs) — an
      // override may change the prompt, never the chain position.
      weight: role.weight,
      systemPrompt: override ? override.systemPrompt : role.systemPrompt,
      source: override ? 'override' : 'catalog',
      updatedAt,
    };
  });

  return success(res, { roles });
});

/**
 * PUT /api/settings/agent-roles
 *
 * body: { roleId, systemPrompt }
 */
router.put('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : '';
  if (!roleId || !agentRoleMap.has(roleId)) {
    return fail(res, 'Неизвестная роль агента');
  }

  if (typeof body.systemPrompt !== 'string') {
    return fail(res, 'Промпт должен быть строкой');
  }

  const systemPrompt = body.systemPrompt.trim();
  if (systemPrompt.length < MIN_PROMPT_LENGTH) {
    return fail(res, `Промпт слишком короткий (минимум ${MIN_PROMPT_LENGTH} символов)`);
  }
  if (systemPrompt.length > MAX_PROMPT_LENGTH) {
    return fail(res, `Промпт слишком длинный (максимум ${MAX_PROMPT_LENGTH} символов)`);
  }
  if (looksLikeApiKey(systemPrompt)) {
    return fail(res, 'Промпт не должен содержать API-ключи');
  }

  try {
    const row = await prisma.agentRoleSetting.upsert({
      where: { roleId },
      create: { roleId, systemPrompt },
      update: { systemPrompt },
      select: { roleId: true, systemPrompt: true, updatedAt: true },
    });

    // Кэш рантайма перечитывается сразу — правка доходит до генерации.
    await loadAgentRoleOverrides();

    console.log(
      `[AgentRoles] Промпт сохранён: roleId=${roleId}, длина=${systemPrompt.length}`
    );

    return success(res, {
      roleId: row.roleId,
      systemPrompt: row.systemPrompt,
      source: 'override',
      updatedAt: new Date(row.updatedAt).toISOString(),
    });
  } catch (err) {
    // Логируем только текст ошибки (без тела запроса) — текст промпта в лог не попадает.
    console.error('[AgentRoles] Ошибка сохранения промпта:', err?.message ?? String(err));
    return fail(res, 'Не удалось сохранить промпт', 500);
  }
});

/**
 * DELETE /api/settings/agent-roles/:roleId
 *
 * Сброс к каталогу: строка override удаляется, кэш перечитывается.
 * Идемпотентно — если строки не было, ответ всё равно 200.
 * Неизвестный roleId → 404 «Неизвестная роль агента» (D4): иначе опечатка
 * в URL выглядела бы как успешный сброс.
 */
router.delete('/:roleId', async (req, res) => {
  const roleId = typeof req.params?.roleId === 'string' ? req.params.roleId.trim() : '';

  if (!roleId || !agentRoleMap.has(roleId)) {
    return fail(res, 'Неизвестная роль агента', 404);
  }

  try {
    await prisma.agentRoleSetting.deleteMany({ where: { roleId } });
    await loadAgentRoleOverrides();

    console.log(`[AgentRoles] Промпт сброшен к каталогу: roleId=${roleId}`);

    return success(res, { roleId, source: 'catalog' });
  } catch (err) {
    console.error('[AgentRoles] Ошибка сброса промпта:', err?.message ?? String(err));
    return fail(res, 'Не удалось сбросить промпт', 500);
  }
});

export default router;
