/**
 * Unit tests for server/agent-role-execution.mjs — Dev-B Tasks 1 & 2.
 *
 * Task 2: resolveRoleMaxTokens dynamic limits.
 *   - article-author: dynamic by articleLength, clamped [8000, 16000].
 *   - factchecker / humanizer: 14000 (full rewrite / styling of full article).
 *   - fallbacks when articleLength unknown.
 *
 * Task 1 (callRouterAI) is exercised end-to-end through the worker tests that
 * mock it; its internal backoff/retry helpers are private. Here we focus on the
 * pure, exported max_tokens resolver.
 */
import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveRoleModel,
  resolveRoleMaxTokens,
  isRetryableStatus,
  isRetryableNetworkError,
  isFallbackChainEnabled,
  resolveFallbackChainModels,
  callRouterAIWithFallbackChain,
  resolveEnvNumber,
} from '../../server/agent-role-execution.mjs';
import {
  getExecutableRole,
  buildRoleExecutionMessages,
  buildRoleExecutionPayload,
  buildSemanticCoreContext,
} from '../../server/agent-role-execution.mjs';

describe('resolveRoleMaxTokens — Task 2 dynamic limits', () => {
  test('article-author: scales with articleLength (~ targetLength/3)', () => {
    // 50k chars ÷ 3 ≈ 16667 → clamped to 16000.
    expect(resolveRoleMaxTokens('article-author', 50000)).toBe(16000);

    // 30k chars ÷ 3 = 10000 → within [8000, 16000].
    expect(resolveRoleMaxTokens('article-author', 30000)).toBe(10000);

    // 24k chars ÷ 3 = 8000 → floor of the clamp.
    expect(resolveRoleMaxTokens('article-author', 24000)).toBe(8000);
  });

  test('article-author: clamps small articleLength to 8000 minimum', () => {
    // Tiny article: 3000 ÷ 3 = 1000 → clamped up to 8000.
    expect(resolveRoleMaxTokens('article-author', 3000)).toBe(8000);
    expect(resolveRoleMaxTokens('article-author', 1000)).toBe(8000);
  });

  test('article-author: clamps huge articleLength to 16000 maximum', () => {
    // 100k chars ÷ 3 ≈ 33333 → clamped down to 16000.
    expect(resolveRoleMaxTokens('article-author', 100000)).toBe(16000);
    expect(resolveRoleMaxTokens('article-author', 200000)).toBe(16000);
  });

  test('article-author: falls back to 9000 when articleLength not provided', () => {
    expect(resolveRoleMaxTokens('article-author')).toBe(9000);
    expect(resolveRoleMaxTokens('article-author', undefined)).toBe(9000);
    expect(resolveRoleMaxTokens('article-author', null)).toBe(9000);
    expect(resolveRoleMaxTokens('article-author', 0)).toBe(9000);
    expect(resolveRoleMaxTokens('article-author', NaN)).toBe(9000);
  });

  test('factchecker: 14000 (returns full rewritten article)', () => {
    expect(resolveRoleMaxTokens('factchecker')).toBe(14000);
    // articleLength does NOT affect factchecker.
    expect(resolveRoleMaxTokens('factchecker', 50000)).toBe(14000);
  });

  test('humanizer: 14000 (styles full article)', () => {
    expect(resolveRoleMaxTokens('humanizer')).toBe(14000);
    expect(resolveRoleMaxTokens('humanizer', 50000)).toBe(14000);
  });

  test('other roles keep their fixed limits', () => {
    expect(resolveRoleMaxTokens('structure-architect')).toBe(8000);
    expect(resolveRoleMaxTokens('research-analyst')).toBe(8000);
    expect(resolveRoleMaxTokens('knowledge-base-curator')).toBe(6500);
    expect(resolveRoleMaxTokens('semantic-strategist')).toBe(5000);
    expect(resolveRoleMaxTokens('seo-reviewer')).toBe(8000);
    expect(resolveRoleMaxTokens('quality-controller')).toBe(6000);
    expect(resolveRoleMaxTokens('brief-preparer')).toBe(5000);
    expect(resolveRoleMaxTokens('topic-selector')).toBe(5000);
  });

  test('unknown role falls back to DEFAULT_MAX_TOKENS (4000)', () => {
    expect(resolveRoleMaxTokens('nonexistent-role')).toBe(4000);
  });
});

describe('buildRoleExecutionMessages — formatRu → маркер «(оформи таблицей)» (task T1)', () => {
  /** user-сообщение автора для данных structureSections. */
  const userPromptFor = (structureSections) => {
    const messages = buildRoleExecutionMessages({
      roleId: 'article-author',
      structureSections,
    });
    expect(Array.isArray(messages)).toBe(true);
    const userMessage = messages.find((m) => m?.role === 'user');
    expect(userMessage).toBeTruthy();
    return userMessage.content;
  };

  test('formatRu: "таблица" → рядом с заголовком секции появляется «(оформи таблицей)»', () => {
    const prompt = userPromptFor([
      { headingRu: 'Введение', purposeRu: 'Ввести в тему.', keyPointsRu: ['Контекст.'] },
      {
        headingRu: 'Сравнение методов',
        purposeRu: 'Сопоставить методы.',
        keyPointsRu: ['Метод A.', 'Метод B.'],
        formatRu: 'таблица',
      },
    ]);
    expect(prompt).toContain('2. Сравнение методов (оформи таблицей) — цель: Сопоставить методы.');
    // Секция без маркера не помечается.
    expect(prompt).toContain('1. Введение — цель: Ввести в тему.');
    expect(prompt).not.toContain('1. Введение (оформи таблицей)');
  });

  test('formatRu отсутствует или "текст" → маркера нет (обратная совместимость контракта)', () => {
    const prompt = userPromptFor([
      { headingRu: 'Введение', purposeRu: 'Ввести в тему.' },
      { headingRu: 'Заключение', purposeRu: 'Подвести итог.', formatRu: 'текст' },
      { headingRu: 'Без формата', purposeRu: 'Любая цель.', formatRu: null },
    ]);
    expect(prompt).not.toContain('оформи таблицей');
    expect(prompt).toContain('3. Без формата — цель: Любая цель.');
  });

  test('formatRu нечувствителен к регистру и боковым пробелам', () => {
    const prompt = userPromptFor([
      { headingRu: 'Цены', purposeRu: 'Сравнить.', formatRu: '  ТАБЛИЦА  ' },
    ]);
    expect(prompt).toContain('1. Цены (оформи таблицей)');
  });

  test('нестроковые секции (legacy string-форма) не помечаются', () => {
    const prompt = userPromptFor(['Просто текстовая секция', 42]);
    expect(prompt).not.toContain('оформи таблицей');
  });

  test('маркер виден только article-author-структуре: без structureSections блока нет', () => {
    const prompt = userPromptFor([]);
    expect(prompt).not.toContain('Структура статьи');
  });
});

