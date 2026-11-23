import { describe, it, expect, vi } from 'vitest';
import {
  generateUnusualFaqMarkdown,
  hasUnusualFaqSection,
} from '../../server/lib/faq-generator.mjs';

/**
 * P4 (2026-08-16): FAQ-блок «10 необычных вопросов».
 *
 * Либа — по образцу topic-breakdown.mjs: служебный SEO-вызов callRouterAI
 * (НЕ роль, без контракта), модель резолвится как generation-tier qwen
 * (НЕ resolveRoleModel — он бросает на служебных вызовах), явный
 * enable_thinking:false. Для тестов callFn инъектится напрямую.
 */

const TOPIC = 'Имплантация зубов';

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    question: `Неочевидный вопрос №${i + 1}?`,
    answer: `Короткий ответ №${i + 1}. Из двух-трёх предложений с обоснованием.`,
  }));
}

/** Мок callRouterAI-ответа: OpenAI-shape { data: { choices: [...] } }. */
function routerResponse(content) {
  return { status: 200, data: { choices: [{ message: { content } }] } };
}

describe('generateUnusualFaqMarkdown — happy path', () => {
  it('10 items: markdown c «## 10 необычных вопросов: {topic}» и 10 «### »-вопросами', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));

    const md = await generateUnusualFaqMarkdown(
      { topic: TOPIC, h1: 'Имплантация зубов: гид', headings: ['Введение', 'Этапы'], conclusionExcerpt: 'Итог статьи.' },
      { callFn }
    );

    expect(md).toContain(`## 10 необычных вопросов: ${TOPIC}`);
    const questions = md.split('\n').filter((l) => l.startsWith('### '));
    expect(questions).toHaveLength(10);
    expect(questions[0]).toBe('### Неочевидный вопрос №1?');
    // Ответ присутствует абзацем под вопросом.
    expect(md).toContain('Короткий ответ №1. Из двух-трёх предложений с обоснованием.');
    // Заголовок секции — первый (H2 до всех H3-вопросов).
    expect(md.indexOf('## 10 необычных вопросов')).toBeLessThan(md.indexOf('### '));
  });

  it('вызов: модель qwen generation-tier, enable_thinking:false, промпт SEO-копирайтера, JSON {items}', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));

    await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });

    expect(callFn).toHaveBeenCalledTimes(1);
    const payload = callFn.mock.calls[0][0];
    expect(payload.model.toLowerCase()).toContain('qwen');
    expect(payload.enable_thinking).toBe(false);
    const system = payload.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = payload.messages.find((m) => m.role === 'user')?.content ?? '';
    // Промпт универсальный: роль «SEO-копирайтер и эксперт отрасли» — без отраслевой привязки.
    expect(system).toMatch(/SEO-копирайтер/iu);
    expect(system).not.toMatch(/медицинск[а-яё]*/iu);
    expect(system).toMatch(/10 необычн/i);
    expect(system).toMatch(/"items"/);
    // Контекст компактен: тема и заголовки уходят в user-сообщение.
    expect(user).toContain(TOPIC);
  });

  it('контекст вызова: topic + H1 + заголовки + отрывок заключения в user-сообщении', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(9) })));

    await generateUnusualFaqMarkdown(
      {
        topic: TOPIC,
        h1: 'Имплантация зубов: полное руководство',
        headings: ['Введение', 'Этапы лечения', 'Реабилитация'],
        conclusionExcerpt: 'Имплантация — предсказуемый метод при правильном планировании.',
      },
      { callFn }
    );

    const user = callFn.mock.calls[0][0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('Имплантация зубов: полное руководство');
    expect(user).toContain('Этапы лечения');
    expect(user).toContain('Имплантация — предсказуемый метод');
  });
});

