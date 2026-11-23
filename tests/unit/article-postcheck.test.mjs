import { describe, it, expect, afterEach } from 'vitest';
import {
  runArticlePostcheck,
  POSTCHECK_AGENT_NAME,
  POSTCHECK_RULE_IDS,
  resolvePostcheckMode,
  keyUsedInText,
} from '../../server/lib/article-postcheck.mjs';
import { mergeEmptySections } from '../../server/article-post-processor.mjs';
// P2-2: детерминированный блок записи (fixture = прод-блок).
import { buildFormRecommendationBlock } from '../../server/lib/objection-block.mjs';

/**
 * W2.1 (2026-08-17, stabilization): постпродакшен-валидатор финального markdown.
 *
 * Контракт (ЗАМОРОЖЕН, читают Dev-B / фронт W3):
 *   runArticlePostcheck({ markdown, html, context }) → {
 *     version: 1,
 *     verdict: 'ok' | 'warn' | 'fail',
 *     rules: [{ id, block, severity, status, message, details? }],
 *     summary: { pass, fail, skipped }
 *   }
 *
 * verdict: fail = есть blocker-fail ИЛИ ≥2 major-fail; warn = ровно 1 major-fail
 * или любой minor-fail; ok = иначе. Режим ({ mode }) НИЧЕГО не меняет внутри —
 * enforce-логика живёт снаружи (worker).
 */

/* ── Фикстуры ────────────────────────────────────────────────────────── */

/** FAQ-блок: n вопросов H3 с непустыми ответами. */
function faqBlock(n = 10, topic = 'Имплантация зубов') {
  const lines = [`## 10 необычных вопросов про ${topic}`, ''];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`### Неочевидный вопрос №${i} про процедуру?`, '', `Короткий честный ответ №${i} с обоснованием.`, '');
  }
  return lines.join('\n');
}

/** P2-2: детерминированный блок записи (реальный прод-блок из objection-block). */
function formRecBlock(seed = 'fixture-seed') {
  return buildFormRecommendationBlock('Example Company', seed).markdown;
}

/** Базовый «чистый» документ: 1 H1, H2 без пропусков, FAQ 8–12, ссылка компании,
 *  блок записи (P2-2: конвейер вставляет его до постчека, §1.3). */
function cleanDoc({ faqQuestions = 10 } = {}) {
  return [
    '# Имплантация зубов: полное руководство',
    '',
    '## Введение',
    '',
    'Имплантация — современный метод восстановления утраченных зубов. Титановый [винт](https://example.test/services/implant) интегрируется в костную ткань.',
    '',
    '## Этапы лечения',
    '',
    'Лечение состоит из нескольких последовательных этапов, каждый из которых важен для итогового результата приживления.',
    '',
    '- Консультация и планирование',
    '- Хирургический этап установки импланта',
    '',
    '## Реабилитация',
    '',
    'После операции следует соблюдать рекомендации врача. Процесс приживления занимает от 3 до 6 месяцев.',
    '',
    formRecBlock(),
    '',
    faqBlock(faqQuestions),
    '',
  ].join('\n');
}

/** Базовый контекст: все данные в наличии, все «процессные» флаги зелёные. */
function cleanContext(overrides = {}) {
  return {
    topic: 'Имплантация зубов',
    // P2-2: базовый документ вырос на блок записи (~640 симв.) — target поднят
    // 1000 → 2000, чтобы BODY-LENGTH-RANGE остывался в диапазоне (~0.97×).
    targetLength: 2000,
    specialistId: null,
    hasSuccessfulFactcheckRun: true,
    finalizedVia: 'normal',
    structuredOutputs: {
      'article-author': { articleMarkdownRu: '# черновик' },
      factchecker: { checkedArticleMarkdownRu: '# проверено', reviewRequired: false, forbiddenClaimsRu: [] },
    },
    // M2: ключи ядра — только semanticCore (частотный источник убран);
    // «процедура» держит FAQ-KEYS-SHARE активным и зелёным на чистой фикстуре.
    semanticCore: {
      mainQueryRu: 'имплантация зубов',
      queryClustersRu: [{ clusterRu: 'Этапы', queriesRu: ['этапы имплантации'] }],
      lsiTermsRu: ['титановый винт', 'процедура'],
    },
    formatRuSections: [{ headingRu: 'Введение' }, { headingRu: 'Этапы лечения' }],
    timings: { 'Агент автора': 120_000 },
    siteDomains: ['example.test'],
    ...overrides,
  };
}

/** Запуск с чистой базой + переопределения markdown/html/context. */
function run(markdownOverrides = {}, contextOverrides = {}, htmlOverrides = undefined) {
  const markdown = markdownOverrides.markdown ?? cleanDoc();
  const html = htmlOverrides ?? `<h1>rendered</h1><p>${markdown.length}</p>`;
  return runArticlePostcheck(
    { markdown, html, context: cleanContext(contextOverrides) },
  );
}

function rule(report, id) {
  return report.rules.find((r) => r.id === id);
}

/* ── Контракт ────────────────────────────────────────────────────────── */

describe('article-postcheck — замороженный контракт отчёта', () => {
  it('version=1, verdict ∈ ok|warn|fail, summary {pass,fail,skipped}', () => {
    const report = run();
    expect(report.version).toBe(1);
    expect(['ok', 'warn', 'fail']).toContain(report.verdict);
    expect(report.summary).toHaveProperty('pass');
    expect(report.summary).toHaveProperty('fail');
    expect(report.summary).toHaveProperty('skipped');
    expect(report.summary.pass + report.summary.fail + report.summary.skipped).toBe(report.rules.length);
  });

  it('каждое правило: id/block/severity/status/message, корректные enums', () => {
    const report = run();
    for (const r of report.rules) {
      expect(typeof r.id).toBe('string');
      expect(['head', 'seo', 'body', 'faq', 'sig', 'links', 'process']).toContain(r.block);
      expect(['blocker', 'major', 'minor']).toContain(r.severity);
      expect(['pass', 'fail', 'skipped']).toContain(r.status);
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('сообщения правил — нейтральная отраслевая лексика (универсальность генератора)', () => {
    // Нейтральная отрасль в фикстуре: сообщения правил не должны содержать
    // слов одной отрасли (продуктовая лексика), даже если тема статьи иная.
    const neutralDoc = [
      '# Настройка CRM: полное руководство', '',
      '## Введение', '',
      'Внедрение CRM состоит из нескольких последовательных этапов, каждый из которых важен для итогового результата.', '',
      '- Консультация и планирование',
      '- Настройка интеграций', '',
      '## Сопровождение', '',
      'После запуска следует соблюдать рекомендации специалиста. Переход занимает от 3 до 6 месяцев.', '',
      formRecBlock(), '',
      faqBlock(10, 'настройку CRM'), '',
    ].join('\n');
    const report = runArticlePostcheck(
      {
        markdown: neutralDoc,
        html: '<p>x</p>',
        context: cleanContext({
          topic: 'Настройка CRM',
          semanticCore: {
            mainQueryRu: 'настройка crm',
            queryClustersRu: [{ clusterRu: 'Этапы', queriesRu: ['этапы внедрения'] }],
            lsiTermsRu: ['интеграция', 'внедрение'],
          },
          formatRuSections: [{ headingRu: 'Введение' }, { headingRu: 'Этапы настройки' }],
        }),
      },
    );
    for (const r of report.rules) {
      expect(r.message, `${r.id}: ${r.message}`).not.toMatch(
        /медицин|врач|пациент|диагност|процедур|имплант|стоматолог/i,
      );
    }
  });

  it('ровно 39 правил с замороженным набором id (36 + P1a + P2: OBJ-FORMAT-HONORED, FORM-REC-PRESENT)', () => {
    const report = run();
    expect(report.rules.map((r) => r.id).sort()).toEqual([...POSTCHECK_RULE_IDS].sort());
    expect(POSTCHECK_RULE_IDS).toHaveLength(39);
  });

  it('cleanDoc → все правила pass или skipped, verdict ok', () => {
    const report = run();
    expect(report.rules.filter((r) => r.status === 'fail')).toEqual([]);
    expect(report.verdict).toBe('ok');
  });

  it('mode не влияет на вычисления: report/enforce/undefined дают одинаковый отчёт', () => {
    const md = cleanDoc() + '\nПроцедура требует подхода {{src:3}} к каждому пациенту.';
    const base = { markdown: md, html: '<p>x</p>', context: cleanContext() };
    const r1 = runArticlePostcheck(base);
    const r2 = runArticlePostcheck(base, { mode: 'report' });
    const r3 = runArticlePostcheck(base, { mode: 'enforce' });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  it('пустой/некорректный ввод не бросает: все правила детерминированы', () => {
    const report = runArticlePostcheck({ markdown: '', html: '', context: {} });
    expect(report.version).toBe(1);
    expect(['ok', 'warn', 'fail']).toContain(report.verdict);
    // blocker-правила обязаны поймать пустой документ
    expect(rule(report, 'HEAD-ONE-H1').status).toBe('fail');
  });

  it('POSTCHECK_AGENT_NAME — служебное имя рана', () => {
    expect(POSTCHECK_AGENT_NAME).toBe('Пост-проверка качества');
  });
});

describe('resolvePostcheckMode', () => {
  const original = process.env.POSTCHECK_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.POSTCHECK_MODE;
    else process.env.POSTCHECK_MODE = original;
  });

  it("default → 'report'", () => {
    delete process.env.POSTCHECK_MODE;
    expect(resolvePostcheckMode()).toBe('report');
  });
  it("'enforce' → 'enforce'", () => {
    process.env.POSTCHECK_MODE = 'enforce';
    expect(resolvePostcheckMode()).toBe('enforce');
  });
  it("мусорные значения → безопасный 'report'", () => {
    for (const v of ['REPORT-ONLY', 'strict', '1', '']) {
      process.env.POSTCHECK_MODE = v;
      expect(resolvePostcheckMode()).toBe('report');
    }
  });
});

/* ── Блок HEAD ───────────────────────────────────────────────────────── */

describe('HEAD-ONE-H1 (blocker)', () => {
  it('fail при 2+ H1 (прод-паттерн art3: сырец с 5×H1)', () => {
    const md = cleanDoc() + '\n# Имплантация зубов: повторный заголовок\n\nТекст.';
    const r = rule(run({ markdown: md }), 'HEAD-ONE-H1');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('blocker');
    expect(r.details.h1Count).toBeGreaterThanOrEqual(2);
    expect(run({ markdown: md }).verdict).toBe('fail');
  });
  it('fail при 0 H1', () => {
    const md = '## Только H2\n\nТекст без H1.';
    expect(rule(run({ markdown: md }), 'HEAD-ONE-H1').status).toBe('fail');
  });
  it('pass: ровно один H1; setext-H1 (===) тоже считается', () => {
    expect(rule(run(), 'HEAD-ONE-H1').status).toBe('pass');
    const md = 'Заголовок статьи setext-стилем\n===\n\n## Секция\n\nТекст.';
    const r = rule(run({ markdown: md }), 'HEAD-ONE-H1');
    expect(r.status).toBe('pass');
  });
});

describe('HEAD-NO-SKIPS (major)', () => {
  it('fail при пропуске уровня H1 → H3', () => {
    const md = '# Тема\n\n## Секция\n\nТекст.\n\n### Вложенный\n\nТекст.\n\n# Другое\n\n### Прыжок без H2\n\nТекст.';
    const r = rule(run({ markdown: md }), 'HEAD-NO-SKIPS');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
  });
  it('pass при корректной иерархии; skipped когда заголовков нет', () => {
    expect(rule(run(), 'HEAD-NO-SKIPS').status).toBe('pass');
    const r = rule(run({ markdown: 'Просто текст без заголовков.' }), 'HEAD-NO-SKIPS');
    expect(r.status).toBe('skipped');
  });
});

describe('HEAD-NO-DUPLICATES (major) — несмежные дубли любых уровней', () => {
  it('fail: прод-паттерн art3 «Чистка лица» — тема ×4 и FAQ ×3 НЕ подряд', () => {
    const parts = ['# Чистка лица: виды процедур и особенности', ''];
    const names = [
      'Подготовка к чистке лица',
      'часто задаваемые вопросы (FAQ)',
      'Виды чисток',
      'Чистка лица: виды процедур и особенности', // дубль темы (несмежный)
      'Уход после процедуры',
      'Часто задаваемые вопросы (faq)', // дубль FAQ (регистр/пунктуация)
      'Противопоказания',
      'чистка лица виды процедур и особенности', // ещё дубль (без двоеточия)
      'Заключение',
      'Часто задаваемые вопросы FAQ', // третий дубль FAQ
    ];
    for (const n of names) parts.push(`## ${n}`, '', `Текст секции ${n}.`, '');
    const md = parts.join('\n');
    const r = rule(run({ markdown: md }), 'HEAD-NO-DUPLICATES');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.duplicates.length).toBeGreaterThanOrEqual(2);
  });
  it('pass: все заголовки уникальны (смежный дубль вырезан санитайзером до валидатора)', () => {
    expect(rule(run(), 'HEAD-NO-DUPLICATES').status).toBe('pass');
  });
});

describe('HEAD-TOPIC-AS-H2 (major) — тема не должна повторяться как H2', () => {
  it('fail: H2 дословно повторяет H1/тему (побочный эффект понижения лишних H1)', () => {
    const md = cleanDoc() + '\n## Имплантация зубов\n\nПовтор темы отдельной секцией.\n';
    const r = rule(run({ markdown: md }), 'HEAD-TOPIC-AS-H2');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.headings.length).toBeGreaterThanOrEqual(1);
  });
  it('fail: H2 совпадает с темой по нормализации (регистр/пунктуация)', () => {
    const md = cleanDoc() + '\n## имплантация зубов!\n\nПовтор темы.\n';
    expect(rule(run({ markdown: md }), 'HEAD-TOPIC-AS-H2').status).toBe('fail');
  });
  it('pass: H2 лишь СОДЕРЖИТ тему (например FAQ-заголовок) — не дубль', () => {
    expect(rule(run(), 'HEAD-TOPIC-AS-H2').status).toBe('pass');
  });
  it('skipped: ни H1, ни context.topic — сравнивать не с чем', () => {
    const md = '## Только секция\n\nТекст без H1.';
    expect(
      rule(run({ markdown: md }, { topic: '' }), 'HEAD-TOPIC-AS-H2').status,
    ).toBe('skipped');
  });
});

describe('HEAD-SECTION-COVERAGE (major)', () => {
  it('fail: секция архитектора потеряна', () => {
    const r = rule(
      run({}, { formatRuSections: [{ headingRu: 'Введение' }, { headingRu: 'Стоимость лечения' }] }),
      'HEAD-SECTION-COVERAGE',
    );
    expect(r.status).toBe('fail');
    expect(r.details.missing).toContain('Стоимость лечения');
  });
  it('pass: все секции на месте (нормализованное сравнение)', () => {
    expect(
      rule(run({}, { formatRuSections: [{ headingRu: 'Введение!' }, { headingRu: 'этапы  лечения' }] }), 'HEAD-SECTION-COVERAGE').status,
    ).toBe('pass');
  });
  it('skipped: данных о структуре нет', () => {
    expect(
      rule(run({}, { formatRuSections: [], structuredOutputs: {} }), 'HEAD-SECTION-COVERAGE').status,
    ).toBe('skipped');
  });
  it('FAQ-секция структуры покрыта автогенерируемым FAQ-блоком', () => {
    const r = rule(
      run({}, { formatRuSections: [{ headingRu: 'Часто задаваемые вопросы' }, { headingRu: 'Введение' }] }),
      'HEAD-SECTION-COVERAGE',
    );
    expect(r.status).toBe('pass');
  });
});

/* ── Блок SEO ────────────────────────────────────────────────────────── */

describe('SEO-H1-MAINQUERY (major, fuzzy)', () => {
  it('pass: главный запрос входит в H1 (регистр/пунктуация не важны)', () => {
    expect(rule(run(), 'SEO-H1-MAINQUERY').status).toBe('pass');
  });
  it('fail: в H1 нет главного запроса', () => {
    const md = cleanDoc().replace('# Имплантация зубов: полное руководство', '# Как восстановить улыбку');
    expect(rule(run({ markdown: md }), 'SEO-H1-MAINQUERY').status).toBe('fail');
  });
  it('skipped: semanticCore пуст (M2: частотный fallback убран — только mainQueryRu)', () => {
    expect(
      rule(run({}, { semanticCore: {} }), 'SEO-H1-MAINQUERY').status,
    ).toBe('skipped');
  });
  // Tech-lead W2-review: мусорный mainQueryRu (после нормализации пусто)
  // не должен давать false-fail — skipped, не fail.
  it('skipped: mainQueryRu нормализуется в пустую строку («!!!», «- —»)', () => {
    const r = run({}, { semanticCore: { mainQueryRu: '!!!' } });
    expect(rule(r, 'SEO-H1-MAINQUERY').status).toBe('skipped');
    const r2 = run({}, { semanticCore: { mainQueryRu: '- —' } });
    expect(rule(r2, 'SEO-H1-MAINQUERY').status).toBe('skipped');
  });
});

describe('SEO-HEADINGS-KEYWORDS (minor, report)', () => {
  it('pass при доле ≥20% H2/H3 с ключами (FAQ-вопросы вне знаменателя — блок авто)', () => {
    // Вне FAQ: Введение, Этапы лечения (кластер «этапы»), Реабилитация → 1/3 = 33%
    const r = rule(run(), 'SEO-HEADINGS-KEYWORDS');
    expect(r.status).toBe('pass');
    expect(r.details.share).toBeGreaterThanOrEqual(0.2);
  });
  it('fail при доле <20%', () => {
    const md = cleanDoc().replace('## Этапы лечения', '## Как всё происходит');
    expect(rule(run({ markdown: md }), 'SEO-HEADINGS-KEYWORDS').status).toBe('fail');
    expect(rule(run({ markdown: md }), 'SEO-HEADINGS-KEYWORDS').severity).toBe('minor');
  });
  it('skipped: ключей нет вообще', () => {
    expect(
      rule(run({}, { semanticCore: { mainQueryRu: 'x' } }), 'SEO-HEADINGS-KEYWORDS').status,
    ).toBe('skipped');
  });
});

describe('SEO-HEADINGS-SPAM (minor) — переспам ключей в заголовках', () => {
  it('fail: >50% заголовков H2/H3 (вне FAQ) содержат ключи (seo-reviewer: 30–50% норма)', () => {
    const md = [
      '# Имплантация зубов: руководство',
      '',
      '## Этапы имплантации зубов',
      '',
      'Текст секции достаточно длинный, чтобы правило пустых секций не срабатывало на этом месте.',
      '',
      '## Виды имплантации зубов',
      '',
      'Другой текст секции достаточно длинный для прохождения проверки пустых секций.',
      '',
      '## Стоимость имплантации зубов',
      '',
      'Третий текст секции достаточно длинный для прохождения проверки пустых секций.',
      '',
      faqBlock(10),
      '',
    ].join('\n');
    const r = rule(
      run(
        { markdown: md },
        // Ключ в словоформе из заголовков (вхождение — подстрока после
        // нормализации): все 3 контентных H2 содержат «имплантации».
        { semanticCore: { mainQueryRu: 'имплантация зубов', queryClustersRu: [], lsiTermsRu: ['имплантации'] } },
      ),
      'SEO-HEADINGS-SPAM',
    );
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor');
    expect(r.details.share).toBeGreaterThan(0.5);
  });
  it('pass: доля ≤50% (базовый документ ≈33%)', () => {
    const r = rule(run(), 'SEO-HEADINGS-SPAM');
    expect(r.status).toBe('pass');
    expect(r.details.share).toBeLessThanOrEqual(0.5);
  });
  it('skipped: ключей нет', () => {
    expect(
      rule(run({}, { semanticCore: { mainQueryRu: 'x' } }), 'SEO-HEADINGS-SPAM').status,
    ).toBe('skipped');
  });
});

/* ── Блок BODY ───────────────────────────────────────────────────────── */

describe('BODY-NO-CJK (major)', () => {
  it('fail: CJK-вставка вне code-fence', () => {
    const md = cleanDoc() + '\nПроцедура マッサージ лица проводится курсом.';
    const r = rule(run({ markdown: md }), 'BODY-NO-CJK');
    expect(r.status).toBe('fail');
    expect(r.details.count).toBeGreaterThan(0);
  });
  it('pass: CJK внутри code-fence не считается', () => {
    const md = cleanDoc() + '\n```\n中文 код\n```\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-CJK').status).toBe('pass');
  });
});