describe('buildSemanticCoreContext — P1 компактное SEO-ядро (контекст-строитель)', () => {
  // M2: wordstat-ключи убраны — semantic-strategist единственный источник ядра.
  test('собирает ядро из выхода semantic-strategist (сечки seo-standards)', () => {
    const core = buildSemanticCoreContext({
      mainQueryRu: '  имплантация зубов  ',
      queryClustersRu: Array.from({ length: 15 }, (_, i) => ({
        clusterRu: `Кластер ${i}`,
        queriesRu: [`запрос ${i}`],
      })),
      lsiTermsRu: Array.from({ length: 20 }, (_, i) => `lsi-${i}`),
      faqIntentsRu: Array.from({ length: 10 }, (_, i) => `Вопрос ${i}?`),
    });

    expect(core.mainQueryRu).toBe('имплантация зубов'); // trim
    expect(core.queryClustersRu).toHaveLength(10); // SEO-default (объёмной нормы нет)
    expect(core.lsiTermsRu).toHaveLength(12); // SEO-default
    expect(core.faqIntentsRu).toHaveLength(8); // SEO-default
  });

  test('null/мусор на входе → безопасные пустые значения (блок потом не рендерится)', () => {
    expect(buildSemanticCoreContext(null)).toEqual({
      mainQueryRu: '',
      queryClustersRu: [],
      lsiTermsRu: [],
      faqIntentsRu: [],
    });
    expect(buildSemanticCoreContext(undefined, undefined)).toEqual({
      mainQueryRu: '',
      queryClustersRu: [],
      lsiTermsRu: [],
      faqIntentsRu: [],
    });
  });

  test('сечка возвращает копии — входные массивы не мутируются', () => {
    const clusters = [{ clusterRu: 'Стоимость', queriesRu: ['цена'] }];
    const core = buildSemanticCoreContext({ queryClustersRu: clusters });
    expect(clusters).toHaveLength(1);
    expect(core.queryClustersRu).not.toBe(clusters);
  });
});

describe('buildRoleExecutionMessages — SEO-ядро в payload (P1)', () => {
  const semanticCore = {
    mainQueryRu: 'имплантация зубов',
    queryClustersRu: [
      { clusterRu: 'Стоимость', queriesRu: ['цена имплантации', 'сколько стоит имплант'] },
    ],
    lsiTermsRu: ['титановый винт', 'абатмент'],
    faqIntentsRu: ['Больно ли ставить имплант?'],
  };

  /** user-сообщение роли для переданного semanticCore (без прочих данных). */
  const userPromptOf = (roleId, core = semanticCore) => {
    const messages = buildRoleExecutionMessages({ roleId, semanticCore: core });
    expect(Array.isArray(messages)).toBe(true);
    const userMessage = messages.find((m) => m?.role === 'user');
    expect(userMessage).toBeTruthy();
    return userMessage.content;
  };

  test('structure-architect видит блок SEO-ядра: запрос, кластеры, LSI, FAQ-интенты', () => {
    const prompt = userPromptOf('structure-architect');
    expect(prompt).toContain('SEO-ядро');
    expect(prompt).toContain('имплантация зубов');
    expect(prompt).toContain('Стоимость');
    expect(prompt).toContain('цена имплантации');
    expect(prompt).toContain('титановый винт');
    expect(prompt).toContain('Больно ли ставить имплант?');
    // M2: wordstat-ключей в ядре больше нет.
    expect(prompt).not.toContain('Wordstat');
  });

  test('seo-reviewer видит блок SEO-ядра', () => {
    const prompt = userPromptOf('seo-reviewer');
    expect(prompt).toContain('SEO-ядро');
    expect(prompt).toContain('имплантация зубов');
    expect(prompt).toContain('титановый винт');
  });

  test('другие роли блок SEO-ядра НЕ получают (payload не растёт)', () => {
    for (const roleId of [
      'topic-selector',
      'brief-preparer',
      'knowledge-base-curator',
      'research-analyst',
      'semantic-strategist',
      'article-author',
      'factchecker',
      'quality-controller',
      'humanizer',
    ]) {
      expect(userPromptOf(roleId)).not.toContain('SEO-ядро');
    }
  });

  test('article-author: только строка с главным запросом, без кластеров/LSI/FAQ-интентов', () => {
    const prompt = userPromptOf('article-author');
    // Главный запрос приходит отдельной строкой из semanticCore.mainQueryRu.
    expect(prompt).toContain('имплантация зубов');
    expect(prompt).not.toContain('SEO-ядро');
    expect(prompt).not.toContain('титановый винт');
    expect(prompt).not.toContain('Больно ли ставить имплант?');
  });

  test('article-author без mainQueryRu в ядре — строка не добавляется', () => {
    const prompt = userPromptOf('article-author', { ...semanticCore, mainQueryRu: '' });
    expect(prompt).not.toContain('Главный запрос');
  });

  test('пустое ядро → блока нет (обратная совместимость: старые пайплайны без semanticCore)', () => {
    expect(userPromptOf('structure-architect', null)).not.toContain('SEO-ядро');
    expect(userPromptOf('structure-architect', {
      mainQueryRu: '',
      queryClustersRu: [],
      lsiTermsRu: [],
      faqIntentsRu: [],
    })).not.toContain('SEO-ядро');
  });

  test('buildRoleExecutionPayload: context.semanticCore доезжает до user-сообщения архитектора', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'structure-architect',
      context: { semanticCore },
    });
    const userMessage = payload.messages.find((m) => m?.role === 'user');
    expect(userMessage.content).toContain('SEO-ядро');
    expect(userMessage.content).toContain('имплантация зубов');
  });
});

describe('D6 — язык материала в промптах конвейера', () => {
  const userPromptOf = (opts) => {
    const messages = buildRoleExecutionMessages(opts);
    return messages.find((m) => m?.role === 'user').content;
  };

  test('default (no language): формат ответа — русский, байт-паритет с прежним поведением', () => {
    const prompt = userPromptOf({ roleId: 'brief-preparer' });
    expect(prompt).toContain('Формат ответа:');
    expect(prompt).toContain('- Пиши полностью на русском языке.');
  });

  test("language 'ru' — та же строка, что и по умолчанию", () => {
    const prompt = userPromptOf({ roleId: 'brief-preparer', language: 'ru' });
    expect(prompt).toContain('- Пиши полностью на русском языке.');
  });

  test("language 'en' — директива английского в формате ответа + строка языка в контексте", () => {
    const prompt = userPromptOf({ roleId: 'article-author', language: 'en' });
    expect(prompt).toContain('Пиши полностью на английском языке');
    expect(prompt).not.toContain('- Пиши полностью на русском языке.');
    // Материал — параметр генерации: роль видит его в контексте проекта.
    expect(prompt).toMatch(/Язык материала.*английский/u);
  });

  test("language 'en' доезжает через buildRoleExecutionPayload (context.language)", () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'article-author',
      context: { language: 'en' },
    });
    const userMessage = payload.messages.find((m) => m?.role === 'user');
    expect(userMessage.content).toContain('Пиши полностью на английском языке');
  });

  test('мусорный язык трактуется как ru (защита контракта на стороне роута)', () => {
    const prompt = userPromptOf({ roleId: 'brief-preparer', language: 'de' });
    expect(prompt).toContain('- Пиши полностью на русском языке.');
  });
});

