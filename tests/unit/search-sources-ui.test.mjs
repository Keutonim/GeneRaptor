/**
 * Блок «Поисковые источники»: чистые помощники UI-выбора
 * поискового бэкенда — без DOM (идиома репозитория:
 * tests/unit/cover-checkbox-ui.test.mjs — vitest трансформирует src TS через vite).
 *
 * Контракт под тестом:
 *   - ключ localStorage для выбранного источника стабилен;
 *   - проба ключа доступна только для бэкендов с ключом (tavily/serper/yandex);
 *   - подписи бэкендов приходят из i18n-словаря по id (серверные подписи
 *     только по-русски, поэтому UI использует собственные ключи);
 *   - состояние бэкенда: ready / needsKey / unavailable;
 *   - сохранённый выбор приоритетнее серверного, но не ломается, если
 *     бэкенд исчез из списка;
 *   - итог тестового поиска переводится в i18n-ключ и тон.
 */
import { describe, it, expect } from 'vitest';
import {
  SEARCH_BACKEND_STORAGE_KEY,
  PROBEABLE_BACKENDS,
  SEARCH_VERTICAL_IDS,
  backendLabelKey,
  backendState,
  collectVerticals,
  isProbeable,
  isKnownBackend,
  isVerticalBackend,
  probeOutcomeKey,
  probeOutcomeTone,
  providerLabelKey,
  resolveSelectedBackend,
  resultProviderId,
  searchOutcomeKey,
  searchOutcomeTone,
  selectableBackends,
} from '../../src/features/settings/helpers/searchSources';

const BACKENDS = [
  { id: 'tavily', requiresKey: true, configured: false, available: false },
  { id: 'serper', requiresKey: true, configured: true, available: true },
  { id: 'yandex', requiresKey: true, configured: true, available: true },
  { id: 'tavily-keyless', requiresKey: false, configured: true, available: true },
  { id: 'wikipedia', requiresKey: false, configured: true, available: true },
  { id: 'wikidata', requiresKey: false, configured: true, available: true },
  { id: 'duckduckgo', requiresKey: false, configured: true, available: true },
];

describe('searchSources — storage key and probeable backends', () => {
  it('ключ localStorage стабилен', () => {
    expect(SEARCH_BACKEND_STORAGE_KEY).toBe('generaptor.searchBackend');
  });

  it('проба доступна только для бэкендов с ключом', () => {
    expect([...PROBEABLE_BACKENDS]).toEqual(['tavily', 'serper', 'yandex']);
    expect(isProbeable('tavily')).toBe(true);
    expect(isProbeable('serper')).toBe(true);
    expect(isProbeable('yandex')).toBe(true);
    expect(isProbeable('wikipedia')).toBe(false);
    expect(isProbeable('tavily-keyless')).toBe(false);
    expect(isProbeable('auto')).toBe(false);
  });
});

describe('searchSources — i18n-подписи бэкендов', () => {
  it('ключ подписи строится из id', () => {
    expect(backendLabelKey('tavily')).toBe('searchSources.backend.tavily');
    expect(backendLabelKey('tavily-keyless')).toBe('searchSources.backend.tavily-keyless');
    expect(backendLabelKey('wikipedia')).toBe('searchSources.backend.wikipedia');
    expect(backendLabelKey('auto')).toBe('searchSources.backend.auto');
  });
});

describe('searchSources — состояние бэкенда', () => {
  it('требует ключ, если ключ не задан', () => {
    expect(backendState({ id: 'tavily', requiresKey: true, configured: false })).toBe('needsKey');
  });

  it('недоступен, если бэкенд выключен сервером', () => {
    expect(backendState({ id: 'duckduckgo', requiresKey: false, configured: true, available: false })).toBe(
      'unavailable',
    );
  });

  it('готов, если ключ есть или он не нужен', () => {
    expect(backendState({ id: 'serper', requiresKey: true, configured: true })).toBe('ready');
    expect(backendState({ id: 'wikipedia', requiresKey: false, configured: true })).toBe('ready');
    expect(backendState({ id: 'wikipedia' })).toBe('ready');
  });
});

