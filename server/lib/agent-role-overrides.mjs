/**
 * Кэш пользовательских правок systemPrompt агентских ролей.
 *
 * Источник правды — БД (таблица agent_role_settings, по строке на роль).
 * В рантайме генерации нужен СИНХРОННЫЙ доступ, поэтому промпты держатся в
 * памяти: Map<roleId, {systemPrompt, updatedAt}>.
 *
 * Правила:
 *   - loadAgentRoleOverrides() читает БД целиком и пересобирает кэш;
 *   - applyAgentRoleOverride(role) СИНХРОННО подменяет systemPrompt и НЕ
 *     мутирует исходный объект роли (возвращает копию);
 *   - если БД недоступна / таблицы нет → ПРЕДЫДУЩИЙ кэш сохраняется
 *     (last-known-good), поведение = каталог (server/agent-role-data.mjs),
 *     никаких падений.
 *
 * Текст промптов в логи НЕ пишется — только количество записей.
 */

/** Кэш правок: roleId → { systemPrompt, updatedAt }. */
const overridesCache = new Map();

/**
 * Ленивая ссылка на Prisma: модуль не тянет соединение с БД при импорте,
 * поэтому юнит-тесты кэша работают вообще без базы.
 */
let prismaPromise = null;

async function getPrisma() {
  if (!prismaPromise) {
    prismaPromise = import('../db.mjs').then((mod) => mod.prisma);
  }
  return prismaPromise;
}

/**
 * Положить правку промпта в кэш (используется роутом после upsert и тестами).
 *
 * @param {string} roleId
 * @param {string} systemPrompt
 * @param {Date} [updatedAt]
 * @returns {{systemPrompt: string, updatedAt: Date} | null}
 */
export function setAgentRoleOverride(roleId, systemPrompt, updatedAt = new Date()) {
  if (typeof roleId !== 'string' || !roleId) return null;
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return null;
  const entry = { systemPrompt, updatedAt };
  overridesCache.set(roleId, entry);
  return entry;
}

/**
 * Синхронная выборка правки роли.
 *
 * @param {string} roleId
 * @returns {{systemPrompt: string, updatedAt: Date} | null}
 */
export function getAgentRoleOverride(roleId) {
  if (typeof roleId !== 'string' || !roleId) return null;
  return overridesCache.get(roleId) || null;
}

/**
 * Подставить пользовательский промпт в роль.
 *
 * СИНХРОННАЯ функция — рантайм генерации (buildRoleExecutionMessages) остаётся
 * синхронным. Исходный объект роли НЕ мутируется: при наличии правки
 * возвращается копия с подменённым systemPrompt.
 *
 * @param {object} role
 * @returns {object} роль с эффективным systemPrompt
 */
export function applyAgentRoleOverride(role) {
  if (!role || typeof role !== 'object') return role;
  const override = getAgentRoleOverride(role.id);
  if (!override) return role;
  if (typeof override.systemPrompt !== 'string' || !override.systemPrompt.trim()) return role;
  return { ...role, systemPrompt: override.systemPrompt };
}

/**
 * Перечитать правки из БД и пересобрать кэш.
 *
 * Ошибка БД (нет соединения, нет таблицы) НЕ роняет вызывающий код и НЕ
 * стирает уже загруженные правки: сохраняется last-known-good кэш
 * (TL P2-1). Если кэш был пуст — поведение каталожное, как и раньше.
 *
 * @returns {Promise<Map<string, {systemPrompt: string, updatedAt: Date}>>}
 */
export async function loadAgentRoleOverrides() {
  try {
    const prisma = await getPrisma();
    const rows = await prisma.agentRoleSetting.findMany({
      select: { roleId: true, systemPrompt: true, updatedAt: true },
    });
    overridesCache.clear();
    rows.forEach((row) => {
      if (!row || typeof row.roleId !== 'string' || !row.roleId) return;
      if (typeof row.systemPrompt !== 'string' || !row.systemPrompt.trim()) return;
      overridesCache.set(row.roleId, { systemPrompt: row.systemPrompt, updatedAt: row.updatedAt });
    });
    console.log(`[AgentRoles] Загружено правок промптов: ${overridesCache.size}`);
    return overridesCache;
  } catch (err) {
    // БД недоступна или таблицы нет → ПРЕЖНИЙ кэш сохраняем (last-known-good):
    // кратковременная недоступность БД не должна молча откатывать промпты,
    // которые уже применяются в текущем процессе. Если кэш был пуст —
    // поведение каталожное, без падений.
    console.warn(
      '[AgentRoles] Не удалось загрузить правки промптов, сохраняем прежний кэш:',
      err?.message ?? String(err)
    );
    return overridesCache;
  }
}

/** Очистить кэш (тесты). */
export function resetAgentRoleOverrideCache() {
  overridesCache.clear();
}
