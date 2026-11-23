/**
 * Блок «Поисковые источники» — чистые помощники UI.
 *
 * Логика выбора поискового бэкенда вынесена из React-компонента, чтобы её
 * можно было покрыть обычными vitest-тестами (в репозитории нет DOM-стенда
 * для компонентов — идиома tests/unit/cover-checkbox-ui.test.mjs).
 *
 * Серверный выбор бэкенда задаётся окружением (GENERAPTOR_SEARCH_BACKEND),
 * поэтому выбор пользователя хранится в браузере и уходит в запрос
 * POST /api/search/search полем `backend`.
 */

/** Ключ localStorage для выбранного поискового источника. */
export const SEARCH_BACKEND_STORAGE_KEY = 'generaptor.searchBackend';

/**
 * Бэкенды, для которых сервер умеет проверять ключ (POST /api/search/probe).
 * Остальные работают без ключа — их проверять нечего.
 */
export const PROBEABLE_BACKENDS = ['tavily', 'serper', 'yandex'] as const;

/** Описание бэкенда из GET /api/search/backends. */
export interface SearchBackendInfo {
  id: string;
  label?: string | null;
  description?: string | null;
  notes?: string | null;
  requiresKey?: boolean;
  configured?: boolean;
  available?: boolean;
  envKey?: string | null;
  official?: boolean;
  unofficial?: boolean;
  optIn?: boolean;
  inAutoChain?: boolean;
  order?: number;
  selected?: boolean;
  /**
   * The narrow domain verticals are a separate tier — keyless, official,
   * consulted only when the topic matches. The server marks them `vertical: true`
   * and lists them in a dedicated `verticals` array of GET /api/search/backends.
   * They are never offered as the main engine in the select.
   */
  vertical?: boolean;
}

/**
 * The eight keyless domain verticals (server: VERTICAL_BACKEND_IDS).
 * Used as a defensive marker when the server omits the `vertical` flag: an id
 * from this list is always treated as a vertical, never as a selectable engine.
 */
export const SEARCH_VERTICAL_IDS = Object.freeze([
  'openalex',
  'crossref',
  'europepmc',
  'gdelt',
  'nominatim',
  'openlibrary',
  'stackexchange',
  'hn',
] as const);

/** Состояние бэкенда для UI. */
export type SearchBackendState = 'ready' | 'needsKey' | 'unavailable';

/** Тон сообщения (совпадает с классами .error-text / .caption). */
export type SearchMessageTone = 'ok' | 'warning' | 'error';

/** Ключ i18n для названия бэкенда: серверные подписи только по-русски. */
export function backendLabelKey(id: string): string {
  return `searchSources.backend.${id}`;
}

/**
 * Ключ i18n для атрибуции источника результата (per-item `provider`).
 * Строится из id так же, как название бэкенда, — словарь покрывает и основные
 * движки, и вертикали. Для пустого id возвращает null (атрибуция не показывается).
 * Разрешимость ключа в словарь проверяет UI: сырой id не показывается как текст.
 */
export function providerLabelKey(provider: string | null | undefined): string | null {
  if (typeof provider !== 'string') return null;
  const id = provider.trim();
  if (!id) return null;
  return backendLabelKey(id);
}

/**
 * Извлечь id источника из элемента результата. Сервер добавляет необязательное
 * поле `provider` (id бэкенда-источника, D42); тип SearchResultItem в api.ts его не
 * объявляет, поэтому чтение структурное. Пустое/отсутствующее значение → null.
 */
export function resultProviderId(item: { provider?: string | null } | null | undefined): string | null {
  const provider = item?.provider;
  if (typeof provider !== 'string') return null;
  const id = provider.trim();
  return id ? id : null;
}

/** Состояние бэкенда: нужен ключ / отключён сервером / готов к работе. */
export function backendState(backend: SearchBackendInfo): SearchBackendState {
  if (backend.requiresKey && !backend.configured) return 'needsKey';
  if (backend.available === false) return 'unavailable';
  return 'ready';
}

/** Можно ли проверить ключ этого бэкенда (сервер умеет только три). */
export function isProbeable(id: string): boolean {
  return (PROBEABLE_BACKENDS as readonly string[]).includes(id);
}