describe('seo-round TL — шов companyName → промпт автора (B1 → A)', () => {
  // Единый источник имени компании — sourceSite.name из БД (например
  // «Пример», НЕ латинское «Example Company» из seo-requirements): линкер
  // (opts.siteName) и постчек со счётчиком упоминаний бренда считают ту же форму.
  // Без этой строки (companyProfileText пуст у прод-источников) правило
  // «УПОМИНАНИЯ КОМПАНИИ» промпта автора неработоспособно: модель писала бы
  // «наша компания», а постчек ловил ложный major-fail на 0 упоминаниях.
  const userPromptOf = (opts) => {
    const messages = buildRoleExecutionMessages(opts);
    return messages.find((m) => m?.role === 'user').content;
  };

  test('companyName доходит до user-payload автора фактической формой из БД', () => {
    const prompt = userPromptOf({
      roleId: 'article-author',
      companyName: 'Пример',
      companyProfileText: '', // прод-факт: «Описание компании» пуст
    });
    expect(prompt).toContain('Компания (точное название для упоминаний в тексте): Пример');
  });

  test('строка компании — в секции «Контекст источника и проекта» (после «Проект:», до заголовка статьи)', () => {
    const prompt = userPromptOf({ roleId: 'article-author', companyName: 'Пример' });
    const companyIdx = prompt.indexOf('Компания (точное название для упоминаний в тексте): Пример');
    const projectIdx = prompt.indexOf('- Проект:');
    const titleIdx = prompt.indexOf('- Заголовок статьи:');
    expect(companyIdx).toBeGreaterThan(projectIdx);
    expect(companyIdx).toBeLessThan(titleIdx);
  });

  test('companyName пустой/мусорный → строки компании НЕТ (автор честно пишет «наша компания»)', () => {
    for (const empty of [undefined, '', '   ']) {
      const prompt = userPromptOf({ roleId: 'article-author', companyName: empty });
      expect(prompt).not.toContain('точное название для упоминаний');
    }
  });

  test('buildRoleExecutionPayload: context.siteName доезжает до user-сообщения', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'article-author',
      context: { siteName: 'Пример' },
    });
    const userMessage = payload.messages.find((m) => m?.role === 'user');
    expect(userMessage.content).toContain('Пример');
  });

  test('buildRoleExecutionPayload: без siteName строка компании не подставляется', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'article-author',
      context: {},
    });
    const userMessage = payload.messages.find((m) => m?.role === 'user');
    expect(userMessage.content).not.toContain('Компания (точное название');
  });

  test('buildRoleExecutionPayload: siteName — единственный источник имени компании', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'article-author',
      context: { siteName: 'Новое' },
    });
    const userMessage = payload.messages.find((m) => m?.role === 'user');
    expect(userMessage.content).toContain(
      '- Компания (точное название для упоминаний в тексте): Новое'
    );
  });
});

describe('isRetryableStatus — Task 1 HTTP-status retry classification', () => {
  test('429 (rate limit) is retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  test('5xx server errors are retryable', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  test('4xx (except 429) are NOT retryable — Dev-A handles auth branch', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false); // auth — never retried here
    expect(isRetryableStatus(402)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });

  test('2xx success statuses are NOT retryable', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(201)).toBe(false);
  });

  test('null/undefined → not retryable', () => {
    expect(isRetryableStatus(null)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });
});