describe('BODY-NO-CITATIONS (blocker) — {{src:N}} остатки', () => {
  it('fail: маркер {{src:3}} в markdown (синтетическая утечка)', () => {
    const md = cleanDoc() + '\nТезис подтверждён источником {{src:3}} согласно исследованию.';
    const report = run({ markdown: md });
    const r = rule(report, 'BODY-NO-CITATIONS');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('blocker');
    expect(report.verdict).toBe('fail');
  });
  it('fail: маркер {{src:card}} в html тоже ловится', () => {
    const report = run({}, {}, '<p>утечка {{src:card}} в html</p>');
    expect(rule(report, 'BODY-NO-CITATIONS').status).toBe('fail');
  });
  it('pass: маркеров нет', () => {
    expect(rule(run(), 'BODY-NO-CITATIONS').status).toBe('pass');
  });
});

describe('BODY-NO-AI-PHRASES (major)', () => {
  it('fail: «Как ИИ…» / «as an AI» остатки', () => {
    const md = cleanDoc() + '\nКак ИИ, я не могу предоставить профессиональный совет.';
    expect(rule(run({ markdown: md }), 'BODY-NO-AI-PHRASES').status).toBe('fail');
  });
  it('fail: ложный профессиональный дисклеймер «я не являюсь <профессия>» — в любой отрасли', () => {
    for (const line of [
      'Я не являюсь врачом.',
      'Я не являюсь инженером и не могу дать рекомендации.',
    ]) {
      const md = cleanDoc() + `\n${line}`;
      expect(rule(run({ markdown: md }), 'BODY-NO-AI-PHRASES').status, line).toBe('fail');
    }
  });
  it('pass: чистый текст; фраза внутри code-fence не считается', () => {
    expect(rule(run(), 'BODY-NO-AI-PHRASES').status).toBe('pass');
    const md = cleanDoc() + '\n```\nAs an AI language model\n```\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-AI-PHRASES').status).toBe('pass');
  });
});

describe('BODY-NO-TECH-SECTIONS (blocker)', () => {
  it('fail: секция «Источники» появилась (должна была быть вырезана)', () => {
    const md = cleanDoc() + '\n## Источники\n\n1. Search study\n';
    const report = run({ markdown: md });
    expect(rule(report, 'BODY-NO-TECH-SECTIONS').status).toBe('fail');
    expect(rule(report, 'BODY-NO-TECH-SECTIONS').severity).toBe('blocker');
    expect(report.verdict).toBe('fail');
  });
  it('fail: секция «Дополнительная экспертная информация»', () => {
    const md = cleanDoc() + '\n## Дополнительная экспертная информация\n\nСлужебный блок.\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-TECH-SECTIONS').status).toBe('fail');
  });
  it('pass: «Источники данных для пациентов» — НЕ тех. секция (точное совпадение)', () => {
    const md = cleanDoc() + '\n## Источники данных для пациентов\n\nСписок.\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-TECH-SECTIONS').status).toBe('pass');
  });
});

describe('BODY-NO-DUP-PARAGRAPHS (minor)', () => {
  it('fail: одинаковый абзац в РАЗНЫХ местах документа (несмежный)', () => {
    const para = 'Имплантация проводится в несколько этапов и требует внимательного отношения.';
    const md = `# Тема\n\n${para}\n\n## Секция\n\nДругой текст секции.\n\n${para}\n`;
    const r = rule(run({ markdown: md }), 'BODY-NO-DUP-PARAGRAPHS');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor');
  });
  it('pass: повторов нет', () => {
    expect(rule(run(), 'BODY-NO-DUP-PARAGRAPHS').status).toBe('pass');
  });
});

describe('BODY-NO-EMPTY-SECTIONS (major) — скелетные секции', () => {
  it('fail: H2-секция почти без текста (заголовок есть — контента нет)', () => {
    const md = cleanDoc() + '\n## Побочные эффекты\n\nРедко.\n';
    const r = rule(run({ markdown: md }), 'BODY-NO-EMPTY-SECTIONS');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.empty).toContain('Побочные эффекты');
  });
  it('pass: все секции содержательные; FAQ-секции исключены из проверки', () => {
    expect(rule(run(), 'BODY-NO-EMPTY-SECTIONS').status).toBe('pass');
  });
  it('skipped: H2-секций нет вовсе', () => {
    expect(
      rule(run({ markdown: '# Только H1\n\nТекст без секций.' }), 'BODY-NO-EMPTY-SECTIONS').status,
    ).toBe('skipped');
  });
});

describe('BODY-LENGTH-RANGE (major) — 0.7–1.4×target', () => {
  it('fail: перебор 4.2× (прод art3: 42k при 10k)', () => {
    // Генерируем ~4200 символов уникального текста при target 1000 → 4.2×
    const parts = ['# Чистка лица: виды процедур', ''];
    let i = 0;
    while (parts.join('\n').length < 4600) {
      i += 1;
      parts.push(`Абзац №${i} с уникальным содержанием о чистке лица и уходе за кожей после процедуры.`);
    }
    const md = parts.join('\n');
    const r = rule(run({ markdown: md }, { targetLength: 1000 }), 'BODY-LENGTH-RANGE');
    expect(r.status).toBe('fail');
    expect(r.details.ratio).toBeGreaterThan(1.4);
    // report-only режим: правило считается всегда — даже без enforce
    expect(run({ markdown: md }, { targetLength: 1000 }).rules.some((x) => x.id === 'BODY-LENGTH-RANGE' && x.status === 'fail')).toBe(true);
  });
  it('fail: недобор <0.7× (прод art2: 0.65×)', () => {
    const r = rule(run({}, { targetLength: 10_000 }), 'BODY-LENGTH-RANGE');
    expect(r.status).toBe('fail');
    expect(r.details.ratio).toBeLessThan(0.7);
  });
  it('pass: в диапазоне (default target 2000 ≈ 0.97× — с блоком записи P2-2)', () => {
    const r = rule(run({}, {}), 'BODY-LENGTH-RANGE');
    expect(r.status).toBe('pass');
  });
  it('skipped: targetLength не задан', () => {
    expect(rule(run({}, { targetLength: null }), 'BODY-LENGTH-RANGE').status).toBe('skipped');
    expect(rule(run({}, { targetLength: 'много' }), 'BODY-LENGTH-RANGE').status).toBe('skipped');
  });
});

describe('TBL-FORMAT-HONORED (minor)', () => {
  it('fail: секция с formatRu=таблица не содержит GFM-таблицу', () => {
    const r = rule(
      run({}, { formatRuSections: [{ headingRu: 'Введение' }, { headingRu: 'Этапы лечения', formatRu: 'таблица' }] }),
      'TBL-FORMAT-HONORED',
    );
    expect(r.status).toBe('fail');
    expect(r.details.missing).toContain('Этапы лечения');
  });
  it('pass: в секции есть таблица', () => {
    const md = cleanDoc().replace(
      '- Консультация и планирование\n- Хирургический этап установки импланта',
      '| Этап | Длительность |\n|---|---|\n| Консультация | 1 день |\n| Хирургия | 2 часа |',
    );
    const r = rule(
      run({ markdown: md }, { formatRuSections: [{ headingRu: 'Этапы лечения', formatRu: 'таблица' }] }),
      'TBL-FORMAT-HONORED',
    );
    expect(r.status).toBe('pass');
  });
  it('skipped: нет секций с formatRu=таблица', () => {
    expect(rule(run(), 'TBL-FORMAT-HONORED').status).toBe('skipped');
  });
});

describe('FIX-D1 QA: TBL-FORMAT-HONORED — заголовок таблица-секции слит mergeEmptySections', () => {
  /** Док: здоровая секция + соседняя секция с GFM-таблицей (таблица «переехала»). */
  const MERGED_TBL_DOC = [
    '# Чистка лица: виды процедур', '',
    '## Основная секция о чистке лица', '',
    'Чистка лица — косметическая процедура, которая удаляет ороговевшие клетки кожи, избытки кожного сала и загрязнения из пор, выравнивает рельеф и тон.', '',
    '## Соседняя секция со сравнением', '',
    'Сравнение методов чистки лица в таблице ниже позволяет подобрать вариант по типу кожи и бюджету пациента:', '',
    '| Метод | Цена |', '|---|---|', '| Механическая | 3 000 ₽ |', '| Ультразвуковая | 4 000 ₽ |', '',
  ].join('\n');

  it('плановый заголовок formatRu=таблица СЛИТ, но GFM-таблица живёт в соседней секции → pass', () => {
    const r = run(
      { markdown: MERGED_TBL_DOC },
      {
        formatRuSections: [
          { headingRu: 'Основная секция о чистке лица' },
          { headingRu: 'Сравнение методов', formatRu: 'таблица' }, // слита в соседа
        ],
        mergedHeadings: ['сравнение методов'],
      },
    );
    const tbl = rule(r, 'TBL-FORMAT-HONORED');
    expect(tbl.status).toBe('pass');
  });

  it('плановый заголовок СЛИТ и таблицы в статье НЕТ вообще → fail (честный репорт)', () => {
    const noTableDoc = MERGED_TBL_DOC.split('\n').filter(
      (l) => !l.includes('|'),
    ).join('\n');
    const r = run(
      { markdown: noTableDoc },
      {
        formatRuSections: [
          { headingRu: 'Основная секция о чистке лица' },
          { headingRu: 'Сравнение методов', formatRu: 'таблица' },
        ],
        mergedHeadings: ['сравнение методов'],
      },
    );
    const tbl = rule(r, 'TBL-FORMAT-HONORED');
    expect(tbl.status).toBe('fail');
    expect(tbl.details.missing).toContain('Сравнение методов');
  });

  it('регресс: НЕслитый заголовок formatRu=таблица без секции в документе → fail как раньше', () => {
    const r = run(
      { markdown: MERGED_TBL_DOC },
      {
        formatRuSections: [
          { headingRu: 'Основная секция о чистке лица' },
          { headingRu: 'Таблица цен на услуги', formatRu: 'таблица' }, // не слит, секции нет
        ],
      },
    );
    expect(rule(r, 'TBL-FORMAT-HONORED').status).toBe('fail');
  });
});

/* ── Блок FAQ ────────────────────────────────────────────────────────── */

describe('FAQ-PRESENT (major; skipped для истинного шаблона)', () => {
  it('pass: FAQ-блок с 8–12 Q/A', () => {
    expect(rule(run(), 'FAQ-PRESENT').status).toBe('pass');
  });
  it('fail: FAQ-секции нет вовсе', () => {
    const md = '# Тема\n\n## Секция\n\nТекст.';
    const r = run({ markdown: md });
    expect(rule(r, 'FAQ-PRESENT').status).toBe('fail');
    expect(rule(r, 'FAQ-PRESENT').severity).toBe('major');
  });
  it('fail: FAQ есть, но вопросов <8', () => {
    const r = run({ markdown: cleanDoc({ faqQuestions: 3 }) });
    expect(rule(r, 'FAQ-PRESENT').status).toBe('fail');
  });
  it('skipped: истинный шаблон (нет author-вывода)', () => {
    const md = '# Тема\n\n## Секция\n\nТекст.';
    expect(
      rule(run({ markdown: md }, { structuredOutputs: {} }), 'FAQ-PRESENT').status,
    ).toBe('skipped');
  });
  it('skipped: авторский вывод помечен _fallbackTemplate (FIX-M2)', () => {
    const md = '# Тема\n\n## Секция\n\nТекст.';
    expect(
      rule(
        run({ markdown: md }, { structuredOutputs: { 'article-author': { _fallbackTemplate: true } } }),
        'FAQ-PRESENT',
      ).status,
    ).toBe('skipped');
  });
});

describe('FAQ-UNIQUENESS (major) — U4: ровно ОДНА FAQ-секция', () => {
  it('fail: 3 FAQ-подобные секции (W1-deploy: «Часто задаваемые вопросы», «Ответы на частые вопросы», «10 необычных вопросов»)', () => {
    const md = [
      '# Ботулинотерапия: как препарат работает',
      '',
      '## Показания',
      '',
      'Текст.',
      '',
      '## Часто задаваемые вопросы (FAQ)',
      '',
      '### Вопрос один?',
      '',
      'Ответ.',
      '',
      '### Вопрос два?',
      '',
      'Ответ.',
      '',
      '## Препараты',
      '',
      'Текст.',
      '',
      '## Ответы на частые вопросы о ботулинотерапии',
      '',
      'Обычные ответы списком без H3.',
      '',
      '## 10 необычных вопросов про Ботулинотерапия',
      ...Array.from({ length: 10 }, (_, i) => `\n### Неочевидный вопрос №${i + 1}?\n\nОтвет №${i + 1}.`),
      '',
    ].join('\n');
    const report = run({ markdown: md }, { targetLength: 3000 });
    const r = rule(report, 'FAQ-UNIQUENESS');
    expect(r.status).toBe('fail');
    expect(r.details.sections).toHaveLength(3);
    // при этом сам FAQ на месте (доминирующая секция — 10 вопросов)
    expect(rule(report, 'FAQ-PRESENT').status).toBe('pass');
  });
  it('U4: мини-FAQ (легаси-bold) + «10 вопросов» → FAIL (любая вторая FAQ-подобная секция)', () => {
    const md = [
      '# Имплантация зубов: руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов с высокой приживляемостью.', '',
      legacyFaqBlock(8), '',
      faqBlock(10), '',
    ].join('\n');
    const report = run({ markdown: md }, { targetLength: 2000 });
    const r = rule(report, 'FAQ-UNIQUENESS');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.sections).toEqual([
      'Часто задаваемые вопросы (FAQ)',
      '10 необычных вопросов про Имплантация зубов',
    ]);
  });
  it('pass: ровно 1 FAQ-секция (только «10 необычных вопросов»)', () => {
    expect(rule(run(), 'FAQ-UNIQUENESS').status).toBe('pass');
    expect(rule(run(), 'FAQ-UNIQUENESS').details.sections).toEqual([
      '10 необычных вопросов про Имплантация зубов',
    ]);
  });
});