describe('generateUnusualFaqMarkdown — валидация и деградация', () => {
  it('JSON в ```json-обёртке парсится (LLM любит оборачивать)', async () => {
    const wrapped = '```json\n' + JSON.stringify({ items: makeItems(10) }) + '\n```';
    const callFn = vi.fn().mockResolvedValue(routerResponse(wrapped));

    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toContain(`## 10 необычных вопросов: ${TOPIC}`);
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(10);
  });

  it('мусор вместо JSON → пустая строка, НЕ бросает', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse('Извините, я не могу...'));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toBe('');
  });

  it('callFn бросил → пустая строка, НЕ бросает (fail-safe: статья живёт без FAQ)', async () => {
    const callFn = vi.fn().mockRejectedValue(new Error('502 fetch failed'));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toBe('');
  });

  it('7 items (<8) → WARN-пропуск: пустая строка, вызова рендера нет', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(7) })));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toBe('');
  });

  it('13 items (>12) → обрезка до 10', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(13) })));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(10);
  });

  it('dedupe по нормализованному вопросу: дубли не попадают в вывод', async () => {
    const items = [
      ...makeItems(9),
      { question: '  неочевидный вопрос №1?  ', answer: 'Дубль-ответ.' }, // dupe №1 (регистр/пробелы)
    ];
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items })));

    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    const questions = md.split('\n').filter((l) => l.startsWith('### '));
    expect(questions).toHaveLength(9);
    expect(questions.filter((q) => q === '### Неочевидный вопрос №1?')).toHaveLength(1);
  });

  it('dedupe до <8 уникальных → WARN-пропуск', async () => {
    const items = [
      ...makeItems(6),
      { question: 'Неочевидный вопрос №1?', answer: 'Дубль.' },
      { question: 'неочевидный вопрос №2?', answer: 'Дубль.' },
      { question: 'Неочевидный вопрос №3?', answer: 'Дубль.' },
      { question: 'Неочевидный вопрос №4?', answer: 'Дубль.' },
    ];
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items })));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toBe('');
  });

  it('битые items (без question/answer) фильтруются до подсчёта', async () => {
    const items = [...makeItems(9), { question: 'Без ответа?' }, { answer: 'Без вопроса.' }, null];
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items })));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(9);
  });

  it('пустая тема → пустая строка БЕЗ вызова модели', async () => {
    const callFn = vi.fn();
    const md = await generateUnusualFaqMarkdown({ topic: '   ' }, { callFn });
    expect(md).toBe('');
    expect(callFn).not.toHaveBeenCalled();
  });

  it('topic подставляется как есть после дветочия — БЕЗ склонения (W2/B2)', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(8) })));
    const md = await generateUnusualFaqMarkdown({ topic: 'Чистка зубов: гид 2026' }, { callFn });
    // Формулировка без падежной зависимости: «…вопросов: {тема}» (именительный).
    expect(md).toContain('## 10 необычных вопросов: Чистка зубов: гид 2026');
    expect(md).not.toMatch(/вопросов про Чистка/u);
  });
});

describe('generateUnusualFaqMarkdown — FAQ-ретраи (F1, quality-final 2026-08-21)', () => {
  // e2e-факт: при деградации LLM единственный вызов падал (timeout/502) →
  // статья выходила без FAQ. Теперь 2 попытки: вторая — с урезанным
  // таймаутом 60с (per-call override callRouterAI). Обе упали → прежний
  // fail-safe WARN, статья без FAQ.

  it('1-я попытка throw, 2-я ок → FAQ вставлен; 2-й вызов с таймаутом 60с', async () => {
    const callFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout (AbortError)'))
      .mockResolvedValueOnce(routerResponse(JSON.stringify({ items: makeItems(10) })));

    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });

    expect(md).toContain(`## 10 необычных вопросов: ${TOPIC}`);
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(10);
    expect(callFn).toHaveBeenCalledTimes(2);
    // Вторая попытка — урезанный таймаут (per-call override callRouterAI).
    expect(callFn.mock.calls[1][1]).toEqual({ timeoutMs: 60_000 });
    // Первая — без override (дефолтный env-таймаут).
    expect(callFn.mock.calls[0][1]).toBeUndefined();
  });

  it('обе попытки throw → пустая строка, НЕ бросает (статья жива без FAQ)', async () => {
    const callFn = vi.fn().mockRejectedValue(new Error('502 fetch failed'));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toBe('');
    expect(callFn).toHaveBeenCalledTimes(2);
  });

  it('1-я попытка — мусор вместо JSON → ретрай, 2-я валидная → FAQ вставлен', async () => {
    const callFn = vi
      .fn()
      .mockResolvedValueOnce(routerResponse('Извините, не могу помочь.'))
      .mockResolvedValueOnce(routerResponse(JSON.stringify({ items: makeItems(10) })));

    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toContain(`## 10 необычных вопросов: ${TOPIC}`);
    expect(callFn).toHaveBeenCalledTimes(2);
  });

  it('1-я попытка — 7 валидных вопросов (<8) → ретрай, 2-я 10 → FAQ вставлен', async () => {
    const callFn = vi
      .fn()
      .mockResolvedValueOnce(routerResponse(JSON.stringify({ items: makeItems(7) })))
      .mockResolvedValueOnce(routerResponse(JSON.stringify({ items: makeItems(10) })));

    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(10);
    expect(callFn).toHaveBeenCalledTimes(2);
  });

  it('обе попытки мало валидных → пустая строка (WARN-пропуск)', async () => {
    const callFn = vi
      .fn()
      .mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(7) })));
    const md = await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(md).toBe('');
    expect(callFn).toHaveBeenCalledTimes(2);
  });

  it('happy path: 1-я попытка успешна → второго вызова НЕТ', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));
    await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });
    expect(callFn).toHaveBeenCalledTimes(1);
  });
});