describe('searchSources — выбор источника', () => {
  it('известный бэкенд', () => {
    expect(isKnownBackend('auto', BACKENDS)).toBe(true);
    expect(isKnownBackend('wikipedia', BACKENDS)).toBe(true);
    expect(isKnownBackend('serper', BACKENDS)).toBe(true);
    expect(isKnownBackend('nope', BACKENDS)).toBe(false);
    expect(isKnownBackend(null, BACKENDS)).toBe(false);
  });

  it('сохранённый выбор приоритетнее серверного', () => {
    expect(resolveSelectedBackend('wikipedia', BACKENDS, 'serper')).toBe('wikipedia');
  });

  it('сохранённый «auto» сохраняется', () => {
    expect(resolveSelectedBackend('auto', BACKENDS, 'serper')).toBe('auto');
  });

  it('неизвестный сохранённый выбор → серверный', () => {
    expect(resolveSelectedBackend('gone', BACKENDS, 'serper')).toBe('serper');
  });

  it('серверный выбор по умолчанию — auto', () => {
    expect(resolveSelectedBackend(null, BACKENDS, 'auto')).toBe('auto');
    expect(resolveSelectedBackend(null, BACKENDS, null)).toBe('auto');
  });

  it('пустой список бэкендов → auto', () => {
    expect(resolveSelectedBackend(null, [], null)).toBe('auto');
  });
});

describe('searchSources — итог тестового поиска', () => {
  it('успех с результатами', () => {
    expect(searchOutcomeKey(null, 3)).toBe('searchSources.result.ok');
    expect(searchOutcomeTone(null, 3)).toBe('ok');
  });

  it('пустой ответ без ошибки', () => {
    expect(searchOutcomeKey('empty_results', 0)).toBe('searchSources.result.emptyResults');
    expect(searchOutcomeTone('empty_results', 0)).toBe('warning');
  });

  it('известные коды ошибок сервера', () => {
    expect(searchOutcomeKey('not_configured', 0)).toBe('searchSources.result.notConfigured');
    expect(searchOutcomeKey('empty_query', 0)).toBe('searchSources.result.emptyQuery');
    expect(searchOutcomeKey('timeout', 0)).toBe('searchSources.result.timeout');
    expect(searchOutcomeKey('network_unavailable', 0)).toBe('searchSources.result.network');
    expect(searchOutcomeTone('not_configured', 0)).toBe('warning');
    expect(searchOutcomeTone('timeout', 0)).toBe('error');
    expect(searchOutcomeTone('network_unavailable', 0)).toBe('error');
  });

  it('неизвестный код → общий сбой', () => {
    expect(searchOutcomeKey('something_new', 0)).toBe('searchSources.result.failed');
    expect(searchOutcomeTone('something_new', 0)).toBe('error');
  });

  it('null-причина без результатов трактуется как пустой ответ', () => {
    expect(searchOutcomeKey(null, 0)).toBe('searchSources.result.emptyResults');
  });
});

describe('searchSources — итог пробы ключа', () => {
  it('уровень ok', () => {
    expect(probeOutcomeKey('ok')).toBe('searchSources.probe.ok');
    expect(probeOutcomeTone('ok')).toBe('ok');
  });

  it('уровень warning', () => {
    expect(probeOutcomeKey('warning')).toBe('searchSources.probe.warning');
    expect(probeOutcomeTone('warning')).toBe('warning');
  });

  it('уровень error', () => {
    expect(probeOutcomeKey('error')).toBe('searchSources.probe.error');
    expect(probeOutcomeTone('error')).toBe('error');
  });

  it('неизвестный или отсутствующий уровень → error', () => {
    expect(probeOutcomeKey('weird')).toBe('searchSources.probe.error');
    expect(probeOutcomeKey(null)).toBe('searchSources.probe.error');
    expect(probeOutcomeTone(null)).toBe('error');
  });
});

// S1b — узкие доменные вертикали: keyless, «по теме», не основной движок.
// Сервер отдаёт их отдельным массивом `verticals` (каждый с `vertical: true`);
// UI обязан исключить их из селекта основного движка и показать как «без ключа».
const VERTICALS = [
  { id: 'openalex', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'crossref', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'europepmc', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'gdelt', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'nominatim', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'openlibrary', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'stackexchange', requiresKey: false, configured: true, available: true, official: true, vertical: true },
  { id: 'hn', requiresKey: false, configured: true, available: true, official: true, vertical: true },
];

