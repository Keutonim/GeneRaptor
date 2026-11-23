import { describe, it, expect } from 'vitest';
import { agentRoleMap } from '../../server/agent-role-data.mjs';

/**
 * B4: the article-author prompt must NOT ask the model to insert internal links
 * to services/specialists, because a programmatic internal-linker
 * (server/lib/internal-linker.mjs, maxLinks=8, anchor dedup) runs in
 * saveFinalVersion AFTER all roles. Two injection points caused duplicate/spammy
 * anchors. The {{src:N}} requirement (for external sources / bibliography B2)
 * must STAY.
 */
describe('article-author prompt — internal linking (B4)', () => {
  const role = agentRoleMap.get('article-author');
  const prompt = role?.systemPrompt ?? '';

  it('has an article-author role', () => {
    expect(role).toBeTruthy();
  });

  it('does NOT instruct the model to add service/site internal links', () => {
    // The removed instruction told the model to add `[Название услуги](URL)`
    // markdown links to the site. None of these phrases should remain.
    expect(prompt).not.toMatch(/Внутренняя перелинковка/i);
    expect(prompt).not.toMatch(/добавляй markdown-ссылку на страницу услуги/i);
    expect(prompt).not.toMatch(/Не более 3 внутренних ссылок на сайт компании/i);
  });

  it('does NOT reference serviceUrl for link insertion', () => {
    // The old text said "URL указан в карточке услуги в поле serviceUrl".
    // serviceUrl is still a valid card field, but it must not be tied to a
    // "add a link" instruction. We only assert the link-instruction phrasing
    // is gone (serviceUrl may legitimately appear elsewhere).
    expect(prompt).not.toMatch(/поле serviceUrl\)`/i);
  });

  it('STILL requires {{src:N}} markers for external sources', () => {
    expect(prompt).toMatch(/\{\{src:N\}\}/);
  });

  it('STILL requires the sourceMapRu registry', () => {
    expect(prompt).toMatch(/sourceMapRu/);
  });
});

/**
 * P1 (2026-08-16): ключевые слова в заголовках H1/H2/H3.
 * Разрыв: wordstat-блок видели только semantic-strategist + article-author,
 * а structure-architect (планировщик заголовков!) — лишь lossy-summary
 * семантики. Промпты четырёх ролей синхронизированы вокруг SEO-ядра:
 * архитектор размечает вхождения в заголовки, автор соблюдает разметку,
 * seo-reviewer проверяет проценты и переспам, humanizer не разрушает ключи
 * при перефразировании.
 */
describe('prompts — SEO-ключи в заголовках H1/H2/H3 (P1)', () => {
  const architect = agentRoleMap.get('structure-architect')?.systemPrompt ?? '';
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';
  const seoReviewer = agentRoleMap.get('seo-reviewer')?.systemPrompt ?? '';
  const humanizer = agentRoleMap.get('humanizer')?.systemPrompt ?? '';

  it('structure-architect: H1 — вхождение mainQueryRu; 30–50% H2/H3 — с кластерами/LSI', () => {
    expect(architect).toMatch(/H1/iu);
    expect(architect).toMatch(/mainQueryRu/);
    expect(architect).toMatch(/30\s*[–-]\s*50%/);
    expect(architect).toMatch(/H2\/H3/iu);
  });

  it('structure-architect: заголовки читабельны — не в каждый, без спама и перечислений ключей', () => {
    expect(architect).toMatch(/не в каждый/iu);
    expect(architect).toMatch(/без спама/iu);
    expect(architect).toMatch(/перечислен/iu);
  });

  it('article-author: соблюдает SEO-разметку заголовков архитектора, не переусердствует', () => {
    expect(author).toMatch(/SEO-разметку заголовков/iu);
    expect(author).toMatch(/главный запрос[^\n]*H1/iu);
    expect(author).toMatch(/H2\/H3/iu);
    expect(author).toMatch(/не переусердствуй/iu);
  });

  it('seo-reviewer: проверяет главный запрос в H1, 30–50% H2/H3, переспам — флаг', () => {
    expect(seoReviewer).toMatch(/главный запрос[^\n]*H1/iu);
    expect(seoReviewer).toMatch(/30\s*[–-]\s*50%/);
    expect(seoReviewer).toMatch(/H2\/H3/iu);
    expect(seoReviewer).toMatch(/переспам/iu);
    expect(seoReviewer).toMatch(/seoFixesRu/);
  });

  it('humanizer: перефразируя, сохраняет ключевые слова в заголовках без изменений', () => {
    expect(humanizer).toMatch(/сохраня[йя] ключевые слова в заголовках без изменений/iu);
  });
});

/**
 * T1 (fix/article-quality-2026-08-14): сравнительные markdown-таблицы.
 * structure-architect помечает сравнительные секции formatRu: 'таблица',
 * article-author оформляет их GFM-таблицей (1–2 на статью), humanizer
 * обязан сохранять таблицы как есть.
 */
describe('prompts — сравнительные GFM-таблицы (T1)', () => {
  const architect = agentRoleMap.get('structure-architect')?.systemPrompt ?? '';
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';
  const humanizer = agentRoleMap.get('humanizer')?.systemPrompt ?? '';

  it('structure-architect: помечает сравнительные секции форматом таблица (максимум 1–2)', () => {
    expect(architect).toMatch(/formatRu/i);
    expect(architect).toMatch(/таблиц/i);
    expect(architect).toMatch(/1\s*[–-]\s*2\s*таблиц/iu);
  });

  it('article-author: оформляет помеченные секции GFM-таблицей с разделительной строкой', () => {
    expect(author).toMatch(/GFM-таблиц/i);
    expect(author).toMatch(/\|\s*a\s*\|\s*b\s*\|/i);
    expect(author).toMatch(/1\s*[–-]\s*2\s*таблиц/iu);
    expect(author).toMatch(/ячейк[а-я]*\s*[—-]\s*короткие фразы/iu);
  });

  it('humanizer: сохраняет markdown-таблицы, не разворачивает в текст', () => {
    expect(humanizer).toMatch(/таблиц[а-я]*\s+сохраня[йя] как есть/i);
    expect(humanizer).toMatch(/не разворачивай в текст/i);
  });
});

/**
 * P2 (2026-08-16): голос повествования и автоматическая подпись.
 * Статья пишется от лица КОМПАНИИ (безлично-профессионально, «мы»/«компания»),
 * а НЕ от первого лица специалиста; стиль научно-деловой + продающий.
 * Автор НЕ подписывается сам — подпись «Автор статьи: ФИО, должность»
 * добавляется программно в saveFinalVersion из карточки специалиста.
 */
describe('prompts — голос компании и автоматическая подпись (P2)', () => {
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';
  const brief = agentRoleMap.get('brief-preparer')?.systemPrompt ?? '';
  const humanizer = agentRoleMap.get('humanizer')?.systemPrompt ?? '';

  it('article-author: пишет от лица компании, НЕ от первого лица специалиста', () => {
    expect(author).toMatch(/от лица компании/iu);
    expect(author).toMatch(/НЕ от первого лица специалиста/iu);
  });

  it('article-author: стиль научно-деловой и одновременно продающий, мягкий CTA', () => {
    expect(author).toMatch(/научно-деловой/iu);
    expect(author).toMatch(/одновременно продающ/iu);
    expect(author).toMatch(/призыв к действию/iu);
  });

  it('article-author: НЕ подписывается сам — подпись добавляется автоматически', () => {
    expect(author).toMatch(/НЕ подписывайся сам/iu);
    expect(author).toMatch(/подпись[а-яё]*\s+(?:автора\s+)?добавляется автоматически/iu);
  });

  it('brief-preparer: тональность брифа — голос компании, подпись автоматическая', () => {
    expect(brief).toMatch(/от лица компании/iu);
    expect(brief).toMatch(/НЕ от первого лица специалиста/iu);
    expect(brief).toMatch(/подпись[а-яё]*\s+[а-яё]*\s*добавляется автоматически/iu);
  });

  it('humanizer: не меняет лицо повествования', () => {
    expect(humanizer).toMatch(/не меняй лицо повествования/iu);
  });
});

/**
 * W2.4 (2026-08-17): FAQ генерируется автоматически.
 * Finding W1-deploy: в одной прод-статье 3 FAQ-подобные секции («Часто
 * задаваемые вопросы (FAQ)», «Ответы на частые вопросы», «10 необычных
 * вопросов») — промпт автора ТРЕБОВАЛ включить FAQ-раздел структуры в
 * articleMarkdownRu, а финальный FAQ ещё и вставляет конвейер. Теперь автор
 * НЕ пишет собственный FAQ-блок (профилактика FAQ-UNIQUENESS валидатора W2),
 * архитектор не планирует FAQ-секцию; faqIntentsRu остаётся данными
 * SEO-ядра (semantic-strategist), а не инструкцией писать секцию FAQ.
 */
describe('prompts — FAQ генерируется автоматически (W2.4)', () => {
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';
  const architect = agentRoleMap.get('structure-architect');
  const seoReviewer = agentRoleMap.get('seo-reviewer')?.systemPrompt ?? '';
  const semantic = agentRoleMap.get('semantic-strategist')?.systemPrompt ?? '';

  it('article-author: НЕ пиши собственный FAQ-блок — финальный FAQ генерируется автоматически', () => {
    expect(author).toMatch(/НЕ пиши собственный FAQ-блок/iu);
    expect(author).toMatch(/финальный FAQ генерируется автоматически/iu);
  });

  it('article-author: старая инструкция про обязательный FAQ-раздел удалена', () => {
    expect(author).not.toMatch(/обязательно включи его внутрь articleMarkdownRu/iu);
    expect(author).not.toMatch(/Не оставляй FAQ только в поле faqRu/iu);
  });

  it('article-author: поле faqRu контракта по-прежнему заполняется', () => {
    expect(author).toMatch(/faqRu/);
  });

  // U5 (2026-08-20): запрет служебных пометок продолжения в промпте автора —
  // профилактика чанк-артефактов («Продолжение следует в следующем батче...»).
  it('article-author: НЕ пиши служебных пометок о продолжении (U5)', () => {
    expect(author).toMatch(/НЕ пиши служебных пометок о продолжении/iu);
    expect(author).toMatch(/«Продолжение следует»/u);
    expect(author).toMatch(/«в следующем батче»/u);
    expect(author).toMatch(/статья собирается автоматически/iu);
  });

  it('structure-architect: qualityGate больше не требует FAQ в структуре', () => {
    expect(architect?.qualityGate).not.toMatch(/блоки,\s*FAQ/iu);
    expect(architect?.qualityGate).toMatch(/FAQ/iu); // и поясняет, почему
    expect(architect?.qualityGate).toMatch(/автоматическ/iu);
  });

  it('seo-reviewer: не требует создавать/писать FAQ-секцию', () => {
    expect(seoReviewer).not.toMatch(/(?:раздел|секци[а-яё]*)\s+FAQ|FAQ-секц|##\s*FAQ/iu);
  });

  it('semantic-strategist: systemPrompt не инструктирует писать FAQ-секцию (faqIntentsRu — SEO-ядро)', () => {
    expect(semantic).not.toMatch(/FAQ/iu);
  });
});

/**
 * F4 (quality-final 2026-08-21): H1-ключ. e2e — статьи выходили с H1 без
 * главного запроса (mainQueryRu) при живом SEO-ядре. Промпт article-author
 * усилeн: H1 СТРОГО содержит главный запрос почти дословно — обязательное
 * требование, а не пожелание.
 */
describe('prompts — H1-ключ: mainQueryRu строго в H1 (F4)', () => {
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';

  it('article-author: H1 СТРОГО содержит главный запрос (mainQueryRu) почти дословно', () => {
    expect(author).toMatch(/H1 СТРОГО содержит главный запрос статьи \(mainQueryRu\)/u);
    expect(author).toMatch(/почти дословно/u);
    // Допущены только естественные предлоги/порядок слов.
    expect(author).toMatch(/естественн[а-яё]*\s+предлог[а-яё]*/u);
    // Это обязательное требование, а не рекомендация.
    expect(author).toMatch(/обязательное требование/u);
  });

  it('регресс: прежняя SEO-разметка заголовков не сломана', () => {
    expect(author).toMatch(/SEO-разметку заголовков/iu);
    expect(author).toMatch(/главный запрос[^\n]*H1/iu);
    expect(author).toMatch(/H2\/H3/iu);
    expect(author).toMatch(/не переусердствуй/iu);
  });
});

/**
 * W2 (2026-08-22): SEO-норматив в промптах автора/архитектора.
 * Норматив seo-requirements: каждый ключ ядра ≥1 раз; mainQuery 3–5 на ~10k
 * (масштаб по объёму); упоминания компании 1/1500–2500 симв., первое — в интро,
 * последнее — в выводе, формы варьируются, бренд НЕ в H1; запрет служебных строк
 * «Источник:»; ссылки по-прежнему добавляет только система (B4 жив).
 */
describe('prompts — SEO-ядро, упоминания компании, служебные строки (W2, seo-round)', () => {
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';
  const architect = agentRoleMap.get('structure-architect')?.systemPrompt ?? '';

  it('article-author: SEO-ядро в тексте — плотностные границы (wordstat-источник убран в M2)', () => {
    expect(author).toContain('SEO-ЯДРО В ТЕКСТЕ');
    expect(author).not.toContain('Wordstat'); // мёртвая ссылка на убранный блок снята
    expect(author).toContain('≤3% текста');
  });

  it('article-author: главный запрос 3–5 раз для ~10к, масштаб по объёму', () => {
    expect(author).toMatch(/mainQueryRu\)[^\n]*3–5 раз/u);
    expect(author).toContain('~10 000 символов');
    expect(author).toMatch(/5–8 раз/u);
    expect(author).toMatch(/8–12/u);
  });

  it('article-author: антиспам-границы вхождений (1/400–500 симв., 2 абзаца)', () => {
    expect(author).toMatch(/не чаще 1 раза на 400–500 символов/u);
    expect(author).toMatch(/минимум 2 абзаца/u);
  });

  it('article-author: упоминания компании — темп 1/1500–2500, интро+вывод, формы', () => {
    expect(author).toContain('УПОМИНАНИЯ КОМПАНИИ');
    expect(author).toMatch(/первых 1500 символах текста \(интро\)/u);
    expect(author).toMatch(/1 раз на каждые 1500–2500 символов/u);
    expect(author).toMatch(/последнее упоминание — в заключении/u);
    expect(author).toContain('«компания {название}»');
    expect(author).toContain('«специалисты {название}»');
    expect(author).toContain('«в {название}»');
  });

  it('article-author: бренд НЕ в H1 и не чаще 1 раза в H2/H3; имя — только из контекста', () => {
    expect(author).toMatch(/НЕ вставляй название компании в H1/u);
    expect(author).toMatch(/заголовках H2\/H3 чаще 1 раза на статью/u);
    expect(author).toMatch(/НЕ выдумывай имя/u);
  });

  it('article-author: запрет служебных строк «Источник:» и подписей-заглушек', () => {
    expect(author).toContain('СЛУЖЕБНЫЕ СТРОКИ');
    expect(author).toContain('«Источник:»');
    expect(author).toContain('«Источник: —»');
    expect(author).toMatch(/строк-подписей в тексте быть не должно/u);
    // Запрет не подрывает обязательные маркеры источников ({{src:N}} остаются).
    expect(author).toMatch(/\{\{src:N\}\}/);
  });

  it('article-author: ссылки по-прежнему ставит только система (регресс B4)', () => {
    expect(author).toMatch(/НЕ вставляй markdown-ссылки на услуги\/специалистов\/сайт компании самостоятельно/u);
  });

  it('structure-architect: окно 30–50% синхронизировано с нормативом (20%/65%)', () => {
    expect(architect).toMatch(/30–50% заголовков H2\/H3/u);
    expect(architect).toMatch(/меньше 20% заголовков с ключами — недооптимизация, больше 65% — переспам/u);
    expect(architect).toMatch(/кластерные запросы ставь преимущественно в H2/u);
    expect(architect).toMatch(/узкие «хвосты» — в H3/u);
  });

  it('регресс: прежние опоры промптов живы после вставки W2-блоков', () => {
    expect(author).toMatch(/SEO-разметку заголовков/iu);
    expect(author).toMatch(/не переусердствуй/iu);
    expect(author).toMatch(/ГОЛОС ПОВЕСТВОВАНИЯ/u);
    // Бюджет длины промпта (DoD W2: ≤ прежнего + 2КБ) — верхний предохранитель.
    expect(author.length).toBeLessThan(11000);
  });
});

/**
 * quality-calibration G1(a)/(b)/G3 (2026-08-21): прод-данные 6 статей —
 * BODY-NO-EMPTY-SECTIONS 6/6 (архитектор плодил план, который автор не
 * заполнял), TBL-FORMAT-HONORED (секции «оформи таблицей» выходили текстом).
 * Промпты: архитектор планирует реалистичное число секций под объём; автор
 * пишет минимум 2 абзаца на секцию / объединяет пустые с соседними; секции
 * с маркером таблицы — ОБЯЗАТЕЛЬНО с GFM-таблицей.
 */
describe('prompts — quality-calibration G1(a)/(b)/G3', () => {
  const architect = agentRoleMap.get('structure-architect')?.systemPrompt ?? '';
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';

  it('structure-architect: реалистичное число секций под объём (6–9 H2 на ~10 000 символов)', () => {
    expect(architect).toMatch(/ЧИСЛО СЕКЦИЙ ПОД ОБЪЁМ/iu);
    expect(architect).toMatch(/6\s*[–-]\s*9\s+H2-секций/iu);
    expect(architect).toMatch(/10\s*000\s+символов/iu);
    // Не составляй план, который автор не заполнит.
    expect(architect).toMatch(/не\s+составляй план, который автор/iu);
    expect(architect).toMatch(/скелет из заголовков/iu);
  });

  it('article-author: КАЖДАЯ секция — минимум 2 абзаца содержимого (G1b)', () => {
    expect(author).toMatch(/ПОЛНОТА СЕКЦИЙ/iu);
    expect(author).toMatch(/минимум 2 абзаца/iu);
  });

  it('article-author: нечего сказать — объединить с соседней, НЕ оставлять скелет (G1b)', () => {
    expect(author).toMatch(/нечего содержательного сказать/iu);
    expect(author).toMatch(/НЕ оставляй заголовок-скелет/iu);
    expect(author).toMatch(/объединяй её с соседней секцией/iu);
  });

  it('article-author: секции с маркером «(оформи таблицей)» — ОБЯЗАТЕЛЬНО GFM-таблица (G3)', () => {
    expect(author).toMatch(/\(оформи таблицей\)/iu);
    expect(author).toMatch(/ОБЯЗАТЕЛЬНО оформляются GFM-таблицей/iu);
    // Обратная связь: таблица в помеченной секции — не опция.
    expect(author).toMatch(/брак секции/iu);
  });

  it('регресс: старые опоры промптов живы (структура/объём/таблицы)', () => {
    expect(author).toMatch(/Сгенерируй строго ВСЕ разделы/iu);
    expect(author).toMatch(/\{\{articleLength\}\}/);
    expect(author).toMatch(/GFM-таблиц/i);
    expect(author).toMatch(/1\s*[–-]\s*2\s*таблиц/iu);
  });
});

/**
 * FIX-DEN (§6-A2, 2026-08-25): баланс плотности SEO-ядра. e2e-статьи выходили
 * с переспамом: «используй КАЖДУЮ ключевую фразу минимум 1 раз» без верхней
 * границы гнало модель к максимальному охвату. Баланс-абзац добавлен в SEO-ЯДРО
 * В ТЕКСТЕ сразу после «минимум 1 раз»: плотность важнее охвата.
 */
describe('prompts — FIX-DEN: баланс плотности SEO-ядра (§6-A2)', () => {
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';

  it('после «минимум 1 раз» — баланс: плотность важнее охвата', () => {
    expect(author).toContain('НО плотность важнее охвата');
    // Баланс идёт СРАЗУ после требования охвата (до норматива главного запроса).
    const coverageIdx = author.indexOf('минимум 1 раз в тексте статьи');
    const balanceIdx = author.indexOf('НО плотность важнее охвата');
    expect(coverageIdx).toBeGreaterThan(-1);
    expect(balanceIdx).toBeGreaterThan(coverageIdx);
    expect(balanceIdx - coverageIdx).toBeLessThan(200);
  });

  it('каждый ключ — 1–2 вхождения максимум', () => {
    expect(author).toMatch(/каждый ключ[^\n]*максимум 1–2 вхождения/u);
  });

  it('главный запрос — не более верхней нормы по объёму статьи', () => {
    expect(author).toMatch(/главный запрос[^\n]*не более верхней нормы по объёму статьи/u);
  });

  it('суммарная плотность ключей ≤3% текста', () => {
    expect(author).toMatch(/суммарная плотность всех ключей — ≤3% текста/u);
  });

  it('не повторяй ключ в соседних абзацах; ключи максимум в половине заголовков', () => {
    expect(author).toMatch(/не повторяй один и тот же ключ в соседних абзацах/u);
    expect(author).toMatch(/ключевые фразы — максимум в половине заголовков/u);
  });

  it('регресс: прежний охват («КАЖДУЮ… минимум 1 раз») и норматив главного запроса живы', () => {
    expect(author).toContain('используй КАЖДУЮ ключевую фразу');
    expect(author).toContain('минимум 1 раз в тексте статьи');
    expect(author).toMatch(/mainQueryRu\)[^\n]*3–5 раз/u);
  });
});

/**
 * B2 (2026-08-25): авторство — два режима ГОЛОСА ПОВЕСТВОВАНИЯ в статическом
 * промпте автора (активный режим выбирает динамический блок в user-сообщении,
 * см. agent-role-execution.test.mjs):
 *   (а) СПЕЦИАЛИСТ ВЫБРАН — от лица компании + 2–3 вставки от первого лица
 *       специалиста с единым шаблоном «💡 {Имя} {Отчество}, {должность}: …»;
 *   (б) СПЕЦИАЛИСТ НЕ ВЫБРАН — безлично от компании, упоминания 2–4 РАЗНЫХ
 *       реальных специалистов каталога, БЕЗ ссылок (их ставит только линкер — И1).
 */
describe('prompts — B2: два режима голоса повествования автора', () => {
  const author = agentRoleMap.get('article-author')?.systemPrompt ?? '';

  it('режим (а): вставки от первого лица специалиста, единый шаблон «💡 …»', () => {
    expect(author).toMatch(/СПЕЦИАЛИСТ ВЫБРАН/u);
    expect(author).toMatch(/2–3 короткие вставки от первого лица выбранного специалиста/u);
    expect(author).toMatch(/💡 \{Имя\} \{Отчество\}, \{должность\}: \{рекомендация\}/u);
    expect(author).toMatch(/тематически уместные места статьи, НЕ в конец/u);
  });

  it('режим (б): безлично от компании + 2–4 РАЗНЫХ реальных специалиста каталога', () => {
    expect(author).toMatch(/СПЕЦИАЛИСТ НЕ ВЫБРАН/u);
    expect(author).toMatch(/упомяни 2–4 РАЗНЫХ специалистов/u);
    expect(author).toMatch(/только реальные имена из каталога/u);
  });

  it('инвариант И1: автор НЕ ставит markdown-ссылки на специалистов — их добавит система', () => {
    expect(author).toMatch(/markdown-ссылки на специалистов НЕ ставь[^\n]*их добавит система/u);
  });

  it('регресс P2: безличный базовый голос, НЕ от первого лица специалиста (вне вставок)', () => {
    expect(author).toMatch(/от лица компании/iu);
    expect(author).toMatch(/НЕ от первого лица специалиста/iu);
    expect(author).toMatch(/научно-деловой/iu);
    expect(author).toMatch(/призыв к действию/iu);
  });

  it('регресс P2: НЕ подписывайся сам — подпись добавляется автоматически', () => {
    expect(author).toMatch(/НЕ подписывайся сам/iu);
    expect(author).toMatch(/подпись[а-яё]*\s+(?:автора\s+)?добавляется автоматически/iu);
  });
});