describe('isRetryableNetworkError — Task 1 network-error retry classification', () => {
  test('fetch failed (broken keep-alive) is retryable', () => {
    expect(isRetryableNetworkError(new Error('fetch failed'))).toBe(true);
  });

  test('common Node network error codes are retryable', () => {
    expect(isRetryableNetworkError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableNetworkError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableNetworkError(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryableNetworkError(new Error('ECONNREFUSED'))).toBe(true);
  });

  test('AbortError (timeout) is retryable', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  test('non-network errors are NOT retryable (e.g. JSON parse, schema)', () => {
    expect(isRetryableNetworkError(new Error('Unexpected token < in JSON'))).toBe(false);
    expect(isRetryableNetworkError(new Error('schema validation failed'))).toBe(false);
    expect(isRetryableNetworkError(new TypeError('cannot read property'))).toBe(false);
  });

  test('null/undefined/falsy → not retryable', () => {
    expect(isRetryableNetworkError(null)).toBe(false);
    expect(isRetryableNetworkError(undefined)).toBe(false);
    expect(isRetryableNetworkError(false)).toBe(false);
  });
});

describe('resolveRoleModel — 3-tier routing (critical/generation/standard)', () => {
  test('critical roles route to criticalModel', () => {
    const opts = { criticalModel: 'qwen/qwen3.7-plus', generationModel: 'qwen/qwen3.6-flash', standardModel: 'deepseek/deepseek-v4-flash' };
    expect(resolveRoleModel(getExecutableRole('factchecker'), opts)).toBe('qwen/qwen3.7-plus');
    expect(resolveRoleModel(getExecutableRole('quality-controller'), opts)).toBe('qwen/qwen3.7-plus');
    expect(resolveRoleModel(getExecutableRole('structure-architect'), opts)).toBe('qwen/qwen3.7-plus');
    expect(resolveRoleModel(getExecutableRole('research-analyst'), opts)).toBe('qwen/qwen3.7-plus');
  });

  test('generation roles route to generationModel', () => {
    const opts = { criticalModel: 'qwen/qwen3.7-plus', generationModel: 'qwen/qwen3.6-flash', standardModel: 'deepseek/deepseek-v4-flash' };
    expect(resolveRoleModel(getExecutableRole('article-author'), opts)).toBe('qwen/qwen3.6-flash');
    expect(resolveRoleModel(getExecutableRole('topic-selector'), opts)).toBe('qwen/qwen3.6-flash');
    expect(resolveRoleModel(getExecutableRole('seo-reviewer'), opts)).toBe('qwen/qwen3.6-flash');
    expect(resolveRoleModel(getExecutableRole('humanizer'), opts)).toBe('qwen/qwen3.6-flash');
    expect(resolveRoleModel(getExecutableRole('semantic-strategist'), opts)).toBe('qwen/qwen3.6-flash');
  });

  test('standard roles route to standardModel', () => {
    const opts = { criticalModel: 'qwen/qwen3.7-plus', generationModel: 'qwen/qwen3.6-flash', standardModel: 'deepseek/deepseek-v4-flash' };
    expect(resolveRoleModel(getExecutableRole('brief-preparer'), opts)).toBe('deepseek/deepseek-v4-flash');
    expect(resolveRoleModel(getExecutableRole('knowledge-base-curator'), opts)).toBe('deepseek/deepseek-v4-flash');
  });

  test('falls back to env defaults when opts not provided', () => {
    // Defaults are read from env at module load. These tests assume the .env
    // values from the plan: qwen3.7-plus / qwen3.6-flash / deepseek-v4-flash.
    // If env is unset, defaults from code apply (same strings).
    const fc = resolveRoleModel(getExecutableRole('factchecker'));
    expect(fc).toMatch(/qwen3\.7-plus|qwen3\.7-max|deepseek-v4-pro/); // tolerant: depends on env state
  });

  test('legacy "hard" tier maps to critical (backward compat)', () => {
    const legacyRole = { id: 'fake-legacy', modelTier: 'hard' };
    const opts = { criticalModel: 'CRIT', generationModel: 'GEN', standardModel: 'STD' };
    expect(resolveRoleModel(legacyRole, opts)).toBe('CRIT');
  });

  test('empty-string opts fall back to defaults', () => {
    const opts = { criticalModel: '', generationModel: '', standardModel: '' };
    const fc = resolveRoleModel(getExecutableRole('factchecker'), opts);
    expect(fc.length).toBeGreaterThan(0); // non-empty default kicked in
  });
});

describe('callRouterAI — W1.5 таймаут-калибровка (попытки 5→3 + скользящий бюджет)', () => {
  // Прод-контекст (analyst-report, 97 ранов): фактчекер исчерпывал все 5
  // попыток × 180с в 43% ранов → 932с ожидания на одну роль → fallback.
  // Калибровка: 3 попытки (env-override ROUTERAI_MAX_RETRIES), скользящий
  // бюджет на роль maxAttempts × timeoutMs с быстрым fail, per-attempt
  // таймаут 180с НЕ меняется (539с — длительность роли с ретраями, не попытка).
  //
  // Все тесты на fake timers: виртуальное время, реальные секунды не тратятся.
  // ROUTERAI_TIMEOUT_MS сознательно 10с в ретрай-тестах, чтобы бэкоффы
  // (2–3с/4–5с) влезали в бюджет 3×10с — как в проде (2–5с в 540с).

  let callRouterAI;
  let savedRetries;
  let savedTimeout;

  const basePayload = {
    model: 'qwen/qwen3.6-flash',
    messages: [{ role: 'user', content: 'тест' }],
    stream: false,
  };

  /** fetch, который никогда не отвечает сам и реджектится только по abort. */
  const hangingFetch = vi.fn((_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })
  );

  /** fetch, падающий мгновенно сетевой ошибкой (ретраебельной). */
  const instantlyFailingFetch = vi.fn(() => Promise.reject(new Error('fetch failed')));

  beforeEach(async () => {
    vi.useFakeTimers();
    // M3: callRouterAI резолвит активного провайдера асинхронно (БД). На
    // fake timers реальный Prisma-запрос не завершается — стаб резолюции
    // выносит провайдера из-под теста (ретраи/бюджет — не резолюция; ей
    // посвящён отдельный agent-role-execution-provider.test.mjs).
    vi.resetModules(); // fresh registry so the doMock below applies
    vi.doMock('../../server/lib/providers.mjs', () => ({
      resolveActiveProviderForEngine: async () => ({
        kind: 'routerai',
        label: 'RouterAI',
        baseUrl: 'https://routerai.ru/api/v1',
        apiKey: 'fake-timers-test-key',
        keyOptional: false,
        imagesCapability: 'yes',
        models: {},
      }),
      missingProviderKeyError: (provider) =>
        new Error(`${provider?.kind ?? 'routerai'}: API-ключ не настроен`),
      pinnedTierModel: () => undefined,
    }));
    savedRetries = process.env.ROUTERAI_MAX_RETRIES;
    savedTimeout = process.env.ROUTERAI_TIMEOUT_MS;
    delete process.env.ROUTERAI_MAX_RETRIES;
    delete process.env.ROUTERAI_TIMEOUT_MS;
    ({ callRouterAI } = await import('../../server/agent-role-execution.mjs'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../server/lib/providers.mjs');
    vi.unstubAllGlobals();
    if (savedRetries === undefined) delete process.env.ROUTERAI_MAX_RETRIES;
    else process.env.ROUTERAI_MAX_RETRIES = savedRetries;
    if (savedTimeout === undefined) delete process.env.ROUTERAI_TIMEOUT_MS;
    else process.env.ROUTERAI_TIMEOUT_MS = savedTimeout;
  });

  test('дефолт: вечные таймауты → ровно 3 попытки (было 5), throw последнего AbortError', async () => {
    process.env.ROUTERAI_TIMEOUT_MS = '10000';
    vi.stubGlobal('fetch', hangingFetch);

    const promise = callRouterAI(basePayload).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await promise;

    // Ровно 3 попытки: 1 initial + 2 retries (дефолт ROUTERAI_MAX_RETRIES=2).
    expect(hangingFetch).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
  });

  test('env-override ROUTERAI_MAX_RETRIES работает: 0 → 1 попытка, 1 → 2 попытки', async () => {
    process.env.ROUTERAI_TIMEOUT_MS = '10000';

    process.env.ROUTERAI_MAX_RETRIES = '0';
    vi.stubGlobal('fetch', hangingFetch.mockClear());
    let promise = callRouterAI(basePayload).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    process.env.ROUTERAI_MAX_RETRIES = '1';
    hangingFetch.mockClear();
    promise = callRouterAI(basePayload).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;
    expect(hangingFetch).toHaveBeenCalledTimes(2);
  });

  test('W4.7 per-call override бьёт env: {maxRetries:0, timeoutMs} → ровно 1 попытка', async () => {
    // Служебные one-shot вызовы (wordstat-breakdown) не должны наследовать
    // env-политику 3×180с: даже при ROUTERAI_MAX_RETRIES=5 override даёт
    // одну попытку с урезанным таймаутом.
    process.env.ROUTERAI_MAX_RETRIES = '5';
    vi.stubGlobal('fetch', hangingFetch.mockClear());

    const promise = callRouterAI(basePayload, { maxRetries: 0, timeoutMs: 10_000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await promise;

    expect(hangingFetch).toHaveBeenCalledTimes(1); // не 6, как велит env
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
  });

  test('успешный медленный вызов (179с при таймауте 180с) НЕ прибивается бюджетом', async () => {
    // Дефолтный ROUTERAI_TIMEOUT_MS=180000. Ответ приходит на 179-й секунде —
    // внутри per-attempt таймаута; скользящий бюджет не должен обрывать успех.
    const slowSuccessFetch = vi.fn(() =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            body: null, // нет body → non-stream путь через text()
            text: async () =>
              JSON.stringify({
                choices: [
                  { message: { role: 'assistant', content: 'медленный-но-успешный-ответ' }, finish_reason: 'stop' },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
          });
        }, 179_000);
      })
    );
    vi.stubGlobal('fetch', slowSuccessFetch);

    const promise = callRouterAI(basePayload);
    await vi.advanceTimersByTimeAsync(179_000);
    const result = await promise;

    expect(slowSuccessFetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.data.choices[0].message.content).toBe('медленный-но-успешный-ответ');
  });

  test('скользящий бюджет: ROUTERAI_MAX_RETRIES=9 + мгновенные fetch failed → быстрый fail задолго до 10 попыток', async () => {
    // Бюджет = 10 попыток × 1с = 10с. Бэкоффы 2-3с/4-5с/8-9с: перед 4-й попыткой
    // elapsed ≥ 14с ≥ 10с → stop. Ровно 3 фактических вызова вместо 10.
    process.env.ROUTERAI_TIMEOUT_MS = '1000';
    process.env.ROUTERAI_MAX_RETRIES = '9';
    vi.stubGlobal('fetch', instantlyFailingFetch);

    const promise = callRouterAI(basePayload).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await promise;

    expect(instantlyFailingFetch.mock.calls.length).toBe(3);
    expect(instantlyFailingFetch.mock.calls.length).toBeLessThan(10);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('fetch failed');
  });

  test('TL-ревью: мусорные env-значения (NaN) → дефолты, а не `throw undefined` / мгновенный abort', async () => {
    // Number('oops') = NaN: без guard'а maxAttempts=NaN → цикл попыток не
    // выполнялся ни разу и callRouterAI делал `throw undefined`; для таймаута
    // Math.max(1000, NaN)=NaN → setTimeout(NaN) → мгновенный abort всех попыток.
    process.env.ROUTERAI_MAX_RETRIES = 'не-число';
    process.env.ROUTERAI_TIMEOUT_MS = 'тоже-мусор';
    vi.stubGlobal('fetch', hangingFetch.mockClear());

    const promise = callRouterAI(basePayload).catch((e) => e);
    // Дефолтная политика применена как есть: 3 попытки × 180с + бэкоффы
    // (виртуальное время).
    await vi.advanceTimersByTimeAsync(600_000);
    const err = await promise;

    // Ровно 3 попытки (дефолт), честный AbortError вместо undefined-throw.
    expect(hangingFetch).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
  });
});

describe('callRouterAI — FIX-M1: lastError в HTTP-retryable-пути (429/5xx)', () => {
  // Баг: HTTP-retryable-ветка (429/5xx) не писала lastError — если бюджет
  // исчерпывался после такой серии (без единой network-ошибки), цикл
  // завершался break'ом и `throw lastError` бросал UNDEFINED.
  // Фикс: lastError инициализируется при retryable-HTTP-сбое; финальный
  // throw имеет гарантированный фолбэк- Error.

  let callRouterAI;
  let savedRetries;
  let savedTimeout;

  const http429Fetch = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status: 429,
      body: null,
      text: async () => JSON.stringify({ error: { message: 'rate limit' } }),
    })
  );

  beforeEach(async () => {
    vi.useFakeTimers();
    // M3: callRouterAI резолвит активного провайдера асинхронно (БД). На
    // fake timers реальный Prisma-запрос не завершается — стаб резолюции
    // выносит провайдера из-под теста (ретраи/бюджет — не резолюция; ей
    // посвящён отдельный agent-role-execution-provider.test.mjs).
    vi.resetModules(); // fresh registry so the doMock below applies
    vi.doMock('../../server/lib/providers.mjs', () => ({
      resolveActiveProviderForEngine: async () => ({
        kind: 'routerai',
        label: 'RouterAI',
        baseUrl: 'https://routerai.ru/api/v1',
        apiKey: 'fake-timers-test-key',
        keyOptional: false,
        imagesCapability: 'yes',
        models: {},
      }),
      missingProviderKeyError: (provider) =>
        new Error(`${provider?.kind ?? 'routerai'}: API-ключ не настроен`),
      pinnedTierModel: () => undefined,
    }));
    savedRetries = process.env.ROUTERAI_MAX_RETRIES;
    savedTimeout = process.env.ROUTERAI_TIMEOUT_MS;
    delete process.env.ROUTERAI_MAX_RETRIES;
    delete process.env.ROUTERAI_TIMEOUT_MS;
    ({ callRouterAI } = await import('../../server/agent-role-execution.mjs'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../server/lib/providers.mjs');
    vi.unstubAllGlobals();
    if (savedRetries === undefined) delete process.env.ROUTERAI_MAX_RETRIES;
    else process.env.ROUTERAI_MAX_RETRIES = savedRetries;
    if (savedTimeout === undefined) delete process.env.ROUTERAI_TIMEOUT_MS;
    else process.env.ROUTERAI_TIMEOUT_MS = savedTimeout;
  });

  test('бюджет исчерпан после 429-серии → бросается Error с HTTP-статусом, не undefined', async () => {
    // Бюджет = 10 × 1с = 10с; бэкоффы 2-3/4-5/8-9с → перед 4-й попыткой
    // elapsed ≥ 14с ≥ 10с → быстрый fail. Все сбои — HTTP 429 (не network),
    // т.е. old-код бросал бы undefined.
    process.env.ROUTERAI_TIMEOUT_MS = '1000';
    process.env.ROUTERAI_MAX_RETRIES = '9';
    vi.stubGlobal('fetch', http429Fetch);

    const promise = callRouterAI({
      model: 'qwen/qwen3.6-flash',
      messages: [{ role: 'user', content: 'тест' }],
      stream: false,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await promise;

    // Останов задолго до 10 попыток — бюджет сработал.
    expect(http429Fetch.mock.calls.length).toBe(3);

    // Бросается именно Error с осмысленным сообщением (статус 429 виден),
    // не undefined / не NaN-мусор.
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/429/);
  });
});

/* ======================================================================
 * W4.1 (2026-08-17): цепочка резервных моделей RouterAI.
 * Прод-факт (3 деплоя подряд): роли падают по «This operation was aborted»
 * после исчерпания ретраев callRouterAI — стабильная деградация модели.
 * Цепочка (D4 владельца): critical→generation (qwen3.6-flash, deepseek НЕ
 * для крит-ролей), generation→standard (deepseek-v4-flash), standard→STOP.
 * Деградация ТОЛЬКО на повторном сбое; thinking/max_tokens сохраняются;
 * kill-switch ROUTERAI_FALLBACK_CHAIN=off (default ON).
 * ==================================================================== */

describe('W4.1 — resolveFallbackChainModels: tier-цепочка (D4)', () => {
  let savedChainEnv;

  beforeEach(() => {
    savedChainEnv = process.env.ROUTERAI_FALLBACK_CHAIN;
    delete process.env.ROUTERAI_FALLBACK_CHAIN;
  });

  afterEach(() => {
    if (savedChainEnv === undefined) delete process.env.ROUTERAI_FALLBACK_CHAIN;
    else process.env.ROUTERAI_FALLBACK_CHAIN = savedChainEnv;
  });

  test('critical → [generation]; deepseek НЕ в цепочке крит-ролей', () => {
    for (const roleId of ['factchecker', 'quality-controller', 'structure-architect', 'research-analyst']) {
      const chain = resolveFallbackChainModels(roleId);
      expect(chain).toEqual(['qwen/qwen3.6-flash']);
      expect(chain.join(' ')).not.toContain('deepseek');
    }
  });

  test('generation → [standard]', () => {
    for (const roleId of ['article-author', 'topic-selector', 'seo-reviewer', 'humanizer']) {
      expect(resolveFallbackChainModels(roleId)).toEqual(['deepseek/deepseek-v4-flash']);
    }
  });

  test('standard → [] (STOP: ниже деградировать некуда)', () => {
    expect(resolveFallbackChainModels('brief-preparer')).toEqual([]);
    expect(resolveFallbackChainModels('knowledge-base-curator')).toEqual([]);
    expect(resolveFallbackChainModels('publisher')).toEqual([]);
  });

  test('неизвестная роль → [] (defensive, без throw)', () => {
    expect(resolveFallbackChainModels('no-such-role')).toEqual([]);
    expect(resolveFallbackChainModels(undefined)).toEqual([]);
  });

  test('kill-switch ROUTERAI_FALLBACK_CHAIN=off → пустая цепочка у всех тиров', () => {
    process.env.ROUTERAI_FALLBACK_CHAIN = 'off';
    expect(isFallbackChainEnabled()).toBe(false);
    expect(resolveFallbackChainModels('factchecker')).toEqual([]);
    expect(resolveFallbackChainModels('article-author')).toEqual([]);
    expect(resolveFallbackChainModels('brief-preparer')).toEqual([]);
  });

  test('default ON; явные модели-override резолвятся вместо env-дефолтов', () => {
    expect(isFallbackChainEnabled()).toBe(true);
    expect(resolveFallbackChainModels('factchecker', { generationModel: 'custom/gen' })).toEqual(['custom/gen']);
    expect(resolveFallbackChainModels('article-author', { standardModel: 'custom/std' })).toEqual(['custom/std']);
    // Пустой override фолбэчит на env-дефолт (паттерн asNonEmptyString).
    expect(resolveFallbackChainModels('factchecker', { generationModel: '' })).toEqual(['qwen/qwen3.6-flash']);
  });
});

describe('callRouterAIWithFallbackChain — деградация только на повторном сбое', () => {
  // Все тесты на fake timers: внутренние ретраи callRouterAI (дефолт
  // ROUTERAI_MAX_RETRIES=2 → 3 попытки на звено) спят на backoff-таймерах.

  let savedChainEnv;
  let savedRetries;
  let savedTimeout;

  /**
   * fetch, различающий модели в теле запроса. behavior: { [model]: 'network'
   * | 'empty' | 401 } — отсутствие записи = успех (200 + содержательный
   * content). calls накапливает ПОЛНЫЕ тела запросов (для проверки model /
   * enable_thinking / max_tokens каждого звена).
   */
  function modelAwareFetch(behavior = {}) {
    const calls = [];
    const fetchMock = vi.fn((_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const mode = behavior[body.model];
      if (mode === 'network') return Promise.reject(new Error('fetch failed'));
      if (mode === 401) {
        return Promise.resolve({
          ok: false,
          status: 401,
          body: null,
          text: async () => JSON.stringify({ error: { message: 'bad key' } }),
        });
      }
      const content = mode === 'empty' ? '' : 'содержательный-ответ-модели';
      return Promise.resolve({
        ok: true,
        status: 200,
        body: null, // нет body → non-stream путь через text()
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      });
    });
    return { fetchMock, calls };
  }

  /** Запуск цепочки с продвижением виртуального времени (backoff-ретраи). */
  async function runChain(payload, roleId, chainInfo) {
    // M3: цепочка резолвит активного провайдера (БД). На fake timers этот
    // await не укладывается в advanceTimersByTimeAsync (реальный I/O Prisma
    // не движется виртуальным временем), поэтому runChain берёт СВЕЖИЙ
    // экземпляр модуля с застабленной резолюцией (см. beforeEach). Резолюции
    // провайдера посвящён отдельный agent-role-execution-provider.test.mjs.
    const { callRouterAIWithFallbackChain: chain } = await import(
      '../../server/agent-role-execution.mjs'
    );
    const outcome = chain(payload, { roleId, chainInfo })
      .then((r) => ({ result: r }), (e) => ({ error: e }));
    await vi.advanceTimersByTimeAsync(120_000);
    return outcome;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // M3: стабиль провайдер-резолюции — реальный Prisma-запрос не завершается
    // под fake timers (тот же паттерн, что в W1.5/FIX-M1 describe выше).
    // Дескриптор routerai с пустыми models: tier-пиннинг не срабатывает,
    // правят env-дефолты — ровно то, что проверяют эти тесты деградации.
    vi.resetModules(); // fresh registry so the doMock below applies
    vi.doMock('../../server/lib/providers.mjs', () => ({
      resolveActiveProviderForEngine: async () => ({
        kind: 'routerai',
        label: 'RouterAI',
        baseUrl: 'https://routerai.ru/api/v1',
        apiKey: 'fake-timers-test-key',
        keyOptional: false,
        imagesCapability: 'yes',
        models: {},
      }),
      missingProviderKeyError: (provider) =>
        new Error(`${provider?.kind ?? 'routerai'}: API-ключ не настроен`),
      pinnedTierModel: (tier, models) => {
        if (!models) return undefined;
        if (tier === 'critical' || tier === 'hard') return models.critical;
        if (tier === 'generation') return models.generation;
        if (tier === 'standard') return models.standard;
        return undefined;
      },
    }));
    savedChainEnv = process.env.ROUTERAI_FALLBACK_CHAIN;
    savedRetries = process.env.ROUTERAI_MAX_RETRIES;
    savedTimeout = process.env.ROUTERAI_TIMEOUT_MS;
    delete process.env.ROUTERAI_FALLBACK_CHAIN;
    delete process.env.ROUTERAI_MAX_RETRIES;
    delete process.env.ROUTERAI_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../server/lib/providers.mjs');
    vi.unstubAllGlobals();
    for (const [saved, key] of [[savedChainEnv, 'ROUTERAI_FALLBACK_CHAIN'], [savedRetries, 'ROUTERAI_MAX_RETRIES'], [savedTimeout, 'ROUTERAI_TIMEOUT_MS']]) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test('critical-роль падает 3× на qwen3.7-plus → 4-й вызов на qwen3.6-flash, успех на 2-м звене', async () => {
    const { fetchMock, calls } = modelAwareFetch({ 'qwen/qwen3.7-plus': 'network' });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    expect(payload.model).toBe('qwen/qwen3.7-plus');
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'factchecker', chainInfo);

    expect(error).toBeUndefined();
    expect(result.status).toBe(200);
    // Первичная модель всегда первая: 3 попытки (W1.5) на qwen3.7-plus,
    // затем 4-й вызов цепочки — на qwen3.6-flash.
    expect(calls.map((b) => b.model)).toEqual([
      'qwen/qwen3.7-plus', 'qwen/qwen3.7-plus', 'qwen/qwen3.7-plus',
      'qwen/qwen3.6-flash',
    ]);
    // Журнал: реально исполнившая модель + факт деградации.
    expect(chainInfo.model).toBe('qwen/qwen3.6-flash');
    expect(chainInfo.fallbackModel).toBe('qwen/qwen3.6-flash');
    expect(chainInfo.failedAttempts).toBe(1);
  });

  test('цепочка critical исчерпана → throw последней ошибки; deepseek НЕ вызывается ни разу', async () => {
    const { fetchMock, calls } = modelAwareFetch({
      'qwen/qwen3.7-plus': 'network',
      'qwen/qwen3.6-flash': 'network',
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'factchecker', chainInfo);

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('fetch failed');
    // 3 попытки на каждом из двух звеньев; крит-роль никогда не падает до deepseek.
    expect(calls).toHaveLength(6);
    expect(calls.some((b) => b.model.includes('deepseek'))).toBe(false);
    expect(chainInfo.failedAttempts).toBe(1); // деградация случилась, второе звено тоже упало
    // FIX-F1 (QA): упавшая модель НЕ считается fallback'ом — роль никто не
    // исполнил, ложной fallbackModel в [gen-digest] быть не должно.
    expect(chainInfo.fallbackModel).toBeNull();
    // model — последняя попытка (для журнала AgentRun), это ок.
    expect(chainInfo.model).toBe('qwen/qwen3.6-flash');
  });

  test('kill-switch off → старое поведение: только первичная модель, без второго звена', async () => {
    process.env.ROUTERAI_FALLBACK_CHAIN = 'off';
    const { fetchMock, calls } = modelAwareFetch({ 'qwen/qwen3.7-plus': 'network' });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'factchecker', chainInfo);

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(calls.map((b) => b.model)).toEqual([
      'qwen/qwen3.7-plus', 'qwen/qwen3.7-plus', 'qwen/qwen3.7-plus',
    ]);
    expect(chainInfo.model).toBe('qwen/qwen3.7-plus');
    expect(chainInfo.fallbackModel).toBeNull();
    expect(chainInfo.failedAttempts).toBe(0);
  });

  test('generation→standard звено: article-author падает на qwen3.6-flash → deepseek-v4-flash исполняет роль', async () => {
    const { fetchMock, calls } = modelAwareFetch({ 'qwen/qwen3.6-flash': 'network' });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'article-author', context: { articleLength: 20000 } });
    expect(payload.model).toBe('qwen/qwen3.6-flash');
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'article-author', chainInfo);

    expect(error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(calls.map((b) => b.model)).toEqual([
      'qwen/qwen3.6-flash', 'qwen/qwen3.6-flash', 'qwen/qwen3.6-flash',
      'deepseek/deepseek-v4-flash',
    ]);
    expect(chainInfo.model).toBe('deepseek/deepseek-v4-flash');
    expect(chainInfo.fallbackModel).toBe('deepseek/deepseek-v4-flash');
  });

  test('HTTP 200 с пустым контентом на первичной → деградация (успех роли = содержательный контент)', async () => {
    const { fetchMock, calls } = modelAwareFetch({ 'qwen/qwen3.7-plus': 'empty' });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'factchecker', chainInfo);

    expect(error).toBeUndefined();
    expect(result.status).toBe(200);
    // HTTP 200 не ретраится внутри callRouterAI → по одному вызову на звено.
    expect(calls.map((b) => b.model)).toEqual(['qwen/qwen3.7-plus', 'qwen/qwen3.6-flash']);
    expect(chainInfo.model).toBe('qwen/qwen3.6-flash');
  });

  test('thinking-флаг и max_tokens роли сохраняются на звене деградации', async () => {
    const { fetchMock, calls } = modelAwareFetch({ 'qwen/qwen3.7-plus': 'network' });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    // Явный флаг роли (как NO_THINKING_ROLES): должен дожить до звена деградации.
    payload.enable_thinking = false;
    expect(payload.max_tokens).toBe(14000);
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    await runChain(payload, 'factchecker', chainInfo);

    const degradedBody = calls[3];
    expect(degradedBody.model).toBe('qwen/qwen3.6-flash');
    expect(degradedBody.enable_thinking).toBe(false);
    expect(degradedBody.max_tokens).toBe(14000);
  });

  test('auth 401 на первичной → цепочка НЕ включается (смена модели не лечит ключ/баланс)', async () => {
    const { fetchMock, calls } = modelAwareFetch({ 'qwen/qwen3.7-plus': 401 });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'factchecker', chainInfo);

    expect(error).toBeUndefined();
    expect(result.status).toBe(401); // воркер сам разрулит unrecoverable, как до W4.1
    expect(calls).toHaveLength(1);
    expect(chainInfo.model).toBe('qwen/qwen3.7-plus');
  });

  test('первичная модель отвечает сразу → один вызов, chainInfo без деградации', async () => {
    const { fetchMock, calls } = modelAwareFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    const { result, error } = await runChain(payload, 'factchecker', chainInfo);

    expect(error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(chainInfo.model).toBe('qwen/qwen3.7-plus');
    expect(chainInfo.fallbackModel).toBeNull();
    expect(chainInfo.failedAttempts).toBe(0);
  });

  test('FIX-F1: успех на 2-м звене → fallbackModel = УСПЕШНО исполнившая модель (не «любая деградация»)', async () => {
    const { fetchMock } = modelAwareFetch({ 'qwen/qwen3.7-plus': 'network' });
    vi.stubGlobal('fetch', fetchMock);

    const payload = buildRoleExecutionPayload({ roleId: 'factchecker' });
    const chainInfo = { model: payload.model, fallbackModel: null, failedAttempts: 0 };

    await runChain(payload, 'factchecker', chainInfo);

    expect(chainInfo.status).toBeUndefined(); // chainInfo не несёт лишних полей
    expect(chainInfo.fallbackModel).toBe('qwen/qwen3.6-flash'); // она реально исполнила роль
  });
});

