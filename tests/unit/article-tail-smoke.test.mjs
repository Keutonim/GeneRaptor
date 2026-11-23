import { describe, it, expect } from 'vitest';
import { stripCitations } from '../../server/lib/strip-citations.mjs';
import { sanitizeArticle } from '../../server/lib/article-sanitizer.mjs';
import { normalizeHeadings } from '../../server/lib/heading-normalizer.mjs';
import { injectInternalLinks } from '../../server/lib/internal-linker.mjs';
import { generateUnusualFaqMarkdown, hasUnusualFaqSection } from '../../server/lib/faq-generator.mjs';
import { renderMarkdownToHtml, htmlToPlainText } from '../../server/lib/markdown-renderer.mjs';
import {
  appendUpdatedDateLine,
  extractFaqEntries,
  buildArticleJsonLd,
  attachArticleJsonLd,
} from '../../server/lib/article-view-meta.mjs';

/**
 * Интеграционный смоук «хвост статьи» (QA, 2026-08-16, content-pool P2/P3/P4).
 *
 * Юнит-склейка финальной сборки saveFinalVersion воркера БЕЗ БД и БЕЗ сети
 * (LLM-вызов FAQ инъектится через callFn). Порядок шагов 1:1 как в воркере:
 *
 *   extract (humanizer-вывод → stripCitations) → sanitizeArticle
 *   → normalizeHeadings → injectInternalLinks → FAQ «10 необычных вопросов»
 *   (генерация + СОБСТВЕННЫЙ sanitize, вставка + normalize в контексте
 *   документа) → строка «Обновлено» (P1b, до подписи) → подпись автора
 *   → renderMarkdownToHtml → htmlToPlainText (ДО JSON-LD) → JSON-LD в html
 *   (P1c, ПОСЛЕ постчек-входа — в воркере между runPostcheckAndPersist и
 *   articleVersion.create).
 *
 * Вход — синтетический «грязный» markdown: CJK-вставка, кривые заголовки
 * (прыжок H1→H3, второй H1 в середине), тех. секции («## Источники»,
 * «### Дополнительная экспертная информация»), маркер {{src:1}}, легитимная
 * секция «Источники данных для пациентов», инлайн-ссылки.
 */

const TOPIC = 'Имплантация зубов';
const H1 = 'Имплантация зубов: полное руководство для пациентов';
const SPECIALIST = { fullName: 'Иванов Иван Иванович', position: 'Врач-имплантолог' };
const SIGNATURE_MD = '**Автор статьи:** Иванов Иван Иванович, Врач-имплантолог';
// P1b: фиксированная дата версии (в воркере — versionTimestamp = new Date()).
const UPDATED_AT = new Date(2026, 8, 18, 12, 0, 0);
const UPDATED_LINE = '*Обновлено: 18.09.2026*';

const DIRTY_HUMANIZER_MD = [
  `# ${H1}`,
  '',
  'Вводный абзац: современные методы описаны [в обзоре методик](https://example.com/method). {{src:1}}',
  '',
  '综上所述，种植牙是一种可靠的修复方式。',
  '',
  '### Виды имплантации', // кривой уровень: прыжок H1 → H3
  '',
  'Одноэтапная и двухэтапная имплантация, а также протокол All-on-4.',
  '',
  '# Почему выбирают нашу компанию', // второй H1 в середине документа
  '',
  'Опыт хирургов и стерильность операционных.',
  '',
  '## Цены на имплантацию',
  '',
  'Стоимость складывается из количества имплантов и типа коронки.',
  '',
  '### Дополнительная экспертная информация', // тех. секция уровня H3
  '',
  '- пункт раз',
  '- пункт два',
  '',
  '## Заключение',
  '',
  'Имплантация — предсказуемый метод восстановления зубов при правильном планировании.',
  '',
  '## Источники данных для пациентов', // легитимная секция — должна выжить
  '',
  'Официальные материалы для пациентов по стоматологии.',
  '',
  '## Источники', // тех. секция в конце — должна быть вырезана
  '',
  '1. [Источник 1](https://example.com/source-1)',
  '2. [Источник 2](https://example.com/source-2)',
].join('\n');

const CATALOG = {
  services: [{ name: 'All-on-4', url: 'https://acme.example/uslugi/all-on-4' }],
  specialists: [{ fullName: 'Петров Пётр Петрович', pageUrl: 'https://acme.example/vrachi/petrov' }],
};