/**
 * Является ли бэкенд узкой доменной вертикалью. Вертикаль keyless и official,
 * вызывается автоматически по совпадению темы и не предлагается как основной движок.
 * Узнаётся по серверному флагу `vertical: true`, а также по известному id (защита,
 * если флаг не проставлен).
 */
export function isVerticalBackend(backend: SearchBackendInfo): boolean {
  if (backend.vertical === true) return true;
  return (SEARCH_VERTICAL_IDS as readonly string[]).includes(backend.id);
}

/**
 * Бэкенды, допустимые как основной движок в селекте, — все, кроме вертикалей.
 * Порядок сервера сохраняется.
 */
export function selectableBackends(backends: SearchBackendInfo[]): SearchBackendInfo[] {
  return backends.filter((backend) => !isVerticalBackend(backend));
}

/**
 * Собрать список вертикалей для отображения. Основной источник — отдельный
 * массив `verticals` из GET /api/search/backends; дополнительно подхватываются
 * вертикали, помеченные внутри `backends` (защита от иного формата слияния).
 * Дедупликация по id, порядок: сначала серверный массив, затем inline-вертикали.
 */
export function collectVerticals(
  backends: SearchBackendInfo[],
  verticals?: SearchBackendInfo[] | null,
): SearchBackendInfo[] {
  const out: SearchBackendInfo[] = [];
  const seen = new Set<string>();
  for (const vertical of verticals ?? []) {
    if (!seen.has(vertical.id)) {
      seen.add(vertical.id);
      out.push(vertical);
    }
  }
  for (const backend of backends) {
    if (isVerticalBackend(backend) && !seen.has(backend.id)) {
      seen.add(backend.id);
      out.push(backend);
    }
  }
  return out;
}

/** Известен ли бэкенд серверу (плюс служебное значение 'auto'). */
export function isKnownBackend(id: string | null | undefined, backends: SearchBackendInfo[]): boolean {
  if (!id) return false;
  if (id === 'auto') return true;
  return backends.some((backend) => backend.id === id);
}

/**
 * Итоговый выбор источника:
 * 1) сохранённый в браузере id (если сервер его ещё знает);
 * 2) серверный выбор по умолчанию (в т.ч. 'auto');
 * 3) 'auto' — цепочка без ключей.
 */
export function resolveSelectedBackend(
  stored: string | null | undefined,
  backends: SearchBackendInfo[],
  serverSelected: string | null | undefined,
): string {
  if (isKnownBackend(stored, backends)) return stored as string;
  if (isKnownBackend(serverSelected, backends)) return serverSelected as string;
  return 'auto';
}

/** i18n-ключ сообщения по итогу тестового поиска. */
export function searchOutcomeKey(reason: string | null | undefined, resultCount: number): string {
  if (resultCount > 0) return 'searchSources.result.ok';
  if (!reason) return 'searchSources.result.emptyResults';
  if (reason === 'empty_results') return 'searchSources.result.emptyResults';
  if (reason === 'not_configured') return 'searchSources.result.notConfigured';
  if (reason === 'empty_query') return 'searchSources.result.emptyQuery';
  if (reason === 'timeout') return 'searchSources.result.timeout';
  if (reason === 'network_unavailable') return 'searchSources.result.network';
  return 'searchSources.result.failed';
}

/** Тон сообщения по итогу тестового поиска. */
export function searchOutcomeTone(reason: string | null | undefined, resultCount: number): SearchMessageTone {
  if (resultCount > 0) return 'ok';
  if (!reason || reason === 'empty_results' || reason === 'not_configured') return 'warning';
  return 'error';
}

/** i18n-ключ сообщения по итогу пробы ключа. */
export function probeOutcomeKey(level: string | null | undefined): string {
  if (level === 'ok') return 'searchSources.probe.ok';
  if (level === 'warning') return 'searchSources.probe.warning';
  return 'searchSources.probe.error';
}

/** Тон сообщения по итогу пробы ключа. */
export function probeOutcomeTone(level: string | null | undefined): SearchMessageTone {
  if (level === 'ok') return 'ok';
  if (level === 'warning') return 'warning';
  return 'error';
}