/* ======================================================================
 * FIX-F2 (QA W4): пустая строка env (КЛЮЧ= без значения) давала Number('')=0
 * → «0 ретраев» / мгновенный 1с-таймаут вместо дефолтов. Единый хелпер
 * resolveEnvNumber: дефолт при null/undefined/''/NaN; валидные числа
 * (вкл. легальный 0) проходят.
 * ==================================================================== */
describe('resolveEnvNumber — единый env-гвард (FIX-F2)', () => {
  test('null/undefined/пустая/пробельная строка/NaN/мусор → дефолт', () => {
    expect(resolveEnvNumber(undefined, 2)).toBe(2);
    expect(resolveEnvNumber(null, 2)).toBe(2);
    expect(resolveEnvNumber('', 2)).toBe(2);
    expect(resolveEnvNumber('   ', 2)).toBe(2);
    expect(resolveEnvNumber('не-число', 2)).toBe(2);
    expect(resolveEnvNumber('NaN', 2)).toBe(2);
    expect(resolveEnvNumber('Infinity', 2)).toBe(2);
  });

  test('валидные числа проходят (включая легальный 0 и отрицательные)', () => {
    expect(resolveEnvNumber('0', 2)).toBe(0);
    expect(resolveEnvNumber('5', 2)).toBe(5);
    expect(resolveEnvNumber('1500000', 2)).toBe(1_500_000);
    expect(resolveEnvNumber(7, 2)).toBe(7);
    expect(resolveEnvNumber(' 42 ', 2)).toBe(42); // пробелы вокруг числа ок
  });
});