/** LLM-ответ FAQ: 10 уникальных + 1 дубль (регистр/пробелы) → после dedupe ровно 10. */
const FAQ_ITEMS = [
  ...Array.from({ length: 10 }, (_, i) => ({
    question: `Неочевидный вопрос про имплантацию №${i + 1}?`,
    answer: `Краткий ответ №${i + 1}. Обоснование из двух предложений.`,
  })),
  { question: '  неочевидный вопрос про имплантацию №1?  ', answer: 'Дубль-ответ.' },
];

const faqCallOk = async () => ({
  status: 200,
  data: {
    choices: [{ message: { content: '```json\n' + JSON.stringify({ items: FAQ_ITEMS }) + '\n```' } }],
  },
});

const faqCallGarbage = async () => ({
  status: 200,
  data: { choices: [{ message: { content: 'Извините, здесь нет JSON.' } }] },
});

/**
 * Склейка хвоста — точная реплика порядка saveFinalVersion (unit-уровень).
 * @param {{ specialist?: object|null, faqCall?: Function }} opts
 */
async function buildTail({ specialist = SPECIALIST, faqCall = faqCallOk } = {}) {
  // 1) extract: у воркера — extractFinalArticle (humanizer → … → author) +
  //    stripCitations; смоук стартует с humanizer-вывода и честно гоняет strip.
  const content = stripCitations(DIRTY_HUMANIZER_MD);

  // 2) sanitize (артефакты LLM + тех. секции) → 3) normalize headings.
  const sanitized = sanitizeArticle(content);
  const normalized = normalizeHeadings(sanitized.markdown);
  let finalContent = normalized.markdown;

  // 4) internal links (после нормализации, до FAQ/подписи — как в воркере).
  const { markdown: linkedContent } = injectInternalLinks(finalContent, CATALOG, {
    maxLinks: 8,
    returnAudit: true,
  });

  // 5) FAQ: идемпотентность-гард → генерация → СОБСТВЕННЫЙ sanitize → вставка
  //    → normalize в КОНТЕКСТЕ документа (не блока).
  let faqBlock = '';
  if (!hasUnusualFaqSection(linkedContent)) {
    const generated = await generateUnusualFaqMarkdown(
      { topic: TOPIC, h1: H1, headings: ['Виды имплантации', 'Цены на имплантацию'], conclusionExcerpt: 'Имплантация — предсказуемый метод.' },
      { callFn: faqCall }
    );
    if (generated) faqBlock = sanitizeArticle(generated).markdown;
  }

  let finalMarkdown = linkedContent.replace(/\n+$/, '');
  if (faqBlock) {
    finalMarkdown = normalizeHeadings(`${finalMarkdown}\n\n${faqBlock}`).markdown.replace(/\n+$/, '');
  }

  // 6a) P1b: строка «Обновлено» — тот же поздний этап, ЧТО И подпись (после
  //     всех мутаторов), но ДО конкатенации подписи: SIG-PRESENT требует
  //     подпись последней непустой строкой. Идемпотентна (стрип + вставка).
  finalMarkdown = appendUpdatedDateLine(finalMarkdown, UPDATED_AT);

  // 6) подпись автора — последний контентный шаг (формат buildAuthorSignature
  //    воркера: '\n\n---\n\n**Автор статьи:** ФИО, должность\n'; null → без подписи).
  const fullName = typeof specialist?.fullName === 'string' ? specialist.fullName.trim() : '';
  if (fullName) {
    const position = typeof specialist?.position === 'string' ? specialist.position.trim() : '';
    finalMarkdown += `\n\n---\n\n**Автор статьи:** ${fullName}${position ? `, ${position}` : ''}\n`;
  }

  // 7) все три поля — из ОДНОГО markdown; contentText — ДО JSON-LD (как в воркере).
  const contentHtml = renderMarkdownToHtml(finalMarkdown);
  const contentText = htmlToPlainText(contentHtml);

  // 8) P1c: JSON-LD — ПОСЛЕ постчек-входа и ПОСЛЕ contentText (в воркере:
  //    между runPostcheckAndPersist и articleVersion.create). persistedHtml —
  //    то, что уходит в contentHtml версии.
  const jsonLdScript = buildArticleJsonLd({
    articleId: '00000000-0000-4000-8000-0000000000aa',
    headline: H1,
    datePublished: UPDATED_AT,
    dateModified: UPDATED_AT,
    specialist: fullName ? { fullName, position: specialist?.position } : null,
    siteName: 'Тестовая компания',
    faq: extractFaqEntries(finalMarkdown),
  });
  const persistedHtml = attachArticleJsonLd(contentHtml, jsonLdScript);
  return { finalMarkdown, contentHtml, contentText, persistedHtml, reports: { sanitized, normalized } };
}