describe('FAQ-QA-FORMAT (minor)', () => {
  it('fail: вопрос H3 с пустым ответом', () => {
    const md = cleanDoc({ faqQuestions: 10 }).replace('Короткий честный ответ №5 с обоснованием.', '');
    expect(rule(run({ markdown: md }), 'FAQ-QA-FORMAT').status).toBe('fail');
  });
  it('pass: все ответы непустые', () => {
    expect(rule(run(), 'FAQ-QA-FORMAT').status).toBe('pass');
  });
});

/* ── Блок SIG ────────────────────────────────────────────────────────── */

describe('SIG-PRESENT / SIG-NO-SPECIALIST (major)', () => {
  it('SIG-PRESENT pass: подпись «Автор статьи:» в конце при specialistId≠null', () => {
    const md = cleanDoc() + '\n\n---\n\n**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог\n';
    expect(rule(run({ markdown: md }, { specialistId: 'spec-1' }), 'SIG-PRESENT').status).toBe('pass');
    // зеркальное правило при этом skipped
    expect(rule(run({ markdown: md }, { specialistId: 'spec-1' }), 'SIG-NO-SPECIALIST').status).toBe('skipped');
  });
  it('SIG-PRESENT fail: специалист задан, подписи нет', () => {
    expect(rule(run({}, { specialistId: 'spec-1' }), 'SIG-PRESENT').status).toBe('fail');
  });
  it('SIG-NO-SPECIALIST fail: специалист НЕ задан, но подпись есть', () => {
    const md = cleanDoc() + '\n\n---\n\n**Автор статьи:** Иванов Иван Иванович\n';
    expect(rule(run({ markdown: md }, { specialistId: null }), 'SIG-NO-SPECIALIST').status).toBe('fail');
  });
  it('SIG-NO-SPECIALIST pass / SIG-PRESENT skipped при specialistId=null', () => {
    expect(rule(run(), 'SIG-NO-SPECIALIST').status).toBe('pass');
    expect(rule(run(), 'SIG-PRESENT').status).toBe('skipped');
  });
});

/* ── Блок LINKS ──────────────────────────────────────────────────────── */

describe('LINKS-PRESENT (minor)', () => {
  it('pass: инлайн-ссылка на домен компании (уже в базовом документе)', () => {
    const r = run();
    expect(rule(r, 'LINKS-PRESENT').status).toBe('pass');
    expect(rule(r, 'LINKS-PRESENT').details.count).toBe(1);
  });
  it('fail: ссылок нет', () => {
    const md = cleanDoc().replace('[винт](https://example.test/services/implant)', 'винт');
    expect(rule(run({ markdown: md }), 'LINKS-PRESENT').status).toBe('fail');
  });
  it('fail: ссылки есть, но на чужой домен (при заданных siteDomains)', () => {
    expect(rule(run({}, { siteDomains: ['example.org'] }), 'LINKS-PRESENT').status).toBe('fail');
  });
  it('без siteDomains любая инлайн-ссылка считается ссылкой на сайт (линкер — единственный источник ссылок)', () => {
    expect(rule(run({}, { siteDomains: undefined }), 'LINKS-PRESENT').status).toBe('pass');
  });
});

describe('LINKS-NOT-IN-FAQ-SIGNATURE (minor)', () => {
  it('fail: ссылка внутри FAQ-секции', () => {
    const md = cleanDoc().replace(
      'Короткий честный ответ №3 с обоснованием.',
      'Ответ со [ссылкой](https://example.test/services).',
    );
    expect(rule(run({ markdown: md }), 'LINKS-NOT-IN-FAQ-SIGNATURE').status).toBe('fail');
  });
  it('fail: ссылка внутри подписи', () => {
    const md =
      cleanDoc() +
      '\n\n---\n\n**Автор статьи:** [Иванов](https://example.test/team/ivanov), Врач-имплантолог\n';
    expect(rule(run({ markdown: md }), 'LINKS-NOT-IN-FAQ-SIGNATURE').status).toBe('fail');
  });
  it('pass: ссылка в подписи — каталог-ссылка специалиста (ставится кодом, B2)', () => {
    const md =
      cleanDoc() +
      '\n\n---\n\n**Автор статьи:** [Иванов Иван, Врач-имплантолог](https://example.test/doctors/ivanov/)\n';
    const report = run({ markdown: md }, {
      specialistId: '11111111-1111-1111-1111-111111111111',
      specialistPageUrls: ['https://example.test/doctors/ivanov/'],
    });
    expect(rule(report, 'LINKS-NOT-IN-FAQ-SIGNATURE').status).toBe('pass');
  });
  it('fail: ссылка в подписи не из каталога специалистов (даже при specialistId)', () => {
    const md =
      cleanDoc() +
      '\n\n---\n\n**Автор статьи:** [Иванов](https://example.test/team/ivanov), Врач-имплантолог\n';
    const report = run({ markdown: md }, {
      specialistId: '11111111-1111-1111-1111-111111111111',
      specialistPageUrls: ['https://example.test/doctors/smirnova/'],
    });
    expect(rule(report, 'LINKS-NOT-IN-FAQ-SIGNATURE').status).toBe('fail');
  });
  it('pass: ссылки только в теле статьи (базовый документ)', () => {
    expect(rule(run(), 'LINKS-NOT-IN-FAQ-SIGNATURE').status).toBe('pass');
  });
});

/* ── Блок PROCESS ────────────────────────────────────────────────────── */

describe('PROCESS-FINALIZATION (minor) — способ финализации', () => {
  it('pass: нормальная финализация (полный конвейер)', () => {
    const r = rule(run({}, { finalizedVia: 'normal' }), 'PROCESS-FINALIZATION');
    expect(r.status).toBe('pass');
  });
  it('fail: fallback-финализация — статья не прошла полный конвейер (метрика аналитика §5.2)', () => {
    const r = rule(run({}, { finalizedVia: 'fallback' }), 'PROCESS-FINALIZATION');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor');
  });
  it('skipped: способ финализации не передан (обратная совместимость)', () => {
    expect(
      rule(run({}, { finalizedVia: undefined }), 'PROCESS-FINALIZATION').status,
    ).toBe('skipped');
  });
});

describe('FACTCHECK-COVERAGE (major, требование TL W1)', () => {
  it('pass: успешный фактчек-прогон был', () => {
    expect(rule(run(), 'FACTCHECK-COVERAGE').status).toBe('pass');
  });
  it('fail: финализация без успешного фактчек-рана (все 3 прод-статьи W1)', () => {
    const r = run({}, { hasSuccessfulFactcheckRun: false });
    expect(rule(r, 'FACTCHECK-COVERAGE').status).toBe('fail');
    expect(rule(r, 'FACTCHECK-COVERAGE').severity).toBe('major');
  });
  it('details: остаточные замечания фактчекера персистятся', () => {
    const r = run({}, {
      hasSuccessfulFactcheckRun: true,
      structuredOutputs: {
        factchecker: { checkedArticleMarkdownRu: 'x', reviewRequired: true, forbiddenClaimsRu: ['заявление раз', 'заявление два'] },
      },
    });
    const fc = rule(r, 'FACTCHECK-COVERAGE');
    expect(fc.status).toBe('pass');
    expect(fc.details.reviewRequired).toBe(true);
    expect(fc.details.forbiddenClaimsCount).toBe(2);
  });
});

describe('TIMING-ANOMALY (minor, report)', () => {
  it('fail: роль дольше 600с (прод: фактчекер 932с)', () => {
    const r = run({}, { timings: { 'Агент фактчекинга': 932_000, 'Агент автора': 203_000 } });
    expect(rule(r, 'TIMING-ANOMALY').status).toBe('fail');
    expect(rule(r, 'TIMING-ANOMALY').details.slow['Агент фактчекинга']).toBe(932_000);
  });
  it('pass: все роли в норме; skipped: таймингов нет', () => {
    expect(rule(run(), 'TIMING-ANOMALY').status).toBe('pass');
    expect(rule(run({}, { timings: null }), 'TIMING-ANOMALY').status).toBe('skipped');
  });
  it('массив таймингов [{agent, durationMs}] тоже принимается', () => {
    const r = run({}, { timings: [{ agent: 'Агент автора', durationMs: 700_000 }] });
    expect(rule(r, 'TIMING-ANOMALY').status).toBe('fail');
  });
});

/* ── Агрегация verdict ───────────────────────────────────────────────── */

describe('verdict-агрегация', () => {
  it('fail: любой blocker ({{src:N}} утечка)', () => {
    const md = cleanDoc() + '\nТезис {{src:7}} подтверждён.';
    expect(run({ markdown: md }).verdict).toBe('fail');
  });
  it('fail: ≥2 major (прод-кейс: перебор объёма + нет фактчека)', () => {
    const report = run({}, { targetLength: 10_000, hasSuccessfulFactcheckRun: false });
    expect(report.verdict).toBe('fail');
  });
  it('warn: ровно 1 major', () => {
    const report = run({}, { hasSuccessfulFactcheckRun: false });
    expect(report.verdict).toBe('warn');
  });
  it('warn: только minor-fail', () => {
    // Единственный провал — LINKS-PRESENT: ссылка есть, но домен не компании.
    const report = run({}, { siteDomains: ['second.example'] });
    expect(report.rules.filter((r) => r.status === 'fail')).toHaveLength(1);
    expect(report.rules.find((r) => r.status === 'fail').severity).toBe('minor');
    expect(report.verdict).toBe('warn');
  });
  it('ok: ни одного fail', () => {
    expect(run().verdict).toBe('ok');
  });
});

/* ── Прод-фикстура целиком: art3 «Чистка лица» (16.08) ───────────────── */

describe('прод-фикстура art3 «Чистка лица» (analyst §1.5-1.6)', () => {
  it('дубли H2 + перебор 4.2× + нет фактчека → fail c профильными провалами', () => {
    const parts = ['# Чистка лица: виды процедур и особенности', ''];
    const sections = [
      'Подготовка к чистке лица',
      'Часто задаваемые вопросы (FAQ)',
      'Виды чисток',
      'Чистка лица: виды процедур и особенности', // дубль темы ×2
      'Уход после процедуры',
      'Часто задаваемые вопросы (faq)', // дубль FAQ ×2
      'Противопоказания',
      'чистка лица виды процедур и особенности', // дубль темы ×3
      'Заключение',
      'Часто задаваемые вопросы FAQ', // дубль FAQ ×3
    ];
    for (const s of sections) {
      parts.push(`## ${s}`, '', `Секция «${s}»: особенности процедуры и показания.`, '');
    }
    let i = 0;
    while (parts.join('\n').length < 4600) {
      i += 1;
      parts.push(`Уникальный абзац №${i} про виды чистки лица, показания и противопоказания процедуры.`);
    }
    const report = run(
      { markdown: parts.join('\n') },
      {
        topic: 'Чистка лица',
        targetLength: 1000,
        hasSuccessfulFactcheckRun: false, // фактчекер упал по таймауту → fallback
        semanticCore: { mainQueryRu: 'чистка лица', queryClustersRu: [], lsiTermsRu: [] },
        formatRuSections: sections.slice(0, 4).map((s) => ({ headingRu: s })),
      },
    );
    expect(rule(report, 'HEAD-NO-DUPLICATES').status).toBe('fail');
    expect(rule(report, 'FAQ-UNIQUENESS').status).toBe('fail');
    expect(rule(report, 'BODY-LENGTH-RANGE').details.ratio).toBeGreaterThan(4);
    expect(rule(report, 'FACTCHECK-COVERAGE').status).toBe('fail');
    expect(report.verdict).toBe('fail');
    expect(report.summary.fail).toBeGreaterThanOrEqual(4);
  });
});

/* ── QA#1 W2: фиксы FAQ-правил (FIX-1/FIX-2/FIX-3) ─────────────────────── */

/** Легаси-FAQ из postProcessArticle (buildFaqMarkdown): `**Вопрос?**\n\nОтвет`. */
function legacyFaqBlock(n = 10) {
  const lines = ['## Часто задаваемые вопросы (FAQ)', ''];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`**Больно ли ставить имплант №${i}?**`, '', `Процедура №${i} проходит под местной анестезией и длится около часа.`, '');
  }
  return lines.join('\n');
}

describe('U4: легаси-bold (`**Вопрос?**`) больше не валидный формат FAQ', () => {
  it('легаси-FAQ `**Вопрос?**\\nОтвет` ×10 (без авто-FAQ) → FAQ-PRESENT fail (считает только H3)', () => {
    const md = cleanDoc().replace(faqBlock(10), legacyFaqBlock(10));
    const report = run({ markdown: md });
    expect(rule(report, 'FAQ-PRESENT').status).toBe('fail');
    expect(rule(report, 'FAQ-PRESENT').message).toMatch(/авто-FAQ \(H3\)/);
    expect(rule(report, 'FAQ-PRESENT').details.dominantQuestions).toBe(0);
    // при этом сама секция детектируется FAQ-подобной (заголовок) — 1 секция,
    // UNIQUENESS не падает (0 FAQ-секций — территория FAQ-PRESENT).
    expect(rule(report, 'FAQ-UNIQUENESS').status).toBe('pass');
  });

  it('H3-формат по-прежнему валиден (регресс): 10 вопросов → pass', () => {
    expect(rule(run(), 'FAQ-PRESENT').status).toBe('pass');
    expect(rule(run(), 'FAQ-PRESENT').message).toMatch(/10/);
  });

  it('легаси-bold вопрос с пустым ответом НЕ даёт FAQ-QA-FORMAT fail (формат вне проверки)', () => {
    // U4: FAQ-QA-FORMAT проверяет только H3-вопросы; пустые bold-ответы —
    // проблема легаси-секции, которую ловит FAQ-UNIQUENESS/FAQ-PRESENT.
    const legacy = legacyFaqBlock(10).replace('Процедура №5 проходит под местной анестезией и длится около часа.', '');
    const md = cleanDoc().replace(faqBlock(10), legacy);
    expect(rule(run({ markdown: md }), 'FAQ-QA-FORMAT').status).toBe('pass');
  });
});

describe('FIX-2: FAQ-UNIQUENESS — узкое определение FAQ-секции', () => {
  it('контентный H2 «Вопросы при выборе компании» (проза, без Q/A) — НЕ FAQ-секция', () => {
    const md = [
      '# Имплантация зубов: руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов с высокой приживляемостью.', '',
      '## Вопросы при выборе компании', '',
      'Выбирая компанию, обращайте внимание на опыт хирурга, стерилизацию инструмента и наличие КТ-диагностики.', '',
      faqBlock(10), '',
    ].join('\n');
    const report = run({ markdown: md });
    const r = rule(report, 'FAQ-UNIQUENESS');
    // Только 1 реальная FAQ-секция (авто) → pass; контентная не в счёт.
    expect(r.status).toBe('pass');
    expect(r.details.sections).toEqual(['10 необычных вопросов про Имплантация зубов']);
    expect(r.details.sections).not.toContain('Вопросы при выборе компании');
  });

  it('секция БЕЗ FAQ-слов в заголовке, но с ≥3 Q/A-парами — СЧИТАЕТСЯ FAQ-секцией (→ вторая = fail U4)', () => {
    const md = [
      '# Имплантация зубов: руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов с высокой приживляемостью.', '',
      '## Консультация: о чём спросить врача', '',
      ...['импланты', 'сроки', 'гарантии'].flatMap((t) => [`**Стоит ли спрашивать про ${t}?**`, '', `Да, обсудите ${t} с врачом до начала лечения.`, '']),
      faqBlock(10), '',
    ].join('\n');
    const report = run({ markdown: md });
    const r = rule(report, 'FAQ-UNIQUENESS');
    // Детекция FAQ-подобности по Q/A-парам сохранена; U4-порог ≤1 → fail.
    expect(r.status).toBe('fail');
    expect(r.details.sections).toContain('Консультация: о чём спросить врача');
    expect(r.details.sections).toContain('10 необычных вопросов про Имплантация зубов');
  });

  it('регресс: 3 FAQ-секции с профильными заголовками → по-прежнему fail', () => {
    const md = [
      '# Ботулинотерапия', '', '## Показания', '', 'Текст о показаниях к процедуре ботулинотерапии.', '',
      '## Часто задаваемые вопросы (FAQ)', '', '### Вопрос один?', '', 'Ответ.', '', '### Вопрос два?', '', 'Ответ.', '',
      '## Препараты', '', 'Текст о препаратах в косметологии.', '',
      '## Ответы на частые вопросы о ботулинотерапии', '', 'Обычные ответы списком без вопросов.', '',
      '## 10 необычных вопросов про Ботулинотерапия',
      ...Array.from({ length: 10 }, (_, i) => `\n### Неочевидный вопрос №${i + 1}?\n\nОтвет №${i + 1}.`),
      '',
    ].join('\n');
    expect(rule(run({ markdown: md }, { targetLength: 3000 }), 'FAQ-UNIQUENESS').status).toBe('fail');
  });
});