describe('callRouterAI — FIX-F2: пустые env-строки → дефолты W1.5, а не 0', () => {
  let savedRetries;
  let savedTimeout;

  const basePayload = {
    model: 'qwen/qwen3.6-flash',
    messages: [{ role: 'user', content: 'тест' }],
    stream: false,
  };

  /** fetch, который никогда не отвечает сам и реджектится только по abort. */
  const hangingFetch = vi.fn((_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })
  );

  beforeEach(() => {
    vi.useFakeTimers();
    savedRetries = process.env.ROUTERAI_MAX_RETRIES;
    savedTimeout = process.env.ROUTERAI_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (savedRetries === undefined) delete process.env.ROUTERAI_MAX_RETRIES;
    else process.env.ROUTERAI_MAX_RETRIES = savedRetries;
    if (savedTimeout === undefined) delete process.env.ROUTERAI_TIMEOUT_MS;
    else process.env.ROUTERAI_TIMEOUT_MS = savedTimeout;
  });

  test("ROUTERAI_MAX_RETRIES='' и ROUTERAI_TIMEOUT_MS='' → дефолты (3 попытки × 180с), не 1 попытка × 1с", async () => {
    process.env.ROUTERAI_MAX_RETRIES = ''; // Number('')=0 → без гварда была бы 1 попытка
    process.env.ROUTERAI_TIMEOUT_MS = ''; // Number('')=0 → без гварда мгновенный abort
    vi.stubGlobal('fetch', hangingFetch);

    const { callRouterAI } = await import('../../server/agent-role-execution.mjs');
    const promise = callRouterAI(basePayload).catch((e) => e);

    // Таймаут дефолтен (180с): к 179-й секунде ПЕРВАЯ попытка ещё жива —
    // при сломанном 1с-таймауте к этому моменту все попытки уже исчерпались.
    await vi.advanceTimersByTimeAsync(179_000);
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    // Ретраи дефолтны (2 → 3 попытки всего).
    await vi.advanceTimersByTimeAsync(500_000);
    const err = await promise;
    expect(hangingFetch).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
  });
});