describe('searchSources — вертикали (S1b)', () => {
  it('каталог вертикалей — ровно восемь известных id', () => {
    expect([...SEARCH_VERTICAL_IDS]).toEqual([
      'openalex',
      'crossref',
      'europepmc',
      'gdelt',
      'nominatim',
      'openlibrary',
      'stackexchange',
      'hn',
    ]);
  });

  it('вертикаль узнаётся по флагу vertical и по известному id', () => {
    expect(isVerticalBackend({ id: 'openalex', vertical: true })).toBe(true);
    // Защита на случай, если сервер не проставил флаг, но id известен.
    expect(isVerticalBackend({ id: 'hn' })).toBe(true);
    expect(isVerticalBackend({ id: 'wikipedia', requiresKey: false })).toBe(false);
    expect(isVerticalBackend({ id: 'tavily-keyless', requiresKey: false })).toBe(false);
    expect(isVerticalBackend({ id: 'serper', requiresKey: true })).toBe(false);
    expect(isVerticalBackend({ id: 'auto' })).toBe(false);
  });

  it('вертикали не попадают в селект основного движка', () => {
    const mixed = [...BACKENDS, ...VERTICALS];
    const selectable = selectableBackends(mixed);
    expect(selectable.map((b) => b.id)).toEqual(BACKENDS.map((b) => b.id));
    expect(selectable.some((b) => isVerticalBackend(b))).toBe(false);
  });

  it('selectableBackends исключает вертикаль даже без флага, по известному id', () => {
    const mixed = [...BACKENDS, { id: 'crossref', requiresKey: false }];
    expect(selectableBackends(mixed).map((b) => b.id)).toEqual(BACKENDS.map((b) => b.id));
  });

  it('collectVerticals берёт отдельный массив сервера и дедуплицирует по id', () => {
    const verticals = collectVerticals(BACKENDS, VERTICALS);
    expect(verticals.map((v) => v.id)).toEqual(VERTICALS.map((v) => v.id));
    // Все вертикали keyless и official.
    expect(verticals.every((v) => v.requiresKey === false)).toBe(true);
  });

  it('collectVerticals подхватывает вертикали, помеченные внутри backends', () => {
    const inline = { id: 'gdelt', requiresKey: false, vertical: true };
    const verticals = collectVerticals([...BACKENDS, inline], []);
    expect(verticals.map((v) => v.id)).toEqual(['gdelt']);
  });

  it('collectVerticals не дублирует id, присутствующий в обоих списках', () => {
    const inline = { id: 'openalex', requiresKey: false, vertical: true };
    const verticals = collectVerticals([...BACKENDS, inline], VERTICALS);
    expect(verticals.filter((v) => v.id === 'openalex')).toHaveLength(1);
    expect(verticals).toHaveLength(VERTICALS.length);
  });

  it('collectVerticals без вертикалей возвращает пустой список', () => {
    expect(collectVerticals(BACKENDS, [])).toEqual([]);
    expect(collectVerticals(BACKENDS, null)).toEqual([]);
    expect(collectVerticals(BACKENDS)).toEqual([]);
  });

  it('вертикаль не может быть выбранным основным движком', () => {
    const mixed = [...BACKENDS, ...VERTICALS];
    const selectable = selectableBackends(mixed);
    // Сохранённый id вертикали не признаётся допустимым выбором.
    expect(resolveSelectedBackend('openalex', selectable, 'auto')).toBe('auto');
    expect(resolveSelectedBackend('hn', selectable, 'serper')).toBe('serper');
  });
});

describe('searchSources — атрибуция provider в результатах (S1b)', () => {
  it('providerLabelKey строит ключ словаря из id источника', () => {
    expect(providerLabelKey('openalex')).toBe('searchSources.backend.openalex');
    expect(providerLabelKey('serper')).toBe('searchSources.backend.serper');
    expect(providerLabelKey('hn')).toBe('searchSources.backend.hn');
  });

  it('providerLabelKey без id возвращает null', () => {
    expect(providerLabelKey(null)).toBeNull();
    expect(providerLabelKey(undefined)).toBeNull();
    expect(providerLabelKey('')).toBeNull();
    expect(providerLabelKey('   ')).toBeNull();
  });

  it('resultProviderId извлекает непустой provider из элемента', () => {
    expect(resultProviderId({ provider: 'openalex' })).toBe('openalex');
    expect(resultProviderId({ provider: '  crossref  ' })).toBe('crossref');
    expect(resultProviderId({ title: 'x', url: 'y' })).toBeNull();
    expect(resultProviderId({ provider: null })).toBeNull();
    expect(resultProviderId({ provider: '' })).toBeNull();
    expect(resultProviderId(null)).toBeNull();
    expect(resultProviderId(undefined)).toBeNull();
  });
});
