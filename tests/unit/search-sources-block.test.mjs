// @vitest-environment jsdom
/**
 * Блок «Поисковые источники» — компонентный контракт.
 *
 * Контракт под тестом:
 *   - блок свёрнут по умолчанию (нативный <details>) и живёт ВНУТРИ секции
 *     «Провайдеры и ключи» (число разделов настроек не меняется);
 *   - список источников приходит с сервера (GET /api/search/backends), а
 *     подписи берутся из i18n-словаря (серверные подписи только по-русски);
 *   - выбор сохраняется в браузере (localStorage);
 *   - проба ключа доступна только для бэкендов с ключом и идёт на
 *     POST /api/search/probe;
 *   - тестовый поиск уходит на POST /api/search/search с выбранным
 *     источником полем `backend`;
 *   - ошибка поиска показывается честно, без серверного текста.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SearchSourcesBlock } from '../../src/features/settings/SearchSourcesBlock';
import { SettingsView } from '../../src/features/settings/SettingsView';
import { I18nProvider } from '../../src/i18n';
import { apiGet, apiPost } from '../../src/hooks/useApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BACKENDS = [
  { id: 'tavily', label: 'Tavily', requiresKey: true, configured: false, available: false, envKey: 'GENERAPTOR_TAVILY_API_KEY' },
  { id: 'serper', label: 'Serper.dev', requiresKey: true, configured: true, available: true, envKey: 'GENERAPTOR_SERPER_API_KEY' },
  { id: 'yandex', label: 'Yandex Search API', requiresKey: true, configured: true, available: true, envKey: 'YANDEX_API_KEY' },
  { id: 'tavily-keyless', label: 'Tavily (keyless, без ключа)', requiresKey: false, configured: true, available: true, envKey: null },
  { id: 'wikipedia', label: 'Wikipedia (MediaWiki API)', requiresKey: false, configured: true, available: true, envKey: null },
  { id: 'wikidata', label: 'Wikidata (MediaWiki API)', requiresKey: false, configured: true, available: true, envKey: null },
  { id: 'duckduckgo', label: 'DuckDuckGo (неофициальный скрейпинг, opt-in)', requiresKey: false, configured: true, available: true, envKey: null },
];

vi.mock('../../src/hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

function render(element, locale = 'ru') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        { initialLocale: locale },
        React.createElement(element, null),
      ),
    );
  });
  return container;
}

/** Данные приходят с сервера асинхронно — дожидаемся их появления в DOM. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function selectOption(select, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function typeInto(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  apiGet.mockImplementation(async (url) => {
    if (String(url).includes('/api/search/backends')) {
      return {
        success: true,
        data: {
          backends: BACKENDS,
          selected: 'auto',
          defaultBackend: 'tavily-keyless',
          lang: 'ru',
          warning: null,
        },
      };
    }
    return { success: true, data: { providers: [], roles: [] } };
  });
  apiPost.mockImplementation(async (url) => {
    if (String(url) === '/api/search/probe') {
      return {
        success: true,
        data: { backend: 'tavily', ok: true, level: 'ok', message: 'ok', latencyMs: 12 },
      };
    }
    return {
      success: true,
      data: {
        results: [{ title: 'Статья про поиск', url: 'https://example.com/a' }],
        backend: 'tavily-keyless',
        degraded: false,
        reason: null,
        limit: 3,
      },
    };
  });
});

afterEach(() => {
  // Каждый тест рендерит свой контейнер: чистим DOM, чтобы селекторы по id
  // не цепляли элементы предыдущего теста.
  document.body.innerHTML = '';
});

describe('SearchSourcesBlock — блок «Поисковые источники»', () => {
  it('свёрнут по умолчанию, заголовок — из i18n', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    const details = container.querySelector('details.search-sources');
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent.trim()).toBe('Поисковые источники');
  });

  it('английская локаль даёт английский заголовок', async () => {
    const container = render(SearchSourcesBlock, 'en');
    await flush();
    expect(container.querySelector('summary').textContent.trim()).toBe('Search sources');
  });

  it('живёт внутри секции «Провайдеры и ключи», разделов четыре (S5 T6: + обложка)', async () => {
    const container = render(SettingsView);
    await flush();
    expect(container.querySelectorAll('section.settings__section')).toHaveLength(4);
    expect(container.querySelector('section[data-section="providers"] details.search-sources')).not.toBeNull();
  });

  it('источники приходят с сервера, подписи — из i18n', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    const select = container.querySelector('select.select');
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual([
      'auto',
      'tavily',
      'serper',
      'yandex',
      'tavily-keyless',
      'wikipedia',
      'wikidata',
      'duckduckgo',
    ]);
    const labels = Array.from(select.options).map((option) => option.textContent.trim());
    expect(labels).toContain('Википедия');
    expect(labels).toContain('Tavily без ключа');
    expect(labels).not.toContain('Wikipedia (MediaWiki API)');
  });

  it('выбор сохраняется в браузере', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    const select = container.querySelector('select.select');
    selectOption(select, 'wikipedia');
    expect(window.localStorage.getItem('generaptor.searchBackend')).toBe('wikipedia');
    expect(select.value).toBe('wikipedia');
  });

  it('проба ключа доступна только для бэкенда с ключом', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    expect(buttonByText(container, 'Проверить ключ')).toBeUndefined();

    selectOption(container.querySelector('select.select'), 'tavily');
    const probeButton = buttonByText(container, 'Проверить ключ');
    expect(probeButton).toBeDefined();
    click(probeButton);
    await flush();

    expect(apiPost).toHaveBeenCalledWith('/api/search/probe', { backend: 'tavily' });
    expect(container.textContent).toContain('Ключ работает: провайдер ответил.');
  });

  it('тестовый поиск уходит с выбранным источником', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    selectOption(container.querySelector('select.select'), 'wikipedia');
    typeInto(container.querySelector('input.input'), 'поиск по статьям');
    click(buttonByText(container, 'Проверить поиск'));
    await flush();

    expect(apiPost).toHaveBeenCalledWith('/api/search/search', {
      query: 'поиск по статьям',
      backend: 'wikipedia',
      limit: 3,
      lang: 'ru',
    });
    expect(container.textContent).toContain('Статья про поиск');
    expect(container.querySelector('a[href="https://example.com/a"]')).not.toBeNull();
  });

  it('пустой запрос не уходит на сервер', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    click(buttonByText(container, 'Проверить поиск'));
    await flush();
    expect(apiPost).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Введите запрос для проверки.');
  });

  it('ошибка поиска показывается честно', async () => {
    apiPost.mockRejectedValueOnce(new Error('server down'));
    const container = render(SearchSourcesBlock);
    await flush();
    typeInto(container.querySelector('input.input'), 'запрос');
    click(buttonByText(container, 'Проверить поиск'));
    await flush();
    expect(container.textContent).toContain('Поиск не удался.');
  });
});

// S1b — вертикали «по теме», честная подсказка про Serper и атрибуция provider.
const VERTICALS = [
  { id: 'openalex', label: 'OpenAlex', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'crossref', label: 'Crossref', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'europepmc', label: 'Europe PMC', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'gdelt', label: 'GDELT', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'nominatim', label: 'Nominatim', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'openlibrary', label: 'OpenLibrary', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'stackexchange', label: 'Stack Exchange', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
  { id: 'hn', label: 'Hacker News', requiresKey: false, configured: true, available: true, official: true, vertical: true, envKey: null },
];

/** Подменить каталог GET /api/search/backends (отдельный массив verticals). */
function mockCatalog({ backends = BACKENDS, verticals = [], selected = 'auto' } = {}) {
  apiGet.mockImplementation(async (url) => {
    if (String(url).includes('/api/search/backends')) {
      return {
        success: true,
        data: { backends, verticals, selected, defaultBackend: 'tavily-keyless', lang: 'ru', warning: null },
      };
    }
    return { success: true, data: { providers: [], roles: [] } };
  });
}