/* ======================================================================
 * B2 (2026-08-25): каталог специалистов автору + режимы голоса + userNotes.
 * Инварианты: И1 — автор НЕ ставит ссылки сам (каталог автора БЕЗ pageUrl);
 * И3 — упоминать можно ТОЛЬКО реальные имена из каталога источника.
 * ==================================================================== */

const B2_SPECIALISTS = [
  { fullName: 'Иванова Анна Сергеевна', position: 'Эксперт по подбору решений', specialization: 'Управление ассортиментом', credentials: 'Кандидат технических наук, стаж 15 лет', pageUrl: 'https://company.example/experts/ivanova' },
  { fullName: 'Петров Пётр Петрович', position: 'Инженер по интеграции', specialization: 'Автоматизация процессов', credentials: 'Стаж 12 лет', pageUrl: 'https://company.example/experts/petrov' },
  { fullName: 'Сидорова Мария Ивановна', position: 'Эксперт по качеству', specialization: 'Контроль качества сервиса', credentials: '', pageUrl: '' },
];

describe('B2 — каталог специалистов в payload article-author', () => {
  const userPromptOf = (opts) =>
    buildRoleExecutionMessages(opts).find((m) => m?.role === 'user').content;

  it('автор получает каталог: реальные ФИО из каталога источника', () => {
    const prompt = userPromptOf({ roleId: 'article-author', catalogSpecialists: B2_SPECIALISTS });
    expect(prompt).toContain('Иванова Анна Сергеевна');
    expect(prompt).toContain('Петров Пётр Петрович');
    expect(prompt).toContain('Сидорова Мария Ивановна');
  });

  it('И1: каталог автора БЕЗ pageUrl и БЕЗ регалий (компакт: ФИО + должность + специализация)', () => {
    const prompt = userPromptOf({ roleId: 'article-author', catalogSpecialists: B2_SPECIALISTS });
    expect(prompt).not.toContain('pageUrl');
    expect(prompt).not.toContain('company.example/experts');
    expect(prompt).not.toContain('регалии');
    expect(prompt).not.toContain('Кандидат технических наук');
    expect(prompt).toContain('Эксперт по подбору решений');
    expect(prompt).toContain('Управление ассортиментом');
  });

  it('компакт автора не содержит услуг (экономия payload), полный формат фактчекера не изменился', () => {
    const services = [{ name: 'Программа лояльности', url: 'https://company.example/s', description: 'Бонусы за повторные покупки' }];
    const author = userPromptOf({ roleId: 'article-author', catalogServices: services, catalogSpecialists: B2_SPECIALISTS });
    expect(author).not.toContain('Программа лояльности');
    expect(author).not.toContain('КАТАЛОГ ИСТОЧНИКА');

    const fc = userPromptOf({ roleId: 'factchecker', catalogServices: services, catalogSpecialists: B2_SPECIALISTS });
    expect(fc).toContain('КАТАЛОГ ИСТОЧНИКА');
    expect(fc).toContain('Программа лояльности');
    expect(fc).toContain('регалии: Кандидат технических наук');
  });

  it('прочие роли каталог по-прежнему НЕ получают (payload не растёт)', () => {
    for (const roleId of ['brief-preparer', 'structure-architect', 'seo-reviewer', 'humanizer']) {
      expect(userPromptOf({ roleId, catalogSpecialists: B2_SPECIALISTS })).not.toContain('Иванова Анна Сергеевна');
    }
  });
});

