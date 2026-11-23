/**
 * M6 — раздел «Роли» (PROBE-1).
 *
 * Сервер — источник правды: промпт читается GET /api/settings/agent-roles,
 * сохраняется PUT /api/settings/agent-roles, сбрасывается DELETE
 * /api/settings/agent-roles/:roleId. Локальный каталог ролей используется
 * только для уровня (tier) и позиции в цепочке, которых нет в ответе сервера.
 *
 * Если сервер недоступен — показываем промпты каталога и блокируем сохранение.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { agentRoles } from '../../data/agentRoles';
import { useI18n } from '../../i18n';
import { fetchRoles, resetRole, saveRolePrompt, type ServerRole } from './api';

interface RoleRow {
  roleId: string;
  name: string;
  tier: string;
  position: number | null;
  prompt: string;
  source: 'catalog' | 'override';
}

export const RolesSection: React.FC = () => {
  const { t } = useI18n();
  const [roles, setRoles] = useState<ServerRole[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const list = await fetchRoles();
      setRoles(list);
      setLoadError(null);
    } catch (error) {
      setRoles([]);
      setLoadError(error instanceof Error ? error.message : t('errors.load'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo<RoleRow[]>(() => {
    const byId = new Map(roles.map((role) => [role.id, role]));
    if (loadError) {
      // Сервер недоступен — показываем каталог только для чтения.
      return agentRoles.map((role, index) => ({
        roleId: role.id,
        name: role.nameRu,
        tier: role.modelTier,
        position: index + 1,
        prompt: role.systemPrompt,
        source: 'catalog' as const,
      }));
    }
    const known = agentRoles
      .map((role, index): RoleRow | null => {
        const server = byId.get(role.id);
        if (!server) return null;
        return {
          roleId: role.id,
          name: server.nameRu || role.nameRu,
          tier: role.modelTier,
          position: index + 1,
          prompt: server.systemPrompt ?? role.systemPrompt,
          source: server.source,
        };
      })
      .filter((row): row is RoleRow => row !== null);
    const extra = roles
      .filter((role) => !agentRoles.some((catalogueRole) => catalogueRole.id === role.id))
      .map(
        (role): RoleRow => ({
          roleId: role.id,
          name: role.nameRu,
          tier: '—',
          position: null,
          prompt: role.systemPrompt,
          source: role.source,
        }),
      );
    return [...known, ...extra];
  }, [roles, loadError]);

  const startEdit = (row: RoleRow) => {
    setEditing(row.roleId);
    setDraft(row.prompt);
  };

  const save = async (row: RoleRow) => {
    setBusy(row.roleId);
    try {
      await saveRolePrompt(row.roleId, draft);
      setRoles((prev) =>
        prev.map((role) =>
          role.id === row.roleId
            ? { ...role, systemPrompt: draft, source: 'override' as const }
            : role,
        ),
      );
      setEditing(null);
      setNotice((prev) => ({ ...prev, [row.roleId]: t('roles.saved') }));
    } catch (error) {
      setNotice((prev) => ({
        ...prev,
        [row.roleId]: error instanceof Error ? error.message : t('errors.generic'),
      }));
    } finally {
      setBusy(null);
    }
  };

  const reset = async (row: RoleRow) => {
    setBusy(row.roleId);
    try {
      await resetRole(row.roleId);
      const cataloguePrompt = agentRoles.find((role) => role.id === row.roleId)?.systemPrompt ?? '';
      setRoles((prev) =>
        prev.map((role) =>
          role.id === row.roleId
            ? { ...role, systemPrompt: cataloguePrompt, source: 'catalog' as const }
            : role,
        ),
      );
      setEditing(null);
      setNotice((prev) => ({ ...prev, [row.roleId]: t('roles.reset') }));
    } catch (error) {
      setNotice((prev) => ({
        ...prev,
        [row.roleId]: error instanceof Error ? error.message : t('errors.generic'),
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      {loadError ? <p className="error-text">{t('roles.serverUnavailable')}</p> : null}

      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('roles.name')}</th>
            <th scope="col">{t('roles.level')}</th>
            <th scope="col">{t('roles.weight')}</th>
            <th scope="col">{t('roles.prompt')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isEditing = editing === row.roleId;
            return (
              <tr key={row.roleId}>
                <td>{row.name}</td>
                <td>
                  <span className="meta">{row.tier}</span>
                </td>
                <td className="meta">{row.position ?? '—'}</td>
                <td>
                  {isEditing ? (
                    <div className="stack">
                      <textarea
                        className="textarea"
                        aria-label={`${t('roles.prompt')} · ${row.name}`}
                        value={draft}
                        maxLength={10000}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <div className="button-row">
                        <button
                          type="button"
                          className="button button--primary"
                          disabled={busy === row.roleId || !draft.trim()}
                          onClick={() => void save(row)}
                        >
                          {t('roles.prompt.save')}
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setEditing(null)}
                        >
                          {t('article.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="stack">
                      <span className="prompt-preview">{row.prompt}</span>
                      <div className="button-row">
                        {loadError ? (
                          // Сервер недоступен — сохранить нельзя, но действие должно быть видно.
                          <button type="button" className="button" disabled>
                            {t('roles.prompt.save')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="button"
                            onClick={() => startEdit(row)}
                          >
                            {t('roles.prompt.edit')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="button"
                          disabled={busy === row.roleId || Boolean(loadError)}
                          onClick={() => void reset(row)}
                        >
                          {t('roles.prompt.reset')}
                        </button>
                      </div>
                    </div>
                  )}
                  {notice[row.roleId] ? <span className="caption">{notice[row.roleId]}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