describe('generateUnusualFaqMarkdown — ключи SEO-ядра в вопросах (W2/B2, seo-round)', () => {
  // Норматив SEO 4.1: ≥40% вопросов с ключом. Контракт с Dev-A: воркер кладёт
  // в faqContext.keywords топ-12 wordstat-ключей (string[]). Инструкция
  // добавляется в user-сообщение ТОЛЬКО при непустом списке.

  const KEYS = [
    'лазерная эпиляция интимных зон',
    'лазерная эпиляция зоны бикини',
    'интимная лазерная эпиляция цена',
    'больно ли делать лазерную эпиляцию',
    'лазерная эпиляция сколько сеансов',
  ];

  function userMessageOf(callFn) {
    return callFn.mock.calls[0][0].messages.find((m) => m.role === 'user')?.content ?? '';
  }

  it('keywords переданы → промпт содержит ≥4 упоминания ключей из списка + инструкция 40%', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));
    await generateUnusualFaqMarkdown({ topic: TOPIC, keywords: KEYS }, { callFn });

    const user = userMessageOf(callFn);
    const mentioned = KEYS.filter((k) => user.includes(k));
    expect(mentioned.length).toBeGreaterThanOrEqual(4);
    expect(user).toContain('Ключевые фразы для вопросов (SEO-ядро статьи)');
    expect(user).toMatch(/минимум 40% вопросов \(4 из 10\)/iu);
    expect(user).toMatch(/естественно/iu);
    expect(user).toMatch(/не SEO-мусором/iu);
  });

  it('keywords переданы → инструкция идёт в user-сообщение (system-промпт неизменен)', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));
    await generateUnusualFaqMarkdown({ topic: TOPIC, keywords: KEYS }, { callFn });

    const system = callFn.mock.calls[0][0].messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).not.toContain('SEO-ядро');
    expect(userMessageOf(callFn)).toContain('SEO-ядро');
  });

  it('keywords отсутствуют → прежний промпт: блока ключей и инструкции 40% НЕТ', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));
    await generateUnusualFaqMarkdown({ topic: TOPIC }, { callFn });

    const user = userMessageOf(callFn);
    expect(user).not.toContain('SEO-ядро');
    expect(user).not.toMatch(/40% вопросов/iu);
    // Прежняя структура user-сообщения жива.
    expect(user).toContain(`Тема статьи: ${TOPIC}`);
    expect(user).toContain('Сгенерируй РОВНО 10 необычных вопросов');
  });

  it('keywords пустой/мусорный массив → инструкции нет (как без keywords)', async () => {
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));
    await generateUnusualFaqMarkdown({ topic: TOPIC, keywords: ['', '   ', null, 42] }, { callFn });
    expect(userMessageOf(callFn)).not.toContain('SEO-ядро');
  });

  it('больше 12 ключей → в промпт идут только первые 12 (compact-контракт)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `ключевая фраза номер ${i + 1}`);
    const callFn = vi.fn().mockResolvedValue(routerResponse(JSON.stringify({ items: makeItems(10) })));
    await generateUnusualFaqMarkdown({ topic: TOPIC, keywords: many }, { callFn });

    const user = userMessageOf(callFn);
    expect(user).toContain('ключевая фраза номер 12');
    expect(user).not.toContain('ключевая фраза номер 13');
  });
});

describe('hasUnusualFaqSection — идемпотентность-гард (BullMQ retry)', () => {
  it('сгенерированный FAQ-заголовок детектится (новый формат с двоеточием)', () => {
    expect(hasUnusualFaqSection('# Тема\n\nТекст.\n\n## 10 необычных вопросов: Тема\n\n### В?\n\nО.')).toBe(true);
  });

  it('вариации формулировки детектятся («необычный вопрос», «вопросы по теме»)', () => {
    expect(hasUnusualFaqSection('## Самые необычные вопросы клиентов')).toBe(true);
    expect(hasUnusualFaqSection('## Частые вопросы по теме имплантации')).toBe(true);
  });

  it('обычный FAQ/контент НЕ детектится (нет ложного срабатывания)', () => {
    expect(hasUnusualFaqSection('## Часто задаваемые вопросы (FAQ)')).toBe(false);
    expect(hasUnusualFaqSection('# Имплантация\n\nТекст о вопросах и ответах.')).toBe(false);
    expect(hasUnusualFaqSection('')).toBe(false);
    expect(hasUnusualFaqSection(null)).toBe(false);
  });

  // Tech-lead review (2026-08-16): гвард смотрит ТОЛЬКО в заголовки — фраза
  // «вопросы по теме» в теле статьи (обычный русский оборот) раньше давала
  // ложное срабатывание и молча убивала вставку FAQ-блока.
  it('фраза «вопросы по теме» в ТЕЛЕ текста (не в заголовке) НЕ детектится', () => {
    expect(
      hasUnusualFaqSection(
        '# Имплантация\n\nРассмотрим частые вопросы по теме имплантации отдельно.\n\n## Заключение\n\nИтог.'
      )
    ).toBe(false);
  });

  it('заголовок необычных вопросов внутри code-fence НЕ детектится', () => {
    expect(
      hasUnusualFaqSection('# Тема\n\n```\n## 10 необычных вопросов: Тема\n```\n\nТекст.')
    ).toBe(false);
  });
});