/** Уровни ATX-заголовков вне code-fence (для проверки иерархии). */
function headingLevels(markdown) {
  const out = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{1,6})[ \t]/.exec(line);
    if (m) out.push(m[1].length);
  }
  return out;
}

describe('смоук «хвост статьи» — склейка extract→sanitize→normalize→links→FAQ→подпись', () => {
  it('чистая иерархия: один H1, без прыжков уровней, кривые заголовки починены', async () => {
    const { finalMarkdown, reports } = await buildTail();

    // Санитайзер и нормализатор реально поработали по «грязному» входу.
    expect(reports.sanitized.report.counts.cutSections).toBe(2); // «Источники» + «Дополнительная экспертная информация»
    expect(reports.sanitized.report.counts.cjk).toBeGreaterThan(0);
    expect(reports.normalized.report.counts.levelJumpsFixed).toBeGreaterThan(0); // H1 → H3
    expect(reports.normalized.report.counts.demotedH1).toBeGreaterThan(0); // второй H1 в середине

    // Единственный H1 — первый заголовок документа.
    const h1Lines = finalMarkdown.split('\n').filter((l) => /^# /.test(l));
    expect(h1Lines).toEqual([`# ${H1}`]);

    // Нет прыжков уровней (следующий не глубже prev+1) — включая FAQ-хвост.
    const levels = headingLevels(finalMarkdown);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1);
    }

    // Кривые заголовки починены: H3-прыжок → H2, середина документа без H1.
    expect(finalMarkdown).toContain('## Виды имплантации');
    expect(finalMarkdown).not.toMatch(/^### Виды имплантации$/m);
    expect(finalMarkdown).toContain('## Почему выбирают нашу компанию');
  });

  it('тех.блоки вырезаны, легитимная секция и инлайн-ссылки живы, CJK и {{src}} gone', async () => {
    const { finalMarkdown, contentText } = await buildTail();

    // Тех. секции вырезаны (включая H3-уровень «Дополнительная экспертная информация»).
    expect(finalMarkdown).not.toMatch(/^#{1,6}[ \t]*источники[ \t]*$/im);
    expect(finalMarkdown).not.toMatch(/дополнительная экспертная информация/i);
    expect(finalMarkdown).not.toContain('пункт раз');

    // Легитимная секция выжила (точное совпадение имени — обратная совместимость).
    expect(finalMarkdown).toContain('## Источники данных для пациентов');
    expect(finalMarkdown).toContain('Официальные материалы для пациентов по стоматологии.');

    // Инлайн-ссылки основного текста живы; маркер источника снят на extract.
    expect(finalMarkdown).toContain('[в обзоре методик](https://example.com/method)');
    expect(finalMarkdown).not.toContain('{{src:');

    // CJK вычищен во всех полях.
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    expect(finalMarkdown).not.toMatch(cjk);
    expect(contentText).not.toMatch(cjk);
  });

  it('линкер внедрил ссылку каталога; ФИО подписи НЕ стало инлайн-ссылкой (порядок шагов)', async () => {
    const { finalMarkdown } = await buildTail();

    // Упоминание услуги в теле превратилось в ссылку каталога.
    expect(finalMarkdown).toContain('[All-on-4](https://acme.example/uslugi/all-on-4)');

    // Подпись добавлена ПОСЛЕ линкера: ФИО в подписи — голый текст, не [имя](url).
    expect(finalMarkdown).toContain(SIGNATURE_MD);
    expect(finalMarkdown).not.toMatch(/\[Иванов Иван Иванович\]\(/);
  });

  it('FAQ на месте: 1 секция «## 10 необычных вопросов» + ровно 10 «### » ПОСЛЕ контента', async () => {
    const { finalMarkdown, contentHtml, contentText } = await buildTail();

    const faqHeadings = finalMarkdown.match(/## 10 необычных вопросов/g) || [];
    expect(faqHeadings).toHaveLength(1);
    // W2/B2: тема — после двоеточия, в именительном падеже (без «про {тема}»).
    expect(finalMarkdown).toContain(`## 10 необычных вопросов: ${TOPIC}`);

    // Дубль вопроса отфильтрован dedupe → ровно 10 вопросов-подзаголовков.
    const h3Lines = finalMarkdown.split('\n').filter((l) => l.startsWith('### '));
    expect(h3Lines).toHaveLength(10);
    expect(h3Lines[0]).toBe('### Неочевидный вопрос про имплантацию №1?');

    // FAQ — ПОСЛЕ последней секции контента.
    const lastSectionIdx = finalMarkdown.indexOf('## Источники данных для пациентов');
    const faqIdx = finalMarkdown.indexOf('## 10 необычных вопросов');
    expect(faqIdx).toBeGreaterThan(lastSectionIdx);

    // Хвост несут все 3 поля (единый источник markdown).
    expect(contentHtml).toContain('10 необычных вопросов');
    expect((contentHtml.match(/<h3/g) || []).length).toBe(10);
    expect(contentText).toContain('Неочевидный вопрос про имплантацию №1');
  });

  it('подпись последняя: после FAQ и строки «Обновлено», формат md с **, text без **', async () => {
    const { finalMarkdown, contentHtml, contentText } = await buildTail();

    // Хвост: FAQ → «Обновлено» → --- → подпись (подпись — последняя непустая
    // строка, контракт SIG-PRESENT; «Обновлено» — непосредственно перед ней).
    const nonEmpty = finalMarkdown.split('\n').filter((l) => l.trim());
    expect(nonEmpty[nonEmpty.length - 1]).toBe(SIGNATURE_MD);
    expect(nonEmpty[nonEmpty.length - 2]).toBe('---');
    expect(nonEmpty[nonEmpty.length - 3]).toBe(UPDATED_LINE);
    expect(finalMarkdown.match(/Обновлено:/g) || []).toHaveLength(1);
    expect(contentHtml).toContain('Автор статьи:');

    // text: подпись есть, markdown-разметка ** снята рендером; «Обновлено»
    // видна читателю во всех полях (единый источник markdown).
    expect(contentText).toContain('Автор статьи: Иванов Иван Иванович, Врач-имплантолог');
    expect(contentText).toContain('Обновлено: 18.09.2026');
    expect(contentText).not.toContain('**');

    // Подпись — после FAQ и является последним непустым содержимым.
    const faqIdx = finalMarkdown.indexOf('## 10 необычных вопросов');
    const sigIdx = finalMarkdown.indexOf(SIGNATURE_MD);
    expect(sigIdx).toBeGreaterThan(faqIdx);
  });

  it('P1b идемпотентность: повторная вставка не дублирует строку «Обновлено»', async () => {
    const { finalMarkdown } = await buildTail();
    const reApplied = appendUpdatedDateLine(finalMarkdown, UPDATED_AT);
    // Стрип убирает строку и вставляет заново на то же место — хвост стабилен.
    expect(reApplied.match(/Обновлено:/g) || []).toHaveLength(1);
    const nonEmpty = reApplied.split('\n').filter((l) => l.trim());
    expect(nonEmpty[nonEmpty.length - 3]).toBe(UPDATED_LINE);
  });

  it('P1c: JSON-LD приложен к persistedHtml и невидим для contentText/постчека', async () => {
    const { finalMarkdown, contentHtml, contentText, persistedHtml } = await buildTail();

    // persistedHtml = исходный html + schema-скрипт (идемпотентная вставка).
    expect(persistedHtml.startsWith(contentHtml)).toBe(true);
    expect(persistedHtml).toContain('<script type="application/ld+json" data-generaptor="article-schema">');
    expect(persistedHtml.match(/application\/ld\+json/g) || []).toHaveLength(1);

    // JSON валиден; @graph = [Article, FAQPage] с ожидаемыми полями.
    const openTag = '<script type="application/ld+json" data-generaptor="article-schema">';
    const payload = persistedHtml.slice(
      persistedHtml.indexOf(openTag) + openTag.length,
      persistedHtml.lastIndexOf('</script>')
    );
    const parsed = JSON.parse(payload);
    expect(parsed['@context']).toBe('https://schema.org');
    const [articleNode, faqNode] = parsed['@graph'];
    expect(articleNode['@type']).toBe('Article');
    expect(articleNode.headline).toBe(H1);
    expect(articleNode.inLanguage).toBe('ru');
    expect(articleNode.dateModified).toBe('2026-09-18');
    expect(articleNode.author).toEqual({
      '@type': 'Person',
      name: 'Иванов Иван Иванович',
      jobTitle: 'Врач-имплантолог',
      affiliation: { '@type': 'Organization', name: 'Тестовая компания' },
    });
    expect(faqNode['@type']).toBe('FAQPage');
    expect(faqNode.mainEntity).toHaveLength(10);

    // Слепота текстовых полей: contentText (посчитан ДО attach) и любой
    // пересчёт из ХРАНИМОГО html не несут machine-data.
    expect(contentText).not.toContain('FAQPage');
    expect(contentText).not.toContain('application/ld+json');
    expect(htmlToPlainText(persistedHtml)).toBe(contentText);

    // Повторный attach (re-save) с теми же входными данными не дублирует скрипт.
    expect(attachArticleJsonLd(persistedHtml, buildArticleJsonLd({
      articleId: '00000000-0000-4000-8000-0000000000aa',
      headline: H1,
      datePublished: UPDATED_AT,
      dateModified: UPDATED_AT,
      specialist: SPECIALIST,
      siteName: 'Тестовая компания',
      faq: extractFaqEntries(finalMarkdown),
    }))).toBe(persistedHtml);
  });

  it('деградация: LLM-мусор → хвост без FAQ, но с подписью; specialist null → без подписи', async () => {
    const garbage = await buildTail({ faqCall: faqCallGarbage });
    expect(garbage.finalMarkdown).not.toContain('10 необычных вопросов');
    expect(garbage.finalMarkdown).toContain(SIGNATURE_MD);

    const noSpecialist = await buildTail({ specialist: null });
    expect(noSpecialist.finalMarkdown).toContain('## 10 необычных вопросов');
    expect(noSpecialist.finalMarkdown).not.toContain('Автор статьи');
    expect(noSpecialist.contentText).not.toContain('null');
    // P1b: строка «Обновлено» не зависит от подписи — без специалиста она
    // сама замыкает статью (SIG-правила в этом режиме skipped).
    expect(noSpecialist.finalMarkdown.match(/Обновлено:/g) || []).toHaveLength(1);
    const nonEmpty = noSpecialist.finalMarkdown.split('\n').filter((l) => l.trim());
    expect(nonEmpty[nonEmpty.length - 1]).toBe(UPDATED_LINE);
    // P1c: без специалиста узла author нет, но FAQ на месте → FAQPage есть.
    expect(noSpecialist.persistedHtml).not.toContain('"author"');
    expect(noSpecialist.persistedHtml).toContain('"FAQPage"');
    // P1c: без FAQ (garbage-сценарий) @graph несёт только Article.
    expect(garbage.persistedHtml).toContain('"@type":"Article"');
    expect(garbage.persistedHtml).not.toContain('FAQPage');
  });

  it('идемпотентность: повторная сборка детерминирована; повторный sanitize/normalize — no-op', async () => {
    const first = await buildTail();
    const second = await buildTail();
    expect(second.finalMarkdown).toBe(first.finalMarkdown);

    // Гвард срабатывает на готовом хвосте (BullMQ-retry не вставит второй FAQ).
    expect(hasUnusualFaqSection(first.finalMarkdown)).toBe(true);

    // Повторный прогон чистых трансформаций по готовому хвосту контент-стабилен:
    // sanitize снимает ТОЛЬКО хвостовой \n подписи (контракт trimEnd, все
    // счётчики нулевые), normalize — полный no-op.
    const reSanitized = sanitizeArticle(first.finalMarkdown);
    expect(reSanitized.report.counts).toEqual({
      cjk: 0, fences: 0, aiPhrases: 0,
      duplicateHeadings: 0, duplicateParagraphs: 0, duplicateTables: 0, cutSections: 0,
      chunkArtifacts: 0, // U5: реестр чанк-артефактов — новый счётчик
    });
    expect(reSanitized.markdown).toBe(first.finalMarkdown.replace(/\n+$/, ''));
    const reNormalized = normalizeHeadings(first.finalMarkdown);
    expect(reNormalized.report.wasModified).toBe(false);
    expect(reNormalized.markdown).toBe(first.finalMarkdown);
  });
});