/** Подменить ответ тестового поиска POST /api/search/search. */
function mockSearchResults(results, backend = 'serper') {
  apiPost.mockImplementation(async (url) => {
    if (String(url) === '/api/search/search') {
      return { success: true, data: { results, backend, degraded: false, reason: null, limit: 3 } };
    }
    return { success: true, data: { backend: 'tavily', ok: true, level: 'ok', latencyMs: 12 } };
  });
}

async function runTestSearch(container, query = 'поиск') {
  typeInto(container.querySelector('input.input'), query);
  click(buttonByText(container, 'Проверить поиск'));
  await flush();
}

describe('SearchSourcesBlock — вертикали «по теме» (S1b)', () => {
  it('вертикали показываются как «без ключа / по теме» и не входят в селект', async () => {
    mockCatalog({ verticals: VERTICALS });
    const container = render(SearchSourcesBlock);
    await flush();

    const select = container.querySelector('select.select');
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['auto', ...BACKENDS.map((b) => b.id)]);
    expect(values).not.toContain('openalex');
    expect(values).not.toContain('hn');

    const items = container.querySelectorAll('.search-sources__vertical');
    expect(items).toHaveLength(8);
    const body = container.textContent;
    expect(body).toContain('Источники по теме');
    expect(body).toContain('OpenAlex');
    expect(body).toContain('Hacker News');
    expect(body).toContain('без ключа');
    expect(body).toContain('по теме');
  });

  it('сырой id вертикали — только в title, не в видимом тексте', async () => {
    mockCatalog({ verticals: VERTICALS });
    const container = render(SearchSourcesBlock);
    await flush();
    const first = container.querySelector('.search-sources__vertical');
    expect(first.getAttribute('title')).toBe('openalex');
    expect(first.querySelector('.search-sources__vertical-name').textContent.trim()).toBe('OpenAlex');
    // Видимый текст блока не содержит сырых id вертикалей.
    expect(container.textContent).not.toContain('openalex');
    expect(container.textContent).not.toContain('stackexchange');
  });

  it('вертикаль, помеченная внутри backends, тоже исключается из селекта', async () => {
    mockCatalog({ backends: [...BACKENDS, { id: 'gdelt', requiresKey: false, vertical: true }], verticals: [] });
    const container = render(SearchSourcesBlock);
    await flush();
    const values = Array.from(container.querySelector('select.select').options).map((o) => o.value);
    expect(values).not.toContain('gdelt');
    expect(container.querySelectorAll('.search-sources__vertical')).toHaveLength(1);
    expect(container.textContent).toContain('GDELT');
  });

  it('без вертикалей список «по теме» не рендерится', async () => {
    mockCatalog({ verticals: [] });
    const container = render(SearchSourcesBlock);
    await flush();
    expect(container.querySelector('.search-sources__verticals')).toBeNull();
  });
});