/* ── load-robust performance budget (GATE: heuristic) ─────────────────────
 *
 * The previous version of the smoke test took ONE wall-clock sample and
 * demanded `< 50ms`. That assertion is load-sensitive, not product-sensitive:
 * `runArticlePostcheck` itself costs 7-21ms on the 40k-char fixture, but a
 * single sample taken while the machine is busy reaches 54-64ms (reproduced
 * on this worktree: 53.9ms and 64.0ms with 3 parallel vitest runs under CPU
 * load) => flaky RED on an idle-for-the-product machine, not a regression.
 *
 * Fix, with the regression signal kept:
 *   1. WARM-UP: one untimed call first (JIT + internal caches are hot), so the
 *      samples measure steady state instead of first-call compilation.
 *   2. MEDIAN of PERF_SAMPLES timed samples. Not `min` (it would hide a real
 *      regression) and not `max` (it would stay load-sensitive).
 *   3. BUDGET PERF_BUDGET_MS on the median: ~6x the measured normal cost
 *      (17ms median on an idle box) and far below the ~170ms that a 10x
 *      degradation costs, so an order-of-magnitude regression still fails the
 *      test. The budget is a hard ceiling, never scaled to infinity.
 *
 * Coverage is NOT weakened: the 40k-char fixture assertion and the 39-rule
 * assertion stay in place.
 */

/** Number of timed samples; an odd count makes the median a real sample. */
const PERF_SAMPLES = 5;
/** Wall-clock budget for the MEDIAN sample, in milliseconds. */
const PERF_BUDGET_MS = 100;

/**
 * Median of a numeric sample set (odd length -> the middle sample).
 *
 * @param {number[]} samples
 * @returns {number}
 */
function medianOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe('QA#2 W2 → U4: поведенческий прогон — штатная прод-статья', () => {
  it('(а-U4) только авто-FAQ «10 необычных» (###) + подпись: все FAQ-правила pass, verdict ok/warn', () => {
    const md = [
      '# Имплантация зубов: полное руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов. Титановый [винт](https://example.test/services/implant) интегрируется в костную ткань.', '',
      '## Этапы лечения', '',
      'Лечение состоит из нескольких последовательных этапов, каждый из которых важен для итогового результата приживления.', '',
      '## Реабилитация', '',
      'После операции следует соблюдать рекомендации врача. Процесс приживления занимает от 3 до 6 месяцев.', '',
      faqBlock(10), '',
      '---', '',
      '**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог', '',
    ].join('\n');
    const report = run({ markdown: md }, { targetLength: 2000, specialistId: 'spec-1' });

    expect(rule(report, 'FAQ-PRESENT').status).toBe('pass');
    expect(rule(report, 'FAQ-QA-FORMAT').status).toBe('pass');
    const uniq = rule(report, 'FAQ-UNIQUENESS');
    expect(uniq.status).toBe('pass');
    expect(uniq.details.sections).toEqual(['10 необычных вопросов про Имплантация зубов']);
    // seo-round A5 + M2: FAQ-KEYS-SHARE питается от semanticCore; фикстура
    // ядра содержит «процедура» — все вопросы авто-FAQ с ключом → pass.
    for (const r of report.rules.filter((x) => x.block === 'faq')) {
      expect(r.status, `${r.id}: ${r.message}`).toBe('pass');
    }
    expect(['ok', 'warn']).toContain(report.verdict);
  });

  it('(б-U4) мини-FAQ (легаси) + «10 вопросов» → FAQ-UNIQUENESS fail (прод-паттерн U4 до фикса)', () => {
    const md = [
      '# Имплантация зубов: полное руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов. Титановый [винт](https://example.test/services/implant) интегрируется в костную ткань.', '',
      '## Этапы лечения', '',
      'Лечение состоит из нескольких последовательных этапов, каждый из которых важен для итогового результата приживления.', '',
      '## Реабилитация', '',
      'После операции следует соблюдать рекомендации врача. Процесс приживления занимает от 3 до 6 месяцев.', '',
      legacyFaqBlock(10), '',
      faqBlock(10), '',
      '---', '',
      '**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог', '',
    ].join('\n');
    const report = run({ markdown: md }, { targetLength: 2000, specialistId: 'spec-1' });
    expect(rule(report, 'FAQ-UNIQUENESS').status).toBe('fail');
    expect(rule(report, 'FAQ-PRESENT').status).toBe('pass'); // 10 H3-вопросов в авто-секции
    expect(report.verdict).toBe('warn'); // ровно 1 major-fail — warn (не fail)
  });

  it('(смоук) 40k-символьная статья — runArticlePostcheck укладывается в 100мс (медиана из 5 замеров после разогрева)', () => {
    const para = (i) => `Технология установки имплантата №${i} требует предварительной компьютерной томографии и детального планирования позиции. Врач оценивает объём костной ткани и подбирает длину винта. Реабилитация после процедуры занимает несколько месяцев, в течение которых важно соблюдать гигиену полости рта и приходить на контрольные осмотры.`;
    const parts = ['# Имплантация зубов: полное руководство', ''];
    for (let s = 1; s <= 28; s += 1) {
      parts.push(`## Секция №${s} о подготовке и протезировании`, '');
      for (let p = 0; p < 4; p += 1) parts.push(para(s * 10 + p), '');
    }
    parts.push(legacyFaqBlock(10), '', faqBlock(10), '', '---', '',
      '**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог', '');
    const md = parts.join('\n');
    expect(md.length).toBeGreaterThanOrEqual(40_000); // фикстура реально «тяжёлая»

    const input = {
      markdown: md,
      html: '<h1>rendered</h1>',
      context: cleanContext({ targetLength: 40_000, specialistId: 'spec-1' }),
    };

    // 1) Warm-up (not measured): JIT + internal caches are hot before sampling.
    runArticlePostcheck(input);

    // 2) Timed samples -> median (min hides regressions, max is load-sensitive).
    const samples = [];
    let report = null;
    for (let i = 0; i < PERF_SAMPLES; i += 1) {
      const t0 = performance.now();
      report = runArticlePostcheck(input);
      samples.push(performance.now() - t0);
    }
    expect(report.rules).toHaveLength(39); // полный прогон, не усечённый (36 + P1a + P2 objection/form-rec)

    // 3) Budget on the median — the load-tolerant but still strict signal.
    const median = medianOf(samples);
    expect(
      median,
      `runArticlePostcheck median=${median.toFixed(2)}ms of ${PERF_SAMPLES} samples ` +
        `[${samples.map((s) => s.toFixed(1)).join(', ')}]ms — budget ${PERF_BUDGET_MS}ms`,
    ).toBeLessThan(PERF_BUDGET_MS);
  });
});

describe('BODY-NO-CHUNK-ARTIFACTS (major) — U5: пометки чанк-склейки', () => {
  it('pass: чистый документ (базовая фикстура)', () => {
    expect(rule(run(), 'BODY-NO-CHUNK-ARTIFACTS').status).toBe('pass');
    expect(rule(run(), 'BODY-NO-CHUNK-ARTIFACTS').severity).toBe('major');
  });

  it('fail: прод-паттерн 00983341 — «*(Продолжение следует в следующем батче...)*» отдельным абзацем', () => {
    const md = cleanDoc() + '\n*(Продолжение следует в следующем батче...)*\n';
    const r = rule(run({ markdown: md }), 'BODY-NO-CHUNK-ARTIFACTS');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.count).toBe(1);
    expect(r.details.samples[0]).toContain('Продолжение следует');
  });

  it('fail: «[Продолжение]», «To be continued...», «Батч 3 из 9» — все из реестра', () => {
    const md = cleanDoc() + '\n[Продолжение]\n\nTo be continued...\n\nБатч 3 из 9\n';
    const r = rule(run({ markdown: md }), 'BODY-NO-CHUNK-ARTIFACTS');
    expect(r.status).toBe('fail');
    expect(r.details.count).toBe(3);
  });

  it('pass: медицинские фразы с «продолжаются/продолжение курса» — НЕ артефакты', () => {
    const md = cleanDoc() +
      '\nСимптомы продолжаются несколько дней после процедуры.\n\nКровотечение продолжается до 10 дней в норме.\n\nПродолжение курса лечения обсуждается с врачом.\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-CHUNK-ARTIFACTS').status).toBe('pass');
  });

  it('pass: артефакт-фраза внутри code-fence не считается', () => {
    const md = cleanDoc() + '\n```\nПродолжение следует\n```\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-CHUNK-ARTIFACTS').status).toBe('pass');
  });
});

describe('FIX-3: BODY-NO-EMPTY-SECTIONS — граница последней контентной секции до FAQ/подписи', () => {
  it('пустая последняя H2-секция перед FAQ → fail (тело обрезано до FAQ, не «размазано» по хвосту)', () => {
    const md = [
      '# Имплантация зубов: руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов с высокой приживляемостью.', '',
      '## Вопросы безопасности', '',
      'Редко.', '',
      faqBlock(10), '',
    ].join('\n');
    const r = rule(run({ markdown: md }), 'BODY-NO-EMPTY-SECTIONS');
    expect(r.status).toBe('fail');
    expect(r.details.empty).toContain('Вопросы безопасности');
  });

  it('пустая последняя секция с длинной подписью в хвосте → fail (подпись не «спасает» объём)', () => {
    const md = [
      '# Имплантация зубов: руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов с высокой приживляемостью.', '',
      faqBlock(10), '',
      '## Примечание редакции', '',
      'Кратко.', '',
      '---', '',
      '**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог, кандидат медицинских наук, доцент кафедры челюстно-лицевой хирургии', '',
    ].join('\n');
    const r = rule(run({ markdown: md }, { specialistId: 'spec-1' }), 'BODY-NO-EMPTY-SECTIONS');
    expect(r.status).toBe('fail');
    expect(r.details.empty).toContain('Примечание редакции');
  });

  it('регресс: содержательные секции перед FAQ → pass', () => {
    expect(rule(run(), 'BODY-NO-EMPTY-SECTIONS').status).toBe('pass');
  });
});

/* ══ quality-calibration (2026-08-21): C1/C2/C3 + прод-фикстуры ══════════ */

describe('C1: SEO-правила без ядра → skipped «SEO-ядро не собрано»', () => {
  it('fallback-статья без semanticCore: все 3 SEO-правила skipped', () => {
    const md = cleanDoc().replace('# Имплантация зубов: полное руководство', '# Статья');
    const r = run({ markdown: md }, { semanticCore: {}, wordstatKeywords: [] });
    for (const id of ['SEO-H1-MAINQUERY', 'SEO-HEADINGS-KEYWORDS', 'SEO-HEADINGS-SPAM']) {
      const seoRule = rule(r, id);
      expect(seoRule.status).toBe('skipped');
      expect(seoRule.message).toMatch(/SEO-ядро не собрано/);
    }
  });

  it('ключей ядра нет, но mainQueryRu от семантика есть → H1-правило работает как раньше', () => {
    const r = run({}, { wordstatKeywords: [] });
    expect(rule(r, 'SEO-H1-MAINQUERY').status).toBe('pass'); // mainQueryRu из cleanContext
    expect(rule(r, 'SEO-HEADINGS-KEYWORDS').status).not.toBe('fail');
  });

  it('mainQueryRu есть, ключей нет → H1-правило активно, KEYWORDS/SPAM skipped (не «ядро не собрано»)', () => {
    const r = run({}, { semanticCore: { mainQueryRu: 'имплантация зубов', queryClustersRu: [], lsiTermsRu: [] }, wordstatKeywords: [] });
    expect(rule(r, 'SEO-H1-MAINQUERY').status).toBe('pass');
    expect(rule(r, 'SEO-HEADINGS-KEYWORDS').status).toBe('skipped');
    expect(rule(r, 'SEO-HEADINGS-KEYWORDS').message).not.toMatch(/SEO-ядро не собрано/);
  });
});

describe('C2/seo-round: пороги SEO-HEADINGS — рабочее окно 20–65% (импорт seo-standards)', () => {
  /** N контентных H2, у первых withKeys — ключ «омоложение» в заголовке.
   *  Ключ выбран НЕ пересекающимся с темой/H1/FAQ-заголовком: после FIX-S1
   *  (морфо-детектор) семейство «имплантации» матчит и FAQ-заголовок
   *  «про Имплантация зубов» — фикстура должна управлять долей сама.
   *  ВАЖНО: H2 самой FAQ-секции входит в знаменатель seoHeadings (существующее
   *  поведение: исключаются только заголовки ВНУТРИ FAQ-секции) —
   *  фактический знаменатель = total + 1. */
  function docWithKeyShare(total, withKeys) {
    const parts = ['# Имплантация зубов: руководство', ''];
    for (let i = 0; i < total; i += 1) {
      const heading = i < withKeys ? `Раздел ${i + 1} об омоложении лица` : `Раздел ${i + 1} общих сведений`;
      parts.push(`## ${heading}`, '', 'Достаточно длинный абзац секции, чтобы не сработало правило пустых секций при подсчёте.', '');
    }
    parts.push(faqBlock(10), '');
    return parts.join('\n');
  }
  const ctx = { semanticCore: { mainQueryRu: 'имплантация зубов', queryClustersRu: [], lsiTermsRu: ['омоложение'] }, wordstatKeywords: [] };

  it('доля ровно 20% (2/(9+1)) → pass (граница окна из seo-standards)', () => {
    const r = run({ markdown: docWithKeyShare(9, 2) }, ctx);
    const kw = rule(r, 'SEO-HEADINGS-KEYWORDS');
    expect(kw.status).toBe('pass');
    expect(kw.details.share).toBeGreaterThanOrEqual(0.2);
    expect(kw.severity).toBe('minor');
  });

  it('доля 15–20% (1/(5+1) ≈ 16.7%) → fail (minor): seo-requirements §5 п.4 — нижняя граница поднята 0.15→0.20', () => {
    const r = run({ markdown: docWithKeyShare(5, 1) }, ctx);
    const kw = rule(r, 'SEO-HEADINGS-KEYWORDS');
    expect(kw.status).toBe('fail');
    expect(kw.severity).toBe('minor');
    expect(kw.details.share).toBeGreaterThanOrEqual(0.15);
    expect(kw.details.share).toBeLessThan(0.2);
  });

  it('доля <15% (1/(6+1) ≈ 14.3%) → fail (minor)', () => {
    const r = run({ markdown: docWithKeyShare(6, 1) }, ctx);
    const kw = rule(r, 'SEO-HEADINGS-KEYWORDS');
    expect(kw.status).toBe('fail');
    expect(kw.severity).toBe('minor');
  });

  it('доля 51–65% (3/(4+1) = 60%) → переспама НЕТ (раньше >50% фейлило)', () => {
    const r = run({ markdown: docWithKeyShare(4, 3) }, ctx);
    expect(rule(r, 'SEO-HEADINGS-SPAM').status).toBe('pass');
  });

  it('доля >65% (2/(2+1) ≈ 66.7%) → SPAM fail (minor)', () => {
    const r = run({ markdown: docWithKeyShare(2, 2) }, ctx);
    expect(rule(r, 'SEO-HEADINGS-SPAM').status).toBe('fail');
    expect(rule(r, 'SEO-HEADINGS-SPAM').severity).toBe('minor');
  });
});

