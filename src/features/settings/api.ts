/**
 * M6 — API-слой раздела настроек.
 *
 * Сервер — источник правды (PROBE-1): ключи, модели и промпты ролей
 * хранятся на сервере, локальное хранилище используется только как кэш.
 * Ответы сервера приходят в конверте `{ success: true, data: … }`,
 * поэтому `unwrap` снимает конверт и возвращает сами данные.
 */
import { apiDelete, apiGet, apiPost, apiPut } from '../../hooks/useApi';
import type { ProviderCard, ProviderModels } from './helpers/models';
import type { SearchBackendInfo } from './helpers/searchSources';

export interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
}

/** Снять конверт `{ success, data }`; без конверта вернуть как есть. */
export function unwrap<T>(raw: unknown): T | undefined {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    return (raw as ApiEnvelope<T>).data;
  }
  return raw as T | undefined;
}

export interface ServerRole {
  id: string;
  nameRu: string;
  systemPrompt: string;
  source: 'catalog' | 'override';
  updatedAt: string | null;
}

export interface ProbeResult {
  provider?: string;
  ok?: boolean;
  level?: 'ok' | 'warning' | 'error';
  message?: string;
  latencyMs?: number;
  checkedAt?: string;
  cooldown?: number;
}

export async function fetchProviders(): Promise<ProviderCard[]> {
  const raw = await apiGet<ApiEnvelope<{ providers?: ProviderCard[] }>>('/api/settings/providers');
  const data = unwrap<{ providers?: ProviderCard[] }>(raw);
  return data?.providers ?? [];
}

export async function fetchProviderModels(kind: string): Promise<string[]> {
  const raw = await apiGet<unknown>(`/api/providers/${kind}/models`);
  const data = unwrap<{ models?: string[] } | string[]>(raw);
  if (Array.isArray(data)) return data;
  return data?.models ?? [];
}

export async function probeProvider(kind: string): Promise<ProbeResult> {
  const raw = await apiPost<ApiEnvelope<ProbeResult>>(`/api/settings/providers/${kind}/test`, {});
  return unwrap<ProbeResult>(raw) ?? {};
}

export async function saveProvider(
  kind: string,
  payload: { apiKey?: string; baseUrl?: string; enabled?: boolean; models?: ProviderModels },
): Promise<void> {
  await apiPut(`/api/settings/providers/${kind}`, payload);
}

export async function fetchRoles(): Promise<ServerRole[]> {
  const raw = await apiGet<ApiEnvelope<{ roles?: ServerRole[] }>>('/api/settings/agent-roles');
  const data = unwrap<{ roles?: ServerRole[] }>(raw);
  return data?.roles ?? [];
}

/**
 * The effective cover settings (GET /api/settings/cover — defaults
 * with configured:false when no row exists, never 404). cover_settings.model
 * is the single applied cover model; the Models table derives its cover row
 * from this payload.
 */
export interface CoverSettingsPayload {
  model?: string;
  configured?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export async function fetchCoverSettings(): Promise<CoverSettingsPayload> {
  const raw = await apiGet<ApiEnvelope<CoverSettingsPayload>>('/api/settings/cover');
  return unwrap<CoverSettingsPayload>(raw) ?? {};
}

export async function saveRolePrompt(roleId: string, systemPrompt: string): Promise<void> {
  await apiPut('/api/settings/agent-roles', { roleId, systemPrompt });
}

export async function resetRole(roleId: string): Promise<void> {
  await apiDelete(`/api/settings/agent-roles/${roleId}`);
}

/**
 * Поисковые источники — доступ к API веб-поиска:
 * GET /api/search/backends, POST /api/search/probe, POST /api/search/search.
 * Ответы приходят в конверте `{ success, data }` — его снимает `unwrap`.
 */
export interface SearchBackendsPayload {
  backends?: SearchBackendInfo[];
  selected?: string | null;
  defaultBackend?: string | null;
  lang?: string | null;
  warning?: string | null;
}

export interface SearchProbePayload {
  backend?: string;
  ok?: boolean;
  level?: 'ok' | 'warning' | 'error';
  message?: string;
  latencyMs?: number;
}

export interface SearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface SearchOutcomePayload {
  results?: SearchResultItem[];
  backend?: string | null;
  degraded?: boolean;
  reason?: string | null;
  lang?: string | null;
  limit?: number;
  attempts?: { backend?: string; ok?: boolean; code?: string | null; count?: number }[];
}

/** Список доступных поисковых источников (web-search API). */
export async function fetchSearchBackends(): Promise<SearchBackendsPayload> {
  const raw = await apiGet<ApiEnvelope<SearchBackendsPayload>>('/api/search/backends');
  return unwrap<SearchBackendsPayload>(raw) ?? {};
}

/** Проверка ключа платного источника (tavily / serper / yandex). */
export async function probeSearchBackend(backend: string): Promise<SearchProbePayload> {
  const raw = await apiPost<ApiEnvelope<SearchProbePayload>>('/api/search/probe', { backend });
  return unwrap<SearchProbePayload>(raw) ?? {};
}

/** Тестовый поиск: выбор источника уходит полем `backend`. */
export async function searchWeb(params: {
  query: string;
  backend?: string;
  limit?: number;
  lang?: string;
}): Promise<SearchOutcomePayload> {
  const raw = await apiPost<ApiEnvelope<SearchOutcomePayload>>('/api/search/search', {
    query: params.query,
    backend: params.backend,
    limit: params.limit ?? 3,
    lang: params.lang,
  });
  return unwrap<SearchOutcomePayload>(raw) ?? {};
}