describe('B2 — ГОЛОС ПОВЕСТВОВАНИЯ: динамический режим-маркер автора', () => {
  const userPromptOf = (opts) =>
    buildRoleExecutionMessages(opts).find((m) => m?.role === 'user').content;

  it('специалист ВЫБРАН: режим-маркер + вставки 2–3 от первого лица по шаблону «💡 …»', () => {
    const prompt = userPromptOf({
      roleId: 'article-author',
      specialistName: 'Иванова Анна Сергеевна',
      specialistPosition: 'Эксперт по подбору решений',
      catalogSpecialists: B2_SPECIALISTS,
    });
    expect(prompt).toContain('ГОЛОС ПОВЕСТВОВАНИЯ — активный режим: СПЕЦИАЛИСТ ВЫБРАН');
    expect(prompt).toMatch(/2–3 короткие вставки от первого лица выбранного специалиста/u);
    expect(prompt).toMatch(/💡 \{Имя\} \{Отчество\}, \{должность\}: \{рекомендация\}/u);
    expect(prompt).not.toContain('упомяни 2–4');
  });

  it('специалист НЕ выбран, каталог ≥2: упомяни 2–4 РАЗНЫХ реальных специалистов, БЕЗ ссылок', () => {
    const prompt = userPromptOf({
      roleId: 'article-author',
      catalogSpecialists: B2_SPECIALISTS,
    });
    expect(prompt).toContain('ГОЛОС ПОВЕСТВОВАНИЯ — активный режим: СПЕЦИАЛИСТ НЕ ВЫБРАН');
    expect(prompt).toMatch(/упомяни 2–4 РАЗНЫХ специалистов из каталога/iu);
    expect(prompt).toMatch(/только реальные имена из каталога, НЕ выдумывай/u);
    expect(prompt).toMatch(/markdown-ссылки на специалистов НЕ ставь[^\n]*их добавит система/u);
    expect(prompt).toContain('продвигай компанию');
  });

  it('специалист НЕ выбран и каталог <2 специалистов: без инструкции упоминаний (не выдумывай)', () => {
    const prompt = userPromptOf({
      roleId: 'article-author',
      catalogSpecialists: [B2_SPECIALISTS[0]],
    });
    expect(prompt).toContain('СПЕЦИАЛИСТ НЕ ВЫБРАН');
    expect(prompt).not.toContain('упомяни 2–4');
    expect(prompt).toMatch(/никого по имени не выдумывай/u);
  });

  it('режим выбирается по truthiness specialistName (пустая строка = не выбран)', () => {
    const prompt = userPromptOf({
      roleId: 'article-author',
      specialistName: '   ',
      catalogSpecialists: B2_SPECIALISTS,
    });
    expect(prompt).toContain('СПЕЦИАЛИСТ НЕ ВЫБРАН');
  });

  it('маркер режима получает ТОЛЬКО article-author', () => {
    const prompt = userPromptOf({
      roleId: 'factchecker',
      specialistName: 'Иванова Анна Сергеевна',
    });
    expect(prompt).not.toContain('ГОЛОС ПОВЕСТВОВАНИЯ — активный режим');
  });
});

describe('B3 — userNotes («Уточнения» владельца) в payload автора и брифолога', () => {
  const userPromptOf = (opts) =>
    buildRoleExecutionMessages(opts).find((m) => m?.role === 'user').content;
  const NOTES = 'Ультраформер нужно выставить в выигрышном свете и продавать именно его';

  it('article-author + userNotes: блок «ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА» с текстом-цитатой', () => {
    const prompt = userPromptOf({ roleId: 'article-author', userNotes: NOTES });
    expect(prompt).toContain('ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА');
    expect(prompt).toContain(`«${NOTES}»`);
    expect(prompt).toMatch(/приоритетны для акцентов и подачи; НЕ отменяют профессиональную корректность, факты и SEO-ядро/u);
  });

  it('brief-preparer тоже видит userNotes (угол подачи задаётся уже в брифе)', () => {
    const prompt = userPromptOf({ roleId: 'brief-preparer', userNotes: NOTES });
    expect(prompt).toContain('ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА');
    expect(prompt).toContain(NOTES);
  });

  it('без userNotes блока нет (пустая строка/пробелы/undefined)', () => {
    for (const empty of [undefined, '', '   ']) {
      expect(userPromptOf({ roleId: 'article-author', userNotes: empty })).not.toContain('ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА');
    }
  });

  it('прочие роли userNotes НЕ получают', () => {
    for (const roleId of ['topic-selector', 'factchecker', 'seo-reviewer', 'humanizer']) {
      expect(userPromptOf({ roleId, userNotes: NOTES })).not.toContain('ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА');
    }
  });

  it('buildRoleExecutionPayload: context.userNotes доезжает до user-сообщения автора', () => {
    const payload = buildRoleExecutionPayload({
      roleId: 'article-author',
      context: { userNotes: NOTES },
    });
    const userMessage = payload.messages.find((m) => m?.role === 'user');
    expect(userMessage.content).toContain('ОСОБЫЕ УКАЗАНИЯ ВЛАДЕЛЬЦА');
    expect(userMessage.content).toContain(NOTES);
  });
});