describe('C3: HEAD-SECTION-COVERAGE — fuzzy word-overlap ≥60%', () => {
  const PARA = 'Чистка лица — косметическая процедура, которая удаляет ороговевшие клетки, избытки кожного сала и загрязнения из пор, выравнивает рельеф и тон лица.';

  /** Док с заданными H2 + FAQ. */
  function docWithHeadings(h2List) {
    const parts = ['# Чистка лица: виды процедур', ''];
    for (const h of h2List) parts.push(`## ${h}`, '', PARA, '');
    parts.push(faqBlock(10, 'Чистка лица'), '');
    return parts.join('\n');
  }

  it('парафраз «Виды процедур чистки» vs «Основные виды чистки лица» → covered, pass', () => {
    const r = run(
      { markdown: docWithHeadings(['Основные виды чистки лица', 'Подготовка к процедуре', 'Уход после чистки']) },
      { topic: 'Чистка лица', formatRuSections: [
        { headingRu: 'Виды процедур чистки' },
        { headingRu: 'Подготовка к процедуре' },
        { headingRu: 'Уход после чистки' },
      ] },
    );
    const cov = rule(r, 'HEAD-SECTION-COVERAGE');
    expect(cov.status).toBe('pass');
    expect(cov.details.coverage).toBe(1);
  });

  it('чужие заголовки (нет пересечения слов плана) → NOT covered', () => {
    const r = run(
      { markdown: docWithHeadings(['История косметологии', 'Подготовка к процедуре', 'Уход после чистки']) },
      { topic: 'Чистка лица', formatRuSections: [
        { headingRu: 'Стоимость лечения' },
        { headingRu: 'Подготовка к процедуре' },
        { headingRu: 'Уход после чистки' },
      ] },
    );
    const cov = rule(r, 'HEAD-SECTION-COVERAGE');
    expect(cov.status).toBe('fail');
    expect(cov.details.missing).toContain('Стоимость лечения');
    expect(cov.details.coverage).toBeLessThan(1);
  });

  it('зоны: 100–80% pass / 79–60% minor fail / <60% major fail', () => {
    const plan = ['Секция альфа', 'Секция бета', 'Секция гамма', 'Секция дельта', 'Секция эпсилон'];
    // 5/5 → pass
    let r = run(
      { markdown: docWithHeadings(plan) },
      { topic: 'Чистка лица', formatRuSections: plan.map((h) => ({ headingRu: h })) },
    );
    expect(rule(r, 'HEAD-SECTION-COVERAGE').status).toBe('pass');
    // 4/5 = 80% → pass (граница)
    r = run(
      { markdown: docWithHeadings(plan.slice(0, 4)) },
      { topic: 'Чистка лица', formatRuSections: plan.map((h) => ({ headingRu: h })) },
    );
    expect(rule(r, 'HEAD-SECTION-COVERAGE').status).toBe('pass');
    // 3/5 = 60% → minor fail (граница)
    r = run(
      { markdown: docWithHeadings(plan.slice(0, 3)) },
      { topic: 'Чистка лица', formatRuSections: plan.map((h) => ({ headingRu: h })) },
    );
    const minor = rule(r, 'HEAD-SECTION-COVERAGE');
    expect(minor.status).toBe('fail');
    expect(minor.severity).toBe('minor');
    // 2/5 = 40% → major fail
    r = run(
      { markdown: docWithHeadings(plan.slice(0, 2)) },
      { topic: 'Чистка лица', formatRuSections: plan.map((h) => ({ headingRu: h })) },
    );
    const major = rule(r, 'HEAD-SECTION-COVERAGE');
    expect(major.status).toBe('fail');
    expect(major.severity).toBe('major');
  });

  it('G1(d): mergedHeadings исключаются из ожидаемого покрытия (слитые не «потеряны»)', () => {
    const r = run(
      { markdown: docWithHeadings(['Подготовка к чистке лица', 'Уход после процедуры']) },
      {
        topic: 'Чистка лица',
        formatRuSections: [
          { headingRu: 'Подготовка к чистке лица' },
          { headingRu: 'Побочные эффекты' }, // слита постпроцессором
          { headingRu: 'Уход после процедуры' },
        ],
        mergedHeadings: ['побочные эффекты'],
      },
    );
    const cov = rule(r, 'HEAD-SECTION-COVERAGE');
    expect(cov.status).toBe('pass');
    expect(cov.details.coverage).toBe(1);
    expect(cov.details.missing).toEqual([]);
  });

  it('mergedHeadings не спасает реально пропущенную секцию', () => {
    const r = run(
      { markdown: docWithHeadings(['Подготовка к чистке лица']) },
      {
        topic: 'Чистка лица',
        formatRuSections: [
          { headingRu: 'Подготовка к чистке лица' },
          { headingRu: 'Побочные эффекты' }, // слита
          { headingRu: 'Уход после процедуры' }, // реально НЕ написана
        ],
        mergedHeadings: ['побочные эффекты'],
      },
    );
    const cov = rule(r, 'HEAD-SECTION-COVERAGE');
    expect(cov.status).toBe('fail'); // 1/2 = 50% < 60% → major
    expect(cov.severity).toBe('major');
  });
});

/* ── ЧАСТЬ 3: прод-фикстуры «6 статей» — 3 репрезентативных паттерна ───── */