describe('SearchSourcesBlock — честная подсказка про Serper (S1b)', () => {
  it('подсказка называет Serper основным движком и переменную ключа', async () => {
    const container = render(SearchSourcesBlock);
    await flush();
    const hint = container.querySelector('.search-sources__serper-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('GENERAPTOR_SERPER_API_KEY');
    expect(hint.textContent).toContain('Serper');
    expect(hint.textContent).toContain('Tavily без ключа');
  });

  it('английская локаль даёт английскую подсказку без кириллицы', async () => {
    const container = render(SearchSourcesBlock, 'en');
    await flush();
    const hint = container.querySelector('.search-sources__serper-hint');
    expect(hint.textContent).toContain('GENERAPTOR_SERPER_API_KEY');
    expect(hint.textContent).toContain('main engine');
    expect(/[\u0400-\u04FF]/.test(hint.textContent)).toBe(false);
  });
});

describe('SearchSourcesBlock — атрибуция provider в результатах (S1b)', () => {
  it('источник показывается подписью из словаря, id — только в title', async () => {
    mockSearchResults([{ title: 'Научная статья', url: 'https://example.com/p', provider: 'openalex' }]);
    const container = render(SearchSourcesBlock);
    await flush();
    await runTestSearch(container);
    const provider = container.querySelector('.search-sources__provider');
    expect(provider).not.toBeNull();
    expect(provider.textContent.trim()).toBe('OpenAlex');
    expect(provider.getAttribute('title')).toBe('openalex');
    expect(container.textContent).not.toContain('openalex');
  });

  it('неизвестный provider не показывает сырой ключ словаря', async () => {
    mockSearchResults([{ title: 'X', url: 'https://example.com/x', provider: 'mystery' }]);
    const container = render(SearchSourcesBlock);
    await flush();
    await runTestSearch(container);
    expect(container.querySelector('.search-sources__provider')).toBeNull();
    expect(container.textContent).not.toContain('searchSources.backend.mystery');
  });

  it('результат без provider не показывает атрибуцию', async () => {
    mockSearchResults([{ title: 'Статья', url: 'https://example.com/a' }]);
    const container = render(SearchSourcesBlock);
    await flush();
    await runTestSearch(container);
    expect(container.querySelector('.search-sources__provider')).toBeNull();
    expect(container.querySelector('a[href="https://example.com/a"]')).not.toBeNull();
  });
});