describe('ЧАСТЬ 3: прод-фикстуры quality-calibration — вердикт fail → warn/ok', () => {
  const HEALTHY = 'Чистка лица — косметическая процедура, которая удаляет ороговевшие клетки кожи, избытки кожного сала и загрязнения из пор, выравнивает рельеф и тон лица, стимулирует кровообращение. Процедура подбирается индивидуально по типу кожи после консультации косметолога.';

  it('паттерн 1 «пустые секции + перебор длины»: G1(c) убирает скелет ДО постчека → fail→warn', () => {
    // Прод-паттерн: автор оставил секцию-скелет «Побочные эффекты» + объём 2× target.
    const parts = ['# Чистка лица: виды процедур', ''];
    const sections = [
      ['Подготовка к чистке лица', 'Подготовка начинается с консультации косметолога и диагностики типа кожи: специалист оценивает противопоказания, подбирает схему процедуры и домашний уход до и после чистки лица.'],
      ['Побочные эффекты', 'Редко.'], // скелет <100 симв.
      ['Виды чисток', 'Косметология использует несколько видов чистки лица: механическую, ультразвуковую, атравматичную комбинированную и газожидкостную — выбор зависит от типа кожи и текущего состояния покровов.'],
      ['Уход после процедуры', 'После чистки лица кожа требует щадящего режима: отказ от агрессивных средств и декоративной косметики на сутки, защита от солнца SPF, увлажнение и соблюдение рекомендаций косметолога.'],
    ];
    for (const [h, body] of sections) parts.push(`## ${h}`, '', body, '');
    // Раздуваем объём до ~2× target (1000): перебор остаётся (мажор) —
    // G2 чинит его на генерации, постчек честно репортит.
    let i = 0;
    while (parts.join('\n').length < 2400) {
      i += 1;
      parts.push(`Уникальный абзац №${i} о составе процедуры и противопоказаниях, разная информация.`);
    }
    parts.push(faqBlock(10, 'Чистка лица'), '');
    const md = parts.join('\n');
    const ctx = () => cleanContext({
      topic: 'Чистка лица',
      targetLength: 1000,
      formatRuSections: sections.map(([h]) => ({ headingRu: h })),
      // semanticCore убран — паттерн «ядро не собрано» (см. паттерн 3)
      semanticCore: {},
      wordstatKeywords: [],
      hasSuccessfulFactcheckRun: true,
    });

    // ДО фикса: скелет + перебор длины = 2 major → fail.
    const before = runArticlePostcheck({ markdown: md, context: ctx() });
    expect(rule(before, 'BODY-NO-EMPTY-SECTIONS').status).toBe('fail');
    expect(rule(before, 'BODY-LENGTH-RANGE').status).toBe('fail');
    expect(before.verdict).toBe('fail');

    // ФИКС G1(c): слияние ДО постчека (как в saveFinalVersion).
    const merged = mergeEmptySections(md);
    expect(merged.count).toBe(1);
    expect(merged.mergedHeadings).toEqual(['побочные эффекты']);

    // ПОСЛЕ: скелета нет; покрытие не страдает (mergedHeadings исключены);
    // остаётся 1 major (длина) → warn.
    const after = runArticlePostcheck({
      markdown: merged.markdown,
      context: { ...ctx(), mergedHeadings: merged.mergedHeadings },
    });
    expect(rule(after, 'BODY-NO-EMPTY-SECTIONS').status).toBe('pass');
    expect(rule(after, 'HEAD-SECTION-COVERAGE').status).toBe('pass');
    expect(rule(after, 'BODY-LENGTH-RANGE').status).toBe('fail');
    expect(after.verdict).toBe('warn');
  });

  it('паттерн 2 «парафраз-покрытие»: C3 не фейлит переформулированные заголовки → fail→ok', () => {
    // Прод-паттерн: автор переформулировал заголовки плана (не дословно) —
    // старое точное сравнение считало секции «потерянными».
    const actual = [
      'Основные виды чистки лица',
      'Как подготовиться к процедуре',
      'Уход за кожей после чистки',
    ];
    const bodies = [
      'Косметология применяет несколько видов чистки лица — от механической до ультразвуковой; [подбор метода](https://example.test/services/chistka) зависит от типа кожи.',
      'Подготовка к процедуре включает отказ от агрессивного пилинга за трое суток и диагностику противопоказаний на консультации косметолога.',
      'Уход за кожей после чистки предполагает SPF-защиту, увлажнение и отказ от декоративной косметики на сутки после процедуры.',
    ];
    const planned = [
      'Виды процедур чистки',
      'Подготовка к процедуре',
      'Уход после чистки',
    ];
    const parts = ['# Чистка лица: виды процедур', ''];
    actual.forEach((h, i) => parts.push(`## ${h}`, '', bodies[i], ''));
    parts.push(formRecBlock(), '', faqBlock(10, 'Чистка лица'), '');
    const md = parts.join('\n');
    const ctx = () => cleanContext({
      topic: 'Чистка лица',
      targetLength: null, // объём не в фокусе паттерна
      formatRuSections: planned.map((h) => ({ headingRu: h })),
      semanticCore: {},
      wordstatKeywords: [],
      hasSuccessfulFactcheckRun: true,
      siteDomains: ['example.test'],
    });

    // Эмуляция СТАРОГО правила (точное совпадение) — все 3 «потеряны».
    const norm = (t) => t.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const docNorms = new Set(actual.map(norm));
    const exactMisses = planned.filter((p) => !docNorms.has(norm(p)));
    expect(exactMisses).toHaveLength(3);

    // ПОСЛЕ C3: парафразы covered → pass, вердикт ok.
    const after = runArticlePostcheck({ markdown: md, context: ctx() });
    const cov = rule(after, 'HEAD-SECTION-COVERAGE');
    expect(cov.status).toBe('pass');
    expect(cov.details.coverage).toBe(1);
    expect(after.verdict).toBe('ok');
  });

  it('паттерн 3 «fallback без SEO-ядра»: C1 + G1(c) → SEO skipped, скелет слит, fail→warn', () => {
    // Прод-паттерн: LLM деградировала → fallback-шаблон из структуры,
    // Ядра нет, семантик не дошёл. Шаблон оставляет секции-скелеты.
    const planned = [
      { headingRu: 'Что такое чистка лица', purposeRu: 'Чистка лица — косметическая процедура механического или аппаратного удаления ороговевших клеток, избытков себума и загрязнений из пор с выравниванием тона и рельефа кожи.' },
      { headingRu: 'Показания', purposeRu: 'Расширенные поры.' }, // скелет <100 симв.
      { headingRu: 'Противопоказания', purposeRu: 'Осторожность: чистка не проводится при активном воспалении, герпесе в стадии обострения и нарушении целостности кожного покрова — нужен осмотр косметолога.' },
    ];
    // Шаблон: каждая секция = purpose одной строкой.
    const parts = ['# Чистка лица: что это такое и как проходит', ''];
    for (const s of planned) parts.push(`## ${s.headingRu}`, '', s.purposeRu, '');
    const md = parts.join('\n');
    const ctx = () => cleanContext({
      topic: 'Чистка лица',
      targetLength: null, // объём не в фокусе паттерна (длину держит паттерн 1)
      formatRuSections: planned,
      semanticCore: {}, // ядро не собрано (fallback/no_token)
      wordstatKeywords: [],
      hasSuccessfulFactcheckRun: false, // fallback без фактчек-рана
      finalizedVia: 'fallback',
      structuredOutputs: {}, // истинный шаблон → FAQ-PRESENT skipped
    });

    // ДО фикса: скелетная секция (major) + нет фактчека (major) → fail.
    const before = runArticlePostcheck({ markdown: md, context: ctx() });
    expect(rule(before, 'BODY-NO-EMPTY-SECTIONS').status).toBe('fail');
    expect(rule(before, 'FACTCHECK-COVERAGE').status).toBe('fail');
    expect(before.verdict).toBe('fail');

    // ФИКС: G1(c) сливает скелет ДО постчека + C1 честно скипает SEO.
    const merged = mergeEmptySections(md);
    expect(merged.count).toBe(1);
    expect(merged.mergedHeadings).toEqual(['показания']);
    const after = runArticlePostcheck({
      markdown: merged.markdown,
      context: { ...ctx(), mergedHeadings: merged.mergedHeadings },
    });
    expect(rule(after, 'BODY-NO-EMPTY-SECTIONS').status).toBe('pass');
    for (const id of ['SEO-H1-MAINQUERY', 'SEO-HEADINGS-KEYWORDS', 'SEO-HEADINGS-SPAM']) {
      expect(rule(after, id).status).toBe('skipped');
      expect(rule(after, id).message).toMatch(/SEO-ядро не собрано/);
    }
    expect(rule(after, 'HEAD-SECTION-COVERAGE').status).toBe('pass'); // merged исключены
    // Остался 1 major (фактчек) → warn вместо fail.
    expect(after.verdict).toBe('warn');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * seo-round A5 (2026-08-22): 7 новых правил с порогами из seo-standards.
 * Синтетика pass/warn/fail на документах нормативного объёма (≥8000 симв.
 * плейн-текста — ниже шкалы правила честно skipped). Пороги объёма считаются
 * от ФАКТИЧЕСКОГО plainChars (не target) — паритет с seo-requirements §7.
 * ══════════════════════════════════════════════════════════════════════ */

describe('seo-round A5 — фикстуры нормативного объёма', () => {
  /** Уникальные нейтральные абзацы (без ключей/бренда) до нужного объёма. */
  function fillerTo(parts, minChars) {
    let i = 0;
    while (parts.join('\n').length < minChars) {
      i += 1;
      parts.push(
        `Нейтральное предложение №${i} описывает восстановительный период и домашний уход после эстетических процедур без поисковых фраз.`,
        '',
      );
    }
    return parts;
  }

  /** Документ ≥8000 симв.: H1 + интро (+ опц. intro-строки в первой зоне) + наполнитель + (опц.) хвост. */
  function longDoc({ tail = [], intro = [], minChars = 8600 } = {}) {
    const parts = ['# Лазерная эпиляция: полное руководство', '', '## Введение', '', ...intro, ''];
    fillerTo(parts, minChars);
    parts.push('## Заключение', '', 'Нейтральный итоговый абзац о консультации специалиста и индивидуальном плане ухода.', '', ...tail);
    return parts.join('\n');
  }

  /** Абзацы с вхождениями ключа (уникальные — dup-детектор молчит). */
  function keyParagraphs(key, times) {
    return Array.from({ length: times }, (_, i) => `${key} — ключевой запрос №${i + 1}, который важно раскрыть в этом абзаце текста.`);
  }

  /** FAQ-блок: первые keyCount вопросов содержат ключ. */
  function faqWithKeys(n, keyCount, key = 'лазерная эпиляция') {
    const lines = ['## 10 необычных вопросов про Лазерная эпиляция', ''];
    for (let i = 1; i <= n; i += 1) {
      const q = i <= keyCount ? `Больно ли делать ${key} в летний период?` : `Неочевидный вопрос №${i} про процедуру?`;
      lines.push(`### ${q}`, '', `Короткий честный ответ №${i} с обоснованием из двух предложений.`, '');
    }
    return lines.join('\n');
  }

  const SEO_CORE = {
    semanticCore: { mainQueryRu: 'лазерная эпиляция', queryClustersRu: [], lsiTermsRu: [] },
    siteDomains: ['example.org'],
  };
  // M2: ключи ядра приезжают через semanticCore.lsiTermsRu (частотный источник убран).
  const coreWithKeys = (keys) => ({
    ...SEO_CORE,
    semanticCore: { ...SEO_CORE.semanticCore, lsiTermsRu: keys },
  });
  const KEY = 'лазерная эпиляция';

  it('плейн-текст фикстуры действительно ≥8000 симв. (шкала активна)', () => {
    const doc = longDoc();
    expect(doc.length).toBeGreaterThan(8000);
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    // sanity: объёмные правила НЕ ушли в skip «объём меньше шкалы»
    expect(rule(r, 'KEYS-DENSITY').message).not.toMatch(/8000/);
  });

  /* ── KEYS-COUNT-BY-LENGTH ── */
  it('KEYS-COUNT-BY-LENGTH: 9 из 10 ключей в тексте при ~9k → pass (norm.min=8)', () => {
    const otherKeys = ['лазерная эпиляция бикини', 'эпиляция бикини цена', 'лазерная эпиляция подмышек',
      'эпиляция отзывы', 'лазерная эпиляция ноги', 'эпиляция зоны', 'больно ли эпиляция', 'эпиляция сколько стоит'];
    const tail = [
      ...keyParagraphs(KEY, 2),
      ...otherKeys.map((k, i) => `Абзац №${i + 1} раскрывает запрос: ${k} — подробно и по делу.`),
    ].flatMap((p) => [p, '']);
    const doc = longDoc({ tail });
    const keys = [KEY, ...otherKeys, 'эпиляция противопоказания']; // 10-й в текст не попал
    const r = run({ markdown: doc }, { ...coreWithKeys(keys), targetLength: 9000 });
    const used = rule(r, 'KEYS-COUNT-BY-LENGTH').details;
    expect(used.min).toBe(8);
    expect(used.keysUsed).toBe(9); // KEY (H1+абзацы) + 8 других; 10-й отсутствует
    expect(rule(r, 'KEYS-COUNT-BY-LENGTH').status).toBe('pass');
  });

  it('KEYS-COUNT-BY-LENGTH: 2 ключа в тексте при ~9k → major fail (<8)', () => {
    const doc = longDoc({ tail: keyParagraphs(KEY, 2).flatMap((p) => [p, '']) });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY, 'эпиляция бикини', 'эпиляция подмышек', 'эпиляция ноги', 'эпиляция зоны', 'эпиляция цена', 'эпиляция больно', 'эпиляция отзывы', 'эпиляция мужчин']), targetLength: 9000 });
    const rc = rule(r, 'KEYS-COUNT-BY-LENGTH');
    expect(rc.status).toBe('fail');
    expect(rc.severity).toBe('major');
    expect(rc.details.min).toBe(8);
  });

  it('KEYS-COUNT-BY-LENGTH: ядра нет → skipped (C1-parity)', () => {
    const r = run({}, { ...SEO_CORE, targetLength: 9000 });
    expect(rule(r, 'KEYS-COUNT-BY-LENGTH').status).toBe('skipped');
  });

  it('KEYS-COUNT-BY-LENGTH: короткий документ → skipped (шкала от 8000)', () => {
    const r = run({}, { ...coreWithKeys([KEY]), targetLength: 9000 });
    expect(rule(r, 'KEYS-COUNT-BY-LENGTH').status).toBe('skipped');
    expect(rule(r, 'KEYS-COUNT-BY-LENGTH').message).toMatch(/8000/);
  });

  /* ── KEYS-IN-TEXT-SHARE ── */
  it('KEYS-IN-TEXT-SHARE: 8 из 10 ключей в тексте → pass (≥60%)', () => {
    const used = [KEY, 'эпиляция бикини', 'эпиляция подмышек', 'эпиляция ноги', 'эпиляция зоны', 'эпиляция цена', 'эпиляция больно', 'эпиляция отзывы'];
    const tail = used.slice(1).map((k, i) => `Абзац №${i + 1} раскрывает тему: ${k} подробно.`);
    const doc = longDoc({ tail: ['', ...tail, ''] });
    const r = run({ markdown: doc }, { ...coreWithKeys([...used, 'массаж лица', 'чистка спины']), targetLength: 9000 });
    const rs = rule(r, 'KEYS-IN-TEXT-SHARE');
    expect(rs.details.share).toBeGreaterThanOrEqual(0.6);
    expect(rs.status).toBe('pass');
  });

  it('KEYS-IN-TEXT-SHARE: 3 из 10 → major fail (<60%)', () => {
    const doc = longDoc({ tail: ['', `Тема: ${KEY} раскрыта.`, 'Тема: эпиляция бикини раскрыта.', ''] });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY, 'эпиляция бикини', 'эпиляция подмышек', 'эпиляция ноги', 'эпиляция зоны', 'эпиляция цена', 'эпиляция больно', 'эпиляция отзывы', 'эпиляция мужчин']), targetLength: 9000 });
    const rs = rule(r, 'KEYS-IN-TEXT-SHARE');
    expect(rs.status).toBe('fail');
    expect(rs.severity).toBe('major');
    expect(rs.details.share).toBeLessThan(0.6);
  });

  /* ── KEYS-DENSITY ── */
  it('KEYS-DENSITY: умеренное вхождение → pass', () => {
    const doc = longDoc({ tail: keyParagraphs(KEY, 5).flatMap((p) => [p, '']) });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    expect(rule(r, 'KEYS-DENSITY').status).toBe('pass');
  });

  it('KEYS-DENSITY: плотность 3–4,5% → minor fail (warn-зона)', () => {
    const doc = longDoc({ tail: keyParagraphs(KEY, 30).flatMap((p) => [p, '']) });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    const rd = rule(r, 'KEYS-DENSITY');
    expect(rd.status).toBe('fail');
    expect(rd.severity).toBe('minor');
    expect(rd.details.density).toBeGreaterThan(0.03);
    expect(rd.details.density).toBeLessThanOrEqual(0.045);
  });

  it('KEYS-DENSITY: плотность >4,5% → major fail (переспам)', () => {
    const doc = longDoc({ tail: keyParagraphs(KEY, 50).flatMap((p) => [p, '']) });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    const rd = rule(r, 'KEYS-DENSITY');
    expect(rd.status).toBe('fail');
    expect(rd.severity).toBe('major');
    expect(rd.details.density).toBeGreaterThan(0.045);
  });

  it('KEYS-DENSITY: короткий документ → skipped', () => {
    const r = run({}, { ...coreWithKeys([KEY]), targetLength: 9000 });
    expect(rule(r, 'KEYS-DENSITY').status).toBe('skipped');
  });

  /* ── LINKS-SITE-COUNT ── */
  const siteLink = (n) => `[услуга №${n}](https://example.org/services/s${n})`;

  it('LINKS-SITE-COUNT: 3 ссылки при ~9k → pass (норма 2–4)', () => {
    const doc = longDoc({ tail: ['', siteLink(1), '', siteLink(2), '', siteLink(3), ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.details.count).toBe(3);
    expect(rl.details.min).toBe(2);
    expect(rl.details.max).toBe(4);
    expect(rl.status).toBe('pass');
  });

  it('LINKS-SITE-COUNT: 0 ссылок на домен компании → major fail', () => {
    // Внешний домен example.com НАМЕРЕННО отличается от домена сайта
    // example.org (SEO_CORE) — ссылка должна остаться чужой.
    const doc = longDoc({ tail: ['', '[внешний источник](https://example.com/article/1)', ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.status).toBe('fail');
    expect(rl.severity).toBe('major');
  });

  it('LINKS-SITE-COUNT: 1 ссылка при норме 2–4 → minor fail', () => {
    const doc = longDoc({ tail: ['', siteLink(1), ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.status).toBe('fail');
    expect(rl.severity).toBe('minor');
  });

  it('LINKS-SITE-COUNT: 5 ссылок при норме 2–4 → minor fail (перебор)', () => {
    const doc = longDoc({ tail: ['', siteLink(1), '', siteLink(2), '', siteLink(3), '', siteLink(4), '', siteLink(5), ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.status).toBe('fail');
    expect(rl.severity).toBe('minor');
  });

  it('LINKS-SITE-COUNT: домен неизвестен → skipped; фолбэк на sourceSite.baseUrl работает', () => {
    const noDomain = run({}, { ...SEO_CORE, siteDomains: undefined, wordstatKeywords: [], targetLength: 9000 });
    expect(rule(noDomain, 'LINKS-SITE-COUNT').status).toBe('skipped');
    const viaSourceSite = run(
      { markdown: longDoc({ tail: ['', siteLink(1), '', siteLink(2), ''] }) },
      { ...SEO_CORE, siteDomains: undefined, sourceSite: { name: 'Компания Пример', baseUrl: 'https://example.org/prices' }, wordstatKeywords: [], targetLength: 9000 },
    );
    expect(rule(viaSourceSite, 'LINKS-SITE-COUNT').status).toBe('pass'); // hostname фолбэк нашёл 2 ссылки
  });

  /* ── LINKS-SITE-COUNT: seo-deterministic v1.1 (п.6 + задача 5) ── */

  it('v1.1 п.6: специалист-ссылки /doctors/ НЕ считаются в окне компании (их курирует LINKS-SPECIALIST-PRESENT)', () => {
    const doc = longDoc({
      tail: [
        '', siteLink(1), '', siteLink(2), '',
        '[Иванова Анна](https://example.org/doctors/ivanova)', '',
        '[Петров Пётр](https://example.org/doctors/petrov)', '',
        '[Сидорова Мария](https://example.org/vrachi/sidorova)', '',
      ],
    });
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.details.count).toBe(2); // 3 специалист-ссылки исключены
    expect(rl.details.specialistLinksExcluded).toBe(3);
    expect(rl.status).toBe('pass'); // 2 ∈ [2..4]
  });

  it('v1.1 п.6: только специалист-ссылки → окно компании честно fail (в счёте 0–1)', () => {
    const doc = longDoc({
      tail: ['', siteLink(1), '', '[Иванова Анна](https://example.org/doctors/ivanova)', ''],
    });
    const r = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.details.count).toBe(1);
    expect(rl.details.specialistLinksExcluded).toBe(1);
    expect(rl.status).toBe('fail'); // 1 < min 2
    expect(rl.severity).toBe('minor');
  });

  it('задача 5: канона-услуги нет → min 2 при объёме ~30k (нормативный min 4 срезан)', () => {
    const doc = longDoc({ minChars: 30_000, tail: ['', siteLink(1), '', siteLink(2), ''] });
    // Контроль: с каноном норма min=4 → 2 ссылки minor fail.
    const withCanon = run(
      { markdown: doc },
      { ...SEO_CORE, canonicalServiceUrl: 'https://example.org/services/laser', wordstatKeywords: [], targetLength: 30_000 },
    );
    const rc = rule(withCanon, 'LINKS-SITE-COUNT');
    expect(rc.details.min).toBe(4);
    expect(rc.status).toBe('fail');
    expect(rc.severity).toBe('minor');

    // v1.1 задача 5: тема вне каталога услуг (канон пуст) → min 2, те же 2 ссылки pass.
    const r = run({ markdown: doc }, { ...SEO_CORE, canonicalServiceUrl: '', wordstatKeywords: [], targetLength: 30_000 });
    const rl = rule(r, 'LINKS-SITE-COUNT');
    expect(rl.details.min).toBe(2);
    expect(rl.details.canonicalServiceUrlAbsent).toBe(true);
    expect(rl.details.normativeMin).toBe(4);
    expect(rl.status).toBe('pass');
  });

  /* ── CANONICAL-LINK-ZONE ── */
  const CANON = 'https://example.org/services/laser-epilation';

  it('CANONICAL-LINK-ZONE: ссылка в первых 1200 симв. → pass', () => {
    const doc = [
      '# Лазерная эпиляция: руководство', '',
      `Подробно про [лазерную эпиляцию](https://example.org/services/laser-epilation/) в компании — описание процедуры.`,
      '',
    ];
    const parts = [...doc];
    fillerTo(parts, 8600);
    const r = run({ markdown: parts.join('\n') }, { ...SEO_CORE, canonicalServiceUrl: CANON, wordstatKeywords: [], targetLength: 9000 });
    expect(rule(r, 'CANONICAL-LINK-ZONE').status).toBe('pass');
  });

  it('CANONICAL-LINK-ZONE: ссылка есть, но за пределами 1200 симв. → minor fail', () => {
    const doc = longDoc({ tail: ['', `[лазерная эпиляция цена](${CANON})`, ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, canonicalServiceUrl: CANON, wordstatKeywords: [], targetLength: 9000 });
    const rc = rule(r, 'CANONICAL-LINK-ZONE');
    expect(rc.status).toBe('fail');
    expect(rc.severity).toBe('minor');
    expect(rc.details.position).toBeGreaterThan(1200);
  });

  it('CANONICAL-LINK-ZONE: ссылки на канон-URL нет → minor fail; URL не передан → skipped', () => {
    const doc = longDoc();
    const no = run({ markdown: doc }, { ...SEO_CORE, canonicalServiceUrl: CANON, wordstatKeywords: [], targetLength: 9000 });
    expect(rule(no, 'CANONICAL-LINK-ZONE').status).toBe('fail');
    expect(rule(no, 'CANONICAL-LINK-ZONE').severity).toBe('minor');
    const skip = run({ markdown: doc }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    expect(rule(skip, 'CANONICAL-LINK-ZONE').status).toBe('skipped');
  });

  /* ── MENTIONS-SITE-COUNT ── */
  it('MENTIONS-SITE-COUNT: 4 упоминания при ~9k (norm.min=3) → pass', () => {
    const tail = [1, 2, 3, 4].map((n) => `Абзац №${n}: специалисты компании Пример рекомендуют консультацию.`);
    const doc = longDoc({ tail: ['', ...tail, ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, sourceSite: { name: 'Пример', baseUrl: 'https://example.org' }, wordstatKeywords: [], targetLength: 9000 });
    const rm = rule(r, 'MENTIONS-SITE-COUNT');
    expect(rm.details.mentions).toBe(4);
    expect(rm.details.min).toBe(3);
    expect(rm.status).toBe('pass');
  });

  it('MENTIONS-SITE-COUNT: 1 упоминание при norm.min=3 → major fail', () => {
    const doc = longDoc({ tail: ['', 'Специалисты компании Пример подчеркивают важность консультации.', ''] });
    const r = run({ markdown: doc }, { ...SEO_CORE, sourceSite: { name: 'Пример', baseUrl: 'https://example.org' }, wordstatKeywords: [], targetLength: 9000 });
    const rm = rule(r, 'MENTIONS-SITE-COUNT');
    expect(rm.status).toBe('fail');
    expect(rm.severity).toBe('major');
  });

  it('MENTIONS-SITE-COUNT: имя компании не передано → skipped', () => {
    const r = run({}, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    expect(rule(r, 'MENTIONS-SITE-COUNT').status).toBe('skipped');
  });

  /* ── FAQ-KEYS-SHARE ── */
  it('FAQ-KEYS-SHARE: 5 из 10 вопросов с ключом → pass (≥40%)', () => {
    const doc = longDoc({ tail: [faqWithKeys(10, 5)] });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    const rf = rule(r, 'FAQ-KEYS-SHARE');
    expect(rf.details.withKeys).toBe(5);
    expect(rf.details.share).toBe(0.5);
    expect(rf.status).toBe('pass');
  });

  it('FAQ-KEYS-SHARE: 3 из 10 (30–39%) → warn-полоса v1.1 п.7: pass + WARN-пометка, НЕ fail', () => {
    const doc = longDoc({ tail: [faqWithKeys(10, 3)] });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    const rf = rule(r, 'FAQ-KEYS-SHARE');
    expect(rf.status).toBe('pass'); // fail — только при доле 0
    expect(rf.message).toMatch(/WARN/i);
    expect(rf.details.warn).toBe(true);
    expect(rf.details.share).toBe(0.3);
  });

  it('FAQ-KEYS-SHARE: 2 из 10 (<30%) → по-прежнему НЕ fail (warn-пометка ниже warn-порога)', () => {
    const doc = longDoc({ tail: [faqWithKeys(10, 2)] });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    const rf = rule(r, 'FAQ-KEYS-SHARE');
    expect(rf.status).toBe('pass'); // v1.1 п.7: fail только при доле 0
    expect(rf.message).toMatch(/WARN/i);
    expect(rf.details.warn).toBe(true);
  });

  it('FAQ-KEYS-SHARE: 0 из 10 (полный игнор) → minor fail — единственный fail-случай', () => {
    const doc = longDoc({ tail: [faqWithKeys(10, 0)] });
    const r = run({ markdown: doc }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    const rf = rule(r, 'FAQ-KEYS-SHARE');
    expect(rf.status).toBe('fail');
    expect(rf.severity).toBe('minor');
    expect(rf.details.share).toBe(0);
  });

  it('FAQ-KEYS-SHARE: ядра нет / FAQ нет → skipped', () => {
    const noCore = run({ markdown: longDoc({ tail: [faqWithKeys(10, 5)] }) }, { ...SEO_CORE, wordstatKeywords: [], targetLength: 9000 });
    expect(rule(noCore, 'FAQ-KEYS-SHARE').status).toBe('skipped');
    const noFaq = run({ markdown: longDoc() }, { ...coreWithKeys([KEY]), targetLength: 9000 });
    expect(rule(noFaq, 'FAQ-KEYS-SHARE').status).toBe('skipped');
  });

  /* ── Интеграция: вердикт не сходит с ума от новых правил ── */
  it('все 7 новых правил на чистом нормативном документе → pass/skipped, без fail', () => {
    const coreKeys = [
      KEY, 'лазерная эпиляция бикини', 'эпиляция бикини цена', 'лазерная эпиляция подмышек',
      'эпиляция отзывы пациентов', 'лазерная эпиляция ног', 'эпиляция зоны тела',
      'больно ли делать эпиляцию', 'эпиляция подмышек стоимость', 'эпиляция мужчин зона',
    ];
    const tail = [
      ...coreKeys.slice(1).map((k, i) => `Абзац №${i + 1} раскрывает запрос: ${k} — сдержанно, без переспама.`), '',
      siteLink(1), '', siteLink(2), '', siteLink(3), '',
      ...[1, 2, 3, 4, 5, 6].map((n) => `Упоминание №${n}: специалисты компании Пример рекомендуют индивидуальный план.`), '',
      faqWithKeys(10, 4),
    ];
    const doc = longDoc({
      tail: ['', ...tail],
      intro: [`Каноническая страница услуги: [лазерная эпиляция в компании](https://example.org/services/laser-epilation/) — описание процедуры.`],
      minChars: 12_000,
    });
    const r = run(
      { markdown: doc },
      {
        ...SEO_CORE,
        sourceSite: { name: 'Пример', baseUrl: 'https://example.org' },
        canonicalServiceUrl: CANON,
        ...(({ semanticCore: { ...SEO_CORE.semanticCore, lsiTermsRu: coreKeys } })),
        targetLength: 12_000,
      },
    );
    const ids = ['KEYS-COUNT-BY-LENGTH', 'KEYS-IN-TEXT-SHARE', 'KEYS-DENSITY', 'LINKS-SITE-COUNT', 'CANONICAL-LINK-ZONE', 'MENTIONS-SITE-COUNT', 'FAQ-KEYS-SHARE'];
    for (const id of ids) {
      expect(['pass', 'skipped'], `${id}: ${rule(r, id).message}`).toContain(rule(r, id).status);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * QA-приёмка seo-round: FIX-S1 (морфо-детектор вхождений), FIX-S3 (www/
 * apex-домены), FIX-S4 (SEO-DENSITY-PER-KEY + дедуп вложенных ключей).
 * ══════════════════════════════════════════════════════════════════════ */
describe('FIX-S1 — keyUsedInText: морфо-семьи + разбавленные вхождения', () => {
  it('QA-проба: «делать лазерную эпиляцию» при ключе «лазерная эпиляция» → used (словоформы)', () => {
    expect(keyUsedInText('хотите делать лазерную эпиляцию безопасно', 'лазерная эпиляция')).toBe(true);
  });

  it('QA-проба: «восковую депиляцию» при ключе «лазерная эпиляция» → НЕ used (чужая процедура)', () => {
    expect(keyUsedInText('выбираем восковую депиляцию вместо аппаратной', 'лазерная эпиляция')).toBe(false);
  });

  it('разбавленное вхождение: слова ключа в пределах окна ~10 токенов → used', () => {
    expect(keyUsedInText('лазерная безопасная и быстрая эпиляция в компании', 'лазерная эпиляция')).toBe(true);
  });

  it('разбавленное вхождение ЗА пределами окна (≈10 токенов) → НЕ used', () => {
    const far = 'лазерная очень очень очень очень очень очень очень долгая история про эпиляцию';
    expect(keyUsedInText(far, 'лазерная эпиляция')).toBe(false);
  });

  it('короткие слова ключа (<5 симв.) — только точное равенство (склонения не матчатся)', () => {
    expect(keyUsedInText('зоны бикини уход', 'зона бикини')).toBe(false); // «зона»≠«зоны» (4 симв.)
    expect(keyUsedInText('зона бикини уход', 'зона бикини')).toBe(true);
  });

  it('мульти-слово ключ: каждое слово найдено (порядок не важен, но окно одно)', () => {
    expect(keyUsedInText('эпиляция лазерная Diana', 'лазерная эпиляция')).toBe(true);
  });

  it('правила больше не дают false-fail на словоформах (QA-проба 33% → pass)', () => {
    // Текст с ЕСТЕСТВЕННЫМИ формами; ядро из 3 ключей — все использованы.
    const doc = [
      '# Лазерная эпиляция: руководство', '',
      '## Введение', '',
      'Многие хотят делать лазерную эпиляцию круглый год.', '',
      '## Уход', '',
      'После того как сделана лазерная эпиляция, нужен уход.', '',
      'Цена на лазерную эпиляцию зависит от зоны.', '',
    ].join('\n');
    const r = runArticlePostcheck({
      markdown: doc,
      html: '<h1>x</h1>',
      context: cleanContext({
        semanticCore: { mainQueryRu: 'лазерная эпиляция', queryClustersRu: [], lsiTermsRu: [
          'лазерная эпиляция',
          'лазерная эпиляция цена',
          'уход после эпиляции',
        ] },
      }),
    });
    expect(rule(r, 'KEYS-IN-TEXT-SHARE').status).toBe('pass');
    expect(rule(r, 'KEYS-IN-TEXT-SHARE').details.share).toBeGreaterThanOrEqual(0.6);
  });

  it('FAQ-вопрос со словоформой ключа считается (морфо, не подстрока)', () => {
    const faqMorpho = [
      '## 10 необычных вопросов про Лазерная эпиляция', '',
      '### Можно ли делать лазерную эпиляцию летом?', '', 'Ответ первый подробный.', '',
      '### Неочевидный вопрос №2 про процедуру?', '', 'Ответ второй подробный.', '',
    ].join('\n');
    const r = runArticlePostcheck({
      markdown: `# Тема\n\n## Секция\n\nДостаточно длинный текст секции о процедурах и уходе за кожей лица.\n\n${faqMorpho}`,
      html: '<h1>x</h1>',
      context: cleanContext({
        semanticCore: { mainQueryRu: 'лазерная эпиляция', queryClustersRu: [], lsiTermsRu: ['лазерная эпиляция'] },
      }),
    });
    expect(rule(r, 'FAQ-KEYS-SHARE').details.withKeys).toBe(1);
    expect(rule(r, 'FAQ-KEYS-SHARE').status).toBe('pass'); // 1/2 = 50% ≥ 40%, вхождение морфо
  });
});

describe('FIX-S3 — apex/www-домены компании', () => {
  it('apex-ссылка example.com считается ссылкой на домен компании www.example.com', () => {
    const doc = [
      '# Тема', '',
      '[услуга](https://example.com/services/epilyaciya/) и [ещё](https://www.example.com/about)', '',
    ].join('\n');
    const r = runArticlePostcheck({
      markdown: doc,
      html: '<h1>x</h1>',
      context: cleanContext({ siteDomains: ['www.example.com'], wordstatKeywords: [] }),
    });
    expect(rule(r, 'LINKS-PRESENT').details.count).toBe(2); // apex + www — обе ссылки на сайт
  });

  it('обратный случай: www-ссылка при apex-домене компании тоже считается', () => {
    const doc = '# Тема\n\n[услуга](https://www.example.org/services/x)';
    const r = runArticlePostcheck({
      markdown: doc,
      html: '<h1>x</h1>',
      context: cleanContext({ siteDomains: ['example.org'], wordstatKeywords: [] }),
    });
    expect(rule(r, 'LINKS-PRESENT').details.count).toBe(1);
  });

  it('чужой домен по-прежнему не матчится (m.example.com — поддомен, ок; other.test — нет)', () => {
    const doc = '# Тема\n\n[чужая](https://other.test/x)';
    const r = runArticlePostcheck({
      markdown: doc,
      html: '<h1>x</h1>',
      context: cleanContext({ siteDomains: ['www.example.com'], wordstatKeywords: [] }),
    });
    expect(rule(r, 'LINKS-PRESENT').details.count).toBe(0);
  });
});

describe('FIX-S4 — SEO-DENSITY-PER-KEY + дедуп вложенных ключей', () => {
  /** Документ ~9k с N точными вхождениями ключа. */
  function docWithRepeats(key, times) {
    const parts = ['# Лазерная эпиляция: руководство', '', '## Введение', ''];
    let i = 0;
    while (parts.join('\n').length < 8600) {
      i += 1;
      parts.push(`Нейтральное предложение №${i} про восстановление и уход без поисковых фраз.`, '');
    }
    for (let n = 1; n <= times; n += 1) {
      parts.push(`Абзац №${n}: ${key} — важный запрос, раскрыт полностью.`, '');
    }
    return parts.join('\n');
  }
  const CTX = (keys) => cleanContext({
    semanticCore: { mainQueryRu: 'лазерная эпиляция', queryClustersRu: [], lsiTermsRu: keys },
    targetLength: 9000,
  });

  it('умеренное использование → pass (доля ключа ≤1,5%)', () => {
    const r = runArticlePostcheck({ markdown: docWithRepeats('лазерная эпиляция', 6), html: '<h1>x</h1>', context: CTX(['лазерная эпиляция']) });
    expect(rule(r, 'SEO-DENSITY-PER-KEY').status).toBe('pass');
  });

  it('плотность одного ключа 1,5–2,5% → minor fail', () => {
    const r = runArticlePostcheck({ markdown: docWithRepeats('лазерная эпиляция', 12), html: '<h1>x</h1>', context: CTX(['лазерная эпиляция']) });
    const rp = rule(r, 'SEO-DENSITY-PER-KEY');
    expect(rp.status).toBe('fail');
    expect(rp.severity).toBe('minor');
    expect(rp.details.worst.share).toBeGreaterThan(0.015);
    expect(rp.details.worst.share).toBeLessThanOrEqual(0.025);
  });

  it('плотность одного ключа >2,5% → major fail', () => {
    const r = runArticlePostcheck({ markdown: docWithRepeats('лазерная эпиляция', 30), html: '<h1>x</h1>', context: CTX(['лазерная эпиляция']) });
    const rp = rule(r, 'SEO-DENSITY-PER-KEY');
    expect(rp.status).toBe('fail');
    expect(rp.severity).toBe('major');
    expect(rp.details.worst.share).toBeGreaterThan(0.025);
  });

  it('вложенные ключи дедупятся: «эпиляция» не задаивает вхождения «лазерная эпиляция»', () => {
    const r = runArticlePostcheck({ markdown: docWithRepeats('лазерная эпиляция', 10), html: '<h1>x</h1>', context: CTX(['лазерная эпиляция', 'эпиляция']) });
    const dk = rule(r, 'KEYS-DENSITY');
    const byKey = Object.fromEntries(dk.details.perKeyDensity.map((x) => [x.key, x]));
    // Длинный ключ забрал все вхождения; короткий поглощён (0 собственных).
    expect(byKey['лазерная эпиляция'].occurrences).toBeGreaterThanOrEqual(10);
    expect(byKey['эпиляция']).toBeUndefined();
  });

  it('короткий ключ со СВОИМИ отдельными вхождениями не теряется при дедупе', () => {
    const doc = docWithRepeats('лазерная эпиляция', 5).replace('## Введение', '## Введение про восковую эпиляцию отдельно');
    const r = runArticlePostcheck({ markdown: doc, html: '<h1>x</h1>', context: CTX(['лазерная эпиляция', 'эпиляция']) });
    const dk = rule(r, 'KEYS-DENSITY');
    const byKey = Object.fromEntries(dk.details.perKeyDensity.map((x) => [x.key, x]));
    expect(byKey['эпиляция'].occurrences).toBeGreaterThanOrEqual(1); // самостоятельное вхождение уцелело
  });

  it('правило в замороженном перечне (id аддитивен)', () => {
    expect(POSTCHECK_RULE_IDS).toContain('SEO-DENSITY-PER-KEY');
  });
});

/* ── B2 (2026-08-25): LINKS-SPECIALIST-PRESENT (minor/warn) ─────────────── */

describe('B2: LINKS-SPECIALIST-PRESENT — ссылка на специалиста в режиме «без автора»', () => {
  const DOCTOR_URLS = [
    'https://acme.example/doctors/ivanova',
    'https://acme.example/doctors/petrov',
    'https://acme.example/doctors/sidorova',
  ];

  /** cleanDoc + опциональная ссылка на страницу специалиста в теле. */
  const docWithSpecialistLink = (url) =>
    cleanDoc().replace(
      'Титановый [винт](https://example.test/services/implant) интегрируется',
      `Титановый [винт](https://example.test/services/implant) интегрируется. Приём ведёт [Иванова Анна Сергеевна](${url}).`
    );

  it('warn (minor-fail): специалист не выбран, в источнике ≥3 специалиста, ссылок на их страницы нет', () => {
    const r = run(
      { markdown: cleanDoc() },
      { sourceSpecialistsCount: 5, specialistPageUrls: DOCTOR_URLS }
    );
    const rp = rule(r, 'LINKS-SPECIALIST-PRESENT');
    expect(rp.status).toBe('fail');
    expect(rp.severity).toBe('minor');
    expect(rp.block).toBe('links');
    // minor-fail один → вердикт warn (режим репорта).
    expect(r.verdict).toBe('warn');
  });

  it('pass: ссылка на pageUrl из каталога присутствует', () => {
    const r = run(
      { markdown: docWithSpecialistLink(DOCTOR_URLS[0]) },
      { sourceSpecialistsCount: 5, specialistPageUrls: DOCTOR_URLS }
    );
    expect(rule(r, 'LINKS-SPECIALIST-PRESENT').status).toBe('pass');
  });

  it('pass: URL сравнивается толерантно (https/www/слэш)', () => {
    const r = run(
      { markdown: docWithSpecialistLink(`https://www.acme.example/doctors/ivanova/`) },
      { sourceSpecialistsCount: 5, specialistPageUrls: DOCTOR_URLS }
    );
    expect(rule(r, 'LINKS-SPECIALIST-PRESENT').status).toBe('pass');
  });

  it('skipped: специалист задан (подпись автора — правило SIG, не это)', () => {
    const r = run(
      { markdown: cleanDoc() },
      { specialistId: 'spec-1', sourceSpecialistsCount: 5, specialistPageUrls: DOCTOR_URLS }
    );
    expect(rule(r, 'LINKS-SPECIALIST-PRESENT').status).toBe('skipped');
  });

  it('skipped: специалистов в источнике < 3', () => {
    const r = run(
      { markdown: cleanDoc() },
      { sourceSpecialistsCount: 2, specialistPageUrls: DOCTOR_URLS.slice(0, 2) }
    );
    expect(rule(r, 'LINKS-SPECIALIST-PRESENT').status).toBe('skipped');
  });

  it('skipped: каталог не передан (легаси-вызов без sourceSpecialistsCount)', () => {
    const r = run({ markdown: cleanDoc() }, {});
    expect(rule(r, 'LINKS-SPECIALIST-PRESENT').status).toBe('skipped');
    // cleanDoc остаётся ok: правило не даёт ложных fail без данных (лояльность C1).
    expect(r.verdict).toBe('ok');
  });

  it('эвристика: каталог без pageUrl + ссылка /doctors/ в тексте → pass', () => {
    const r = run(
      { markdown: docWithSpecialistLink('https://acme.example/doctors/someone') },
      { sourceSpecialistsCount: 4, specialistPageUrls: [] }
    );
    const rp = rule(r, 'LINKS-SPECIALIST-PRESENT');
    expect(rp.status).toBe('pass');
    expect(rp.message).toContain('эвристика');
  });

  it('эвристика: каталог без pageUrl и ссылок /doctors/|/vrachi/|/team/ нет → честный skipped', () => {
    const r = run(
      { markdown: cleanDoc() },
      { sourceSpecialistsCount: 4, specialistPageUrls: [] }
    );
    const rp = rule(r, 'LINKS-SPECIALIST-PRESENT');
    expect(rp.status).toBe('skipped');
    expect(rp.message).toContain('честный skip');
  });

  it('правило в замороженном перечне рядом с остальными links-правилами', () => {
    expect(POSTCHECK_RULE_IDS).toContain('LINKS-SPECIALIST-PRESENT');
    expect(POSTCHECK_RULE_IDS.indexOf('LINKS-SPECIALIST-PRESENT')).toBeGreaterThan(
      POSTCHECK_RULE_IDS.indexOf('LINKS-NOT-IN-FAQ-SIGNATURE')
    );
  });
});

/* ── P1a (2026-09-18): BODY-NO-PROMISES (minor, report-only) — the ban on
 * medical promises and pseudoscience (audit item 5.4: no deterministic
 * detection existed — only prompts/LLM verdicts). Semantics: a minor-fail
 * never yields verdict='fail' (fail = blocker OR ≥2 major) — the rule
 * reports phrases and positions, at most raising the verdict to warn. */

describe('P1a: BODY-NO-PROMISES — запрещённые обещания и псевдонаука (report-only)', () => {
  /** cleanDoc + one paragraph per forbidden phrase (one phrase per line). */
  const docWith = (...phrases) =>
    cleanDoc() + '\n' + phrases.map((p) => `Абзац: ${p}`).join('\n\n') + '\n';

  it('pass: чистый документ — обещаний и псевдонаучных формулировок нет', () => {
    const r = rule(run(), 'BODY-NO-PROMISES');
    expect(r.status).toBe('pass');
    expect(r.severity).toBe('minor');
    expect(r.block).toBe('body');
  });

  it('fail: гарантийные обещания (все фразы ТЗ) — статусы/фразы/позиции в details', () => {
    const md = docWith(
      'Мы гарантируем результат после курса.',
      'Компания даёт гарантию 100% эффективности.',
      'Вы получите 100% результат уже через неделю.',
      'Вы навсегда избавитесь от проблемы.',
      'Процедура даёт мгновенный результат.',
      'Метод полностью безопасен для организма.',
      'Инъекции проходят без побочных эффектов.',
      'Мы излечим это заболевание за месяц.',
      'Мы вылечим вас навсегда.',
    );
    const r = rule(run({ markdown: md }), 'BODY-NO-PROMISES');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor');
    expect(r.details.count).toBeGreaterThanOrEqual(9);
    const labels = r.details.matches.map((m) => m.phrase);
    expect(labels).toContain('гарантируем результат');
    expect(labels).toContain('гарантия 100%');
    expect(labels).toContain('100% результат');
    expect(labels).toContain('навсегда избавитесь');
    expect(labels).toContain('мгновенный результат');
    expect(labels).toContain('полностью безопасно');
    expect(labels).toContain('без побочных эффектов');
    expect(labels).toContain('излечим');
    // positions: absolute offsets into the markdown, pointing at the real occurrence
    for (const m of r.details.matches) {
      expect(m.index).toBeGreaterThanOrEqual(0);
      expect(md.slice(m.index, m.index + m.snippet.length)).toBe(m.snippet);
    }
  });

  it('fail: псевдонаучные маркеры (биополе, энергетический баланс, шлаки, вывод токсинов)', () => {
    const md = docWith(
      'Воздействие на биополе пациента.',
      'Восстанавливает энергетический баланс тела.',
      'Программа очищения организма от шлаков.',
      'Токсины выводятся уже после первого сеанса.',
      'Процедура выводит токсины из организма.',
    );
    const r = rule(run({ markdown: md }), 'BODY-NO-PROMISES');
    expect(r.status).toBe('fail');
    const byGroup = r.details.matches.map((m) => m.group);
    expect(byGroup).toContain('pseudoscience');
    const labels = r.details.matches.map((m) => m.phrase);
    expect(labels).toContain('биополе');
    expect(labels).toContain('энергетический баланс');
    expect(labels).toContain('очищение от шлаков');
    expect(labels).toContain('токсины выводятся');
  });

  it('case/whitespace-варианты: ВЕРХНИЙ регистр и множественные пробелы ловятся', () => {
    const md = docWith('МЫ ГАРАНТИРУЕМ   РЕЗУЛЬТАТ', 'Гарантия На  100 %', 'мгновенный    результат');
    const r = rule(run({ markdown: md }), 'BODY-NO-PROMISES');
    expect(r.status).toBe('fail');
    const labels = r.details.matches.map((m) => m.phrase);
    expect(labels).toContain('гарантируем результат');
    expect(labels).toContain('гарантия 100%');
    expect(labels).toContain('мгновенный результат');
  });

  it('легитимный дисклеймер «НЕ гарантируем результат» — НЕ матчится (guard на отрицание)', () => {
    const md = docWith(
      'Ни один врач не гарантирует результат операции.',
      'Метод не даёт 100% результат — исход зависит от организма.',
      'Невозможно навсегда избавиться от проблемы без рецидива.',
    );
    const r = rule(run({ markdown: md }), 'BODY-NO-PROMISES');
    expect(r.status).toBe('pass');
  });

  it('морфология: гарантируем/гарантия/гарантированный результат — одна семья', () => {
    const md = docWith('Гарантированный результат после курса.', 'Гарантия результата указана в договоре.');
    const labels = rule(run({ markdown: md }), 'BODY-NO-PROMISES').details.matches.map((m) => m.phrase);
    expect(labels.filter((x) => x === 'гарантируем результат')).toHaveLength(2);
  });

  it('фразы внутри code-fence не считаются (паритет остальных BODY-правил)', () => {
    const md = cleanDoc() + '\n```\nМы гарантируем результат\n```\n';
    expect(rule(run({ markdown: md }), 'BODY-NO-PROMISES').status).toBe('pass');
  });

  it('пустой ввод не бросает', () => {
    const r = rule(runArticlePostcheck({ markdown: '', html: '', context: {} }), 'BODY-NO-PROMISES');
    expect(r.status).toBe('pass');
  });

  it('REPORT-ONLY: даже 9+ совпадений НЕ дают verdict=fail (minor не считается в fail-агрегацию)', () => {
    const md = docWith(
      'Мы гарантируем результат.',
      'Гарантия 100% на всё.',
      '100% результат гарантирован.',
      'Навсегда избавитесь от морщин.',
      'Мгновенный результат виден сразу.',
      'Полностью безопасно для здоровья.',
      'Без побочных эффектов.',
      'Мы излечим вас.',
      'Вылечим навсегда.',
      'Биополе восстанавливается.',
    );
    const report = run({ markdown: md });
    const r = rule(report, 'BODY-NO-PROMISES');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor'); // minor is not counted in the fail aggregation (blocker/≥2 major)
    expect(report.verdict).toBe('warn'); // at most warn — never fails the article in report mode
  });

  it('REPORT-ONLY: обещания + ровно 1 чужой major-fail → warn, не fail', () => {
    // HEAD-TOPIC-AS-H2 gives exactly one major-fail (H2 repeats the topic,
    // section body long enough — no empty-section major); promises add no majors.
    const md = cleanDoc().replace(
      '## Реабилитация',
      '## Имплантация зубов\n\nПовтор темы статьи отдельной секцией с достаточно длинным телом, чтобы не получать лишние major-fail по объёму секции.\n\n## Реабилитация',
    ) + '\nАбзац: Мы гарантируем результат.\n\nАбзац: Процедура полностью безопасна.\n';
    // targetLength 2200 (P2-2: cleanDoc вырос на блок записи, ≈2150 chars) —
    // избегаем второго major-fail от BODY-LENGTH-RANGE
    const report = run({ markdown: md }, { targetLength: 2200 });
    expect(rule(report, 'HEAD-TOPIC-AS-H2').status).toBe('fail');
    expect(rule(report, 'HEAD-TOPIC-AS-H2').severity).toBe('major');
    expect(rule(report, 'BODY-NO-PROMISES').status).toBe('fail');
    expect(report.verdict).toBe('warn'); // major=1 + minor — НЕ fail
  });

  it('mode не влияет: report/enforce дают одинаковый отчёт по правилу', () => {
    const base = { markdown: docWith('Мы гарантируем результат.'), html: '<p>x</p>', context: cleanContext() };
    const r1 = runArticlePostcheck(base);
    const r2 = runArticlePostcheck(base, { mode: 'enforce' });
    expect(rule(r2, 'BODY-NO-PROMISES')).toEqual(rule(r1, 'BODY-NO-PROMISES'));
  });

  it('правило в замороженном перечне рядом с остальными body NO-* фразовыми правилами', () => {
    expect(POSTCHECK_RULE_IDS).toContain('BODY-NO-PROMISES');
    expect(POSTCHECK_RULE_IDS.indexOf('BODY-NO-PROMISES')).toBeGreaterThan(
      POSTCHECK_RULE_IDS.indexOf('BODY-NO-AI-PHRASES')
    );
  });
});

/* ── P2-2: OBJ-FORMAT-HONORED + FORM-REC-PRESENT ─────────────────────── */

/** Секция возражений: n H3-вопросов с ответами (валидный формат §1.5). */
function objectionSection(n = 3, heading = 'Возражения и сомнения пациентов') {
  const lines = [`## ${heading}`, '', 'Разберём частые сомнения пациентов с опорой на факты, без давления.', ''];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`### Сомнение №${i}: правда ли это?`, '', `Спокойный ответ №${i} с опорой на источники и границами метода, без обещаний итога.`, '');
  }
  return lines.join('\n');
}

describe('OBJ-FORMAT-HONORED (major, conditional) — P2-2, паттерн TBL-FORMAT-HONORED', () => {
  /** cleanDoc с добавленной секцией возражений перед блоком записи. */
  function docWithObjection(sectionText) {
    return cleanDoc().replace(
      `${formRecBlock()}\n\n${faqBlock(10)}`,
      `${sectionText}\n\n${formRecBlock()}\n\n${faqBlock(10)}`,
    );
  }
  const promisedCtx = {
    formatRuSections: [
      { headingRu: 'Введение' },
      { headingRu: 'Возражения и сомнения пациентов', formatRu: 'возражения' },
    ],
  };

  it('skipped: структура не обещала секцию возражений (нет formatRu=«возражения»)', () => {
    const r = rule(run(), 'OBJ-FORMAT-HONORED');
    expect(r.status).toBe('skipped');
    expect(r.severity).toBe('major');
  });

  it('skipped: условность — секция в тексте ЕСТЬ, но структура её не обещала', () => {
    expect(rule(run({ markdown: docWithObjection(objectionSection(3)) }), 'OBJ-FORMAT-HONORED').status).toBe('skipped');
  });

  it('pass: обещана архитектором и написана (≥2 H3-вопросов, без обещаний)', () => {
    const r = rule(run({ markdown: docWithObjection(objectionSection(3)) }, promisedCtx), 'OBJ-FORMAT-HONORED');
    expect(r.status).toBe('pass');
    expect(r.severity).toBe('major');
  });

  it('fail (major): обещана, но секции в тексте нет', () => {
    const report = run({}, promisedCtx);
    const r = rule(report, 'OBJ-FORMAT-HONORED');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.missing).toContain('Возражения и сомнения пациентов');
    // плюс HEAD-SECTION-COVERAGE major (секция реально пропала) → 2 major → fail
    expect(rule(report, 'HEAD-SECTION-COVERAGE').status).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('fail: обещана, заголовок на месте, но секция ОПУСТОШЕНА (1 H3-вопрос < 2)', () => {
    const report = run({ markdown: docWithObjection(objectionSection(1)) }, promisedCtx);
    const r = rule(report, 'OBJ-FORMAT-HONORED');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('major');
    expect(r.details.missing).toContain('Возражения и сомнения пациентов');
    // заголовок есть → COVERAGE pass; единственный major — OBJ → warn, не fail
    expect(rule(report, 'HEAD-SECTION-COVERAGE').status).toBe('pass');
    expect(report.verdict).toBe('warn');
  });

  it('fail: внутри обещанной секции — запрещённое обещание (лексика P1a)', () => {
    const poisoned = objectionSection(2).replace(
      'Спокойный ответ №1 с опорой на источники и границами метода, без обещаний итога.',
      'Не волнуйтесь: мы гарантируем результат уже после первого визита в компанию.',
    );
    const r = rule(run({ markdown: docWithObjection(poisoned) }, promisedCtx), 'OBJ-FORMAT-HONORED');
    expect(r.status).toBe('fail');
    expect(r.details.missing).toContain('Возражения и сомнения пациентов');
  });

  it('merged-ветка (FIX-D1-паритет): заголовок слит, валидная секция есть в соседней → pass', () => {
    const report = run(
      { markdown: docWithObjection(objectionSection(3)) },
      {
        formatRuSections: [
          { headingRu: 'Введение' },
          { headingRu: 'Сомнения и мифы', formatRu: 'возражения' },
        ],
        mergedHeadings: ['сомнения и мифы'],
      },
    );
    expect(rule(report, 'OBJ-FORMAT-HONORED').status).toBe('pass');
  });

  it('merged-ветка: заголовок слит и валидной секции нигде нет → честный fail', () => {
    const r = rule(
      run({}, {
        formatRuSections: [
          { headingRu: 'Введение' },
          { headingRu: 'Сомнения и мифы', formatRu: 'возражения' },
        ],
        mergedHeadings: ['сомнения и мифы'],
      }),
      'OBJ-FORMAT-HONORED',
    );
    expect(r.status).toBe('fail');
    expect(r.details.missing).toContain('Сомнения и мифы');
  });

  it('детект по корню «миф»: обещанная секция «Мифы о процедуре» написана → pass', () => {
    const report = run(
      { markdown: docWithObjection(objectionSection(2, 'Мифы о процедуре')) },
      {
        formatRuSections: [
          { headingRu: 'Введение' },
          { headingRu: 'Мифы о процедуре', formatRu: 'возражения' },
        ],
      },
    );
    expect(rule(report, 'OBJ-FORMAT-HONORED').status).toBe('pass');
  });
});

describe('FORM-REC-PRESENT (minor, report-only) — P2-2, паттерн BODY-NO-PROMISES', () => {
  /** Документ с блоком экспертов и блоком записи в заданном порядке. */
  function docWithExpertsAndFormRec(order) {
    const experts = [
      '## Консультация специалистов компании Example Company', '',
      'Подобрать метод коррекции и составить личный план можно на очной консультации:', '',
      '- Иванова Анна Сергеевна, врач-дерматолог ([страница специалиста](https://example.test/doctors/ivanova))', '',
    ].join('\n');
    const core = [
      '# Имплантация зубов: полное руководство', '',
      '## Введение', '',
      'Имплантация — современный метод восстановления утраченных зубов с высокой приживляемостью.', '',
      '## Этапы лечения', '',
      'Лечение состоит из нескольких последовательных этапов, каждый из которых важен для итогового результата приживления.', '',
      '## Реабилитация', '',
      'После операции следует соблюдать рекомендации врача. Процесс приживления занимает от 3 до 6 месяцев.', '',
    ];
    const parts = [...core, ''];
    if (order === 'form-first') parts.push(formRecBlock(), '', experts, '');
    else parts.push(experts, '', formRecBlock(), '');
    parts.push(faqBlock(10), '');
    return parts.join('\n');
  }

  it('pass: детерминированный блок записи присутствует (cleanDoc)', () => {
    const r = rule(run(), 'FORM-REC-PRESENT');
    expect(r.status).toBe('pass');
    expect(r.severity).toBe('minor');
    expect(r.block).toBe('body');
  });

  it('REPORT-ONLY PROOF: блока нет → единственный fail в отчёте, verdict warn — НИКОГДА fail', () => {
    const md = cleanDoc().replace(`${formRecBlock()}\n\n`, '');
    const report = run({ markdown: md }, { targetLength: 1500 });
    const r = rule(report, 'FORM-REC-PRESENT');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor');
    // единственный провал всего отчёта — FORM-REC; minor не может дать verdict='fail'
    expect(report.rules.filter((x) => x.status === 'fail')).toHaveLength(1);
    expect(report.verdict).toBe('warn');
    // POSTCHECK_MODE=report не меняет вычисления (enforce-логика — снаружи, в воркере)
    const reportMode = runArticlePostcheck(
      { markdown: md, html: '<p>x</p>', context: cleanContext({ targetLength: 1500 }) },
      { mode: 'report' },
    );
    expect(rule(reportMode, 'FORM-REC-PRESENT').status).toBe('fail');
    expect(reportMode.verdict).toBe('warn');
  });

  it('fail: блок есть, но стоит ДО блока экспертов (позиция §1.3: mentions → form-rec)', () => {
    const r = rule(run({ markdown: docWithExpertsAndFormRec('form-first') }, { targetLength: null }), 'FORM-REC-PRESENT');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('minor');
    expect(r.details.position).toBe('before-experts-block');
  });

  it('pass: блок стоит ПОСЛЕ блока экспертов (штатный порядок конвейера)', () => {
    const r = rule(run({ markdown: docWithExpertsAndFormRec('experts-first') }, { targetLength: null }), 'FORM-REC-PRESENT');
    expect(r.status).toBe('pass');
  });

  it('legacy-заголовок блока экспертов (статья, сохранённая до перехода) — зона экспертов распознаётся', () => {
    // Технический маркер старого формата собран из фрагментов: в файле нет слов одной отрасли.
    const legacyHeading = ['## Консультация специалистов ', 'клини', 'ки Example Company'].join('');
    const experts = [
      legacyHeading, '',
      'Подобрать решение и составить личный план можно на консультации:', '',
      '- Иванова Анна Сергеевна, эксперт ([страница специалиста](https://example.test/doctors/ivanova))', '',
    ].join('\n');
    const core = [
      '# Тема статьи: полное руководство', '',
      '## Введение', '',
      'Абзац введения с описанием задачи и её решения.', '',
    ];
    const md = [...core, experts, formRecBlock(), '', faqBlock(10), ''].join('\n');
    const r = rule(run({ markdown: md }, { targetLength: null }), 'FORM-REC-PRESENT');
    // Блок записи после legacy-заголовка экспертов — порядок конвейера соблюдён.
    expect(r.status).toBe('pass');
    // А блок записи ПЕРЕД legacy-заголовком — нарушение порядка (legacy распознаётся).
    const mdBad = [...core, formRecBlock(), '', experts, '', faqBlock(10), ''].join('\n');
    const rBad = rule(run({ markdown: mdBad }, { targetLength: null }), 'FORM-REC-PRESENT');
    expect(rBad.status).toBe('fail');
    expect(rBad.details.position).toBe('before-experts-block');
  });

  it('правила в замороженном перечне: OBJ сразу после TBL, FORM-REC сразу после FAQ-QA-FORMAT', () => {
    expect(POSTCHECK_RULE_IDS).toContain('OBJ-FORMAT-HONORED');
    expect(POSTCHECK_RULE_IDS.indexOf('OBJ-FORMAT-HONORED')).toBe(
      POSTCHECK_RULE_IDS.indexOf('TBL-FORMAT-HONORED') + 1,
    );
    expect(POSTCHECK_RULE_IDS).toContain('FORM-REC-PRESENT');
    expect(POSTCHECK_RULE_IDS.indexOf('FORM-REC-PRESENT')).toBe(
      POSTCHECK_RULE_IDS.indexOf('FAQ-QA-FORMAT') + 1,
    );
  });
});
