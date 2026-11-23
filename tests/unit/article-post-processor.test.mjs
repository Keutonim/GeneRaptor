import { describe, it, expect } from 'vitest';
import {
  generateFallbackArticle,
  postProcessArticle,
  mergeEmptySections,
  trimOverlongArticleBody,
  ensureH1WithMainQuery,
  injectExpertsBlock,
  ensureSiteMentions,
  injectFormRecommendationBlock,
  reduceKeySpam,
  EMPTY_SECTION_MERGE_MIN_CHARS,
  CHUNK_TAIL_RESERVE_CHARS,
} from '../../server/article-post-processor.mjs';
import { runArticlePostcheck, keyUsedInText } from '../../server/lib/article-postcheck.mjs';
import { hasFormRecommendationBlock } from '../../server/lib/objection-block.mjs';

/* ── G1(c) quality-calibration (2026-08-21): слияние пустых H2-секций ──── */

/** Абзац >100 симв. плейн-текста — «здоровая» секция. */
const HEALTHY_PARA =
  'Чистка лица — косметическая процедура, которая удаляет ороговевшие клетки кожи, избытки кожного сала и загрязнения из пор, выравнивает рельеф и тон лица, стимулирует кровообращение и обменные процессы в коже.';

describe('mergeEmptySections — G1(c): детерминированная страховка от скелетных секций', () => {
  it('пустая H2-секция (<100 симв. тела) сливается в ПРЕДЫДУЩУЮ: заголовок удалён, текст приклеен', () => {
    const md = [
      '# Чистка лица: виды процедур', '',
      '## Подготовка к чистке', '',
      HEALTHY_PARA, '',
      '## Побочные эффекты', '',
      'Редко.', '',
      '## Уход после процедуры', '',
      HEALTHY_PARA, '',
    ].join('\n');

    const res = mergeEmptySections(md);
    expect(res.count).toBe(1);
    expect(res.mergedHeadings).toEqual(['побочные эффекты']);
    expect(res.markdown).not.toContain('## Побочные эффекты');
    // Порядок сохранён: короткий текст приклеен в тело предыдущей секции.
    const idxHealthy = res.markdown.indexOf(HEALTHY_PARA);
    const idxRare = res.markdown.indexOf('Редко.');
    expect(idxHealthy).toBeGreaterThan(-1);
    expect(idxRare).toBeGreaterThan(idxHealthy);
    // Соседние секции живы.
    expect(res.markdown).toContain('## Подготовка к чистке');
    expect(res.markdown).toContain('## Уход после процедуры');
  });

  it('порог: ровно 100 симв. — НЕ пустая (граница >= minChars)', () => {
    const body = 'А'.repeat(EMPTY_SECTION_MERGE_MIN_CHARS);
    const md = `# Т\n\n## Первая\n\n${HEALTHY_PARA}\n\n## Вторая\n\n${body}\n`;
    const res = mergeEmptySections(md);
    expect(res.count).toBe(0);
    expect(res.markdown).toBe(md);
  });

  // F3 (quality-final 2026-08-21): прежнее поведение «первая пустая остаётся
  // как есть» заменено слиянием ВПЕРЁД — см. describe ниже.
  it('первая секция пустая → сливается ВПЕРЁД в следующую: заголовок удалён, контент приклеен к следующей секции', () => {
    const md = `# Тема\n\n## Пустышка\n\nКратко.\n\n## Вторая секция\n\n${HEALTHY_PARA}\n`;
    const res = mergeEmptySections(md);
    expect(res.count).toBe(1);
    expect(res.mergedHeadings).toEqual(['пустышка']);
    expect(res.firstSectionLeftAsIs).toBe(0);
    expect(res.markdown).not.toContain('## Пустышка');
    // Вторая секция жива со СВОИМ заголовком; контент пустышки не потерян.
    expect(res.markdown).toContain('## Вторая секция');
    expect(res.markdown).toContain('Кратко.');
    expect(res.markdown).toContain(HEALTHY_PARA);
    // Контент пустышки приклеен ВНУТРЬ следующей секции: её заголовок стоит
    // РАНЬШЕ приклеенного контента.
    const idxHeading = res.markdown.indexOf('## Вторая секция');
    const idxGlued = res.markdown.indexOf('Кратко.');
    expect(idxGlued).toBeGreaterThan(idxHeading);
  });

  it('ВСЕ секции скелетные: первая остаётся (якорь), остальные сливаются в неё', () => {
    const md = [
      '# Тема', '',
      '## Первый скелет', '',
      'Текст один.', '',
      '## Второй скелет', '',
      'Текст два.', '',
      '## Третий скелет', '',
      'Текст три.', '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(2);
    expect(res.mergedHeadings).toEqual(['второй скелет', 'третий скелет']);
    expect(res.firstSectionLeftAsIs).toBe(1);
    expect(res.markdown).toContain('## Первый скелет');
    expect(res.markdown).toContain('Текст три.');
    expect(res.markdown).not.toMatch(/^## (Второй|Третий) скелет/m);
  });

  it('FAQ-секции и подпись исключены: не сливаются и не считаются телом', () => {
    const md = [
      '# Тема', '',
      '## Основная секция', '',
      HEALTHY_PARA, '',
      '## Часто задаваемые вопросы (FAQ)', '',
      '### Вопрос один?', '',
      'Да.', '',
      '### Вопрос два?', '',
      'Да.', '',
      '---', '',
      '**Автор статьи:** Иванов Иван Иванович, Врач', '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(0);
    expect(res.markdown).toBe(md);
  });

  it('пустая секция ПОДЛЕ FAQ/подписью не сливается (хвост вне контентных секций)', () => {
    const md = [
      '# Тема', '',
      '## Основная секция', '',
      HEALTHY_PARA, '',
      '## Часто задаваемые вопросы (FAQ)', '',
      '### Вопрос?', '',
      'Да.', '',
      '## Примечание после FAQ', '',
      'Кратко.', '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(0);
    expect(res.markdown).toContain('## Примечание после FAQ');
  });

  it('несколько пустых подряд: каждая сливается в предыдущую живую секцию', () => {
    const md = [
      '# Тема', '',
      '## Живая секция', '',
      HEALTHY_PARA, '',
      '## Пустая один', '',
      'Текст один.', '',
      '## Пустая два', '',
      'Текст два.', '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(2);
    expect(res.mergedHeadings).toEqual(['пустая один', 'пустая два']);
    expect(res.markdown).toContain('Текст один.');
    expect(res.markdown).toContain('Текст два.');
    expect(res.markdown).not.toMatch(/^## Пустая/m);
  });

  it('H3-подразделы внутри H2-секции — часть тела (H2 с H3-контентом не пустая)', () => {
    const md = [
      '# Тема', '',
      '## Методы', '',
      '### Механическая', '',
      HEALTHY_PARA, '',
      '## Другая секция', '',
      HEALTHY_PARA, '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(0);
    expect(res.markdown).toBe(md);
  });

  it('заголовки внутри code-fence не считаются секциями', () => {
    const md = [
      '# Тема', '',
      '## Секция', '',
      HEALTHY_PARA, '',
      '```markdown', '',
      '## Внутри фенса', '',
      '```', '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(0);
    expect(res.markdown).toContain('## Внутри фенса');
  });

  it('markdown-таблица в теле секции — это контент: секция не пустая', () => {
    const table = ['| Метод | Цена |', '|---|---|', '| Механическая | 3 000 ₽ |'].join('\n');
    const md = `# Тема\n\n## Сравнение методов\n\n${table}\n`;
    const res = mergeEmptySections(md);
    expect(res.count).toBe(0);
    expect(res.markdown).toContain('| Метод | Цена |');
  });

  it('мусорный ввод (пусто/undefined) не бросает', () => {
    expect(mergeEmptySections('')).toEqual({ markdown: '', mergedHeadings: [], count: 0, firstSectionLeftAsIs: 0 });
    expect(mergeEmptySections(undefined)).toEqual({ markdown: '', mergedHeadings: [], count: 0, firstSectionLeftAsIs: 0 });
    expect(mergeEmptySections(null)).toEqual({ markdown: '', mergedHeadings: [], count: 0, firstSectionLeftAsIs: 0 });
  });

  it('интеграция с постчеком: BODY-NO-EMPTY-SECTIONS fail до слияния → pass после (до sanitize)', () => {
    const md = [
      '# Чистка лица: виды процедур', '',
      '## Подготовка к чистке лица', '',
      HEALTHY_PARA, '',
      '## Побочные эффекты', '',
      'Редко.', '',
    ].join('\n');
    const ctx = { targetLength: null, specialistId: null };
    const before = runArticlePostcheck({ markdown: md, context: ctx });
    expect(before.rules.find((r) => r.id === 'BODY-NO-EMPTY-SECTIONS').status).toBe('fail');

    const merged = mergeEmptySections(md);
    const after = runArticlePostcheck({ markdown: merged.markdown, context: ctx });
    expect(after.rules.find((r) => r.id === 'BODY-NO-EMPTY-SECTIONS').status).toBe('pass');
  });
});

/* ── F3 (quality-final 2026-08-21): пустая ПЕРВАЯ секция сливается вперёд ── */

describe('mergeEmptySections — F3: пустая первая секция сливается ВПЕРЁД', () => {
  it('первая секция скелет → исчезла, вторая жива со своим заголовком (счётчик тот же)', () => {
    const md = [
      '# Чистка лица: гид', '',
      '## Введение в тему', '',
      'Совсем коротко.', '',
      '## Что такое чистка лица', '',
      HEALTHY_PARA, '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(1);
    expect(res.mergedHeadings).toEqual(['введение в тему']);
    expect(res.markdown).not.toMatch(/^##\s+Введение в тему$/m);
    expect(res.markdown).toMatch(/^##\s+Что такое чистка лица$/m);
    // Контент скелета не потерян и оказался внутри следующей секции.
    const idxHeading = res.markdown.indexOf('## Что такое чистка лица');
    const idxGlued = res.markdown.indexOf('Совсем коротко.');
    expect(idxGlued).toBeGreaterThan(idxHeading);
    expect(idxGlued).toBeGreaterThan(-1);
  });

  it('цепочка ведущих скелетов: все заголовки сняты, контент приклеен к первой живой секции', () => {
    const md = [
      '# Тема', '',
      '## Скелет один', '',
      'Текст один.', '',
      '## Скелет два', '',
      'Текст два.', '',
      '## Живая секция', '',
      HEALTHY_PARA, '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(2);
    expect(res.mergedHeadings).toEqual(['скелет один', 'скелет два']);
    expect(res.firstSectionLeftAsIs).toBe(0);
    expect(res.markdown).not.toMatch(/^##\s+Скелет/m);
    expect(res.markdown).toMatch(/^##\s+Живая секция$/m);
    // Живой заголовок перенесён в начало бывшей первой секции: приклеенный
    // контент идёт ПОСЛЕ него и раньше здорового абзаца.
    const idxHeading = res.markdown.indexOf('## Живая секция');
    const idxOne = res.markdown.indexOf('Текст один.');
    const idxTwo = res.markdown.indexOf('Текст два.');
    const idxHealthy = res.markdown.indexOf(HEALTHY_PARA);
    expect(idxHeading).toBeLessThan(idxOne);
    expect(idxOne).toBeLessThan(idxTwo);
    expect(idxTwo).toBeLessThan(idxHealthy);
  });

  it('первый скелет без контента → заголовок снят, следующая секция жива', () => {
    const md = [
      '# Тема', '',
      '## Пустой заголовок', '',
      '## Наполненная секция', '',
      HEALTHY_PARA, '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(1);
    expect(res.mergedHeadings).toEqual(['пустой заголовок']);
    expect(res.markdown).not.toContain('## Пустой заголовок');
    expect(res.markdown).toMatch(/^##\s+Наполненная секция$/m);
    expect(res.markdown).toContain(HEALTHY_PARA);
  });

  it('первая живая, дальше скелеты — прежнее поведение: слияние НАЗАД в предыдущую (регресс)', () => {
    const md = [
      '# Тема', '',
      '## Живая секция', '',
      HEALTHY_PARA, '',
      '## Скелет в середине', '',
      'Коротко.', '',
    ].join('\n');
    const res = mergeEmptySections(md);
    expect(res.count).toBe(1);
    expect(res.mergedHeadings).toEqual(['скелет в середине']);
    expect(res.markdown).not.toContain('## Скелет в середине');
    expect(res.markdown).toContain('## Живая секция');
    // Назад: заголовок живой секции стоит РАНЬШЕ приклеенного контента скелета.
    expect(res.markdown.indexOf('Коротко.')).toBeGreaterThan(res.markdown.indexOf('## Живая секция'));
  });
});

/* ── F2(b) quality-final (2026-08-21): детерминированный трим переполненного тела ── */

describe('trimOverlongArticleBody — F2(b): трим >1.30× базы завершающими абзацами', () => {
  const TARGET = 1000;
  const MAX = TARGET * 1.3; // 1300
  const FLOOR = TARGET * 1.05; // 1050
  // FIX-D3: дефолтный резерв хвоста (CHUNK_TAIL_RESERVE_CHARS) вычитается из
  // targetLength; эти тесты проверяют ЧИСТУЮ механику отношений на малых
  // таргетах → резерв 0.
  const trim0 = (md, opts = {}) => trimOverlongArticleBody(md, { targetLength: TARGET, tailReserveChars: 0, ...opts });

  /** Уникальный русский абзац РОВНО len символов (маркер + набивка). */
  function para(marker, len) {
    const filler =
      'Чистка лица удаляет ороговевшие клетки кожи и избытки кожного сала, выравнивает рельеф и тон лица, стимулирует кровообращение и обменные процессы в коже. ';
    let s = `${marker}: `;
    while (s.length < len) s += filler;
    return s.slice(0, len);
  }

  const TABLE = ['| Метод | Цена |', '|---|---|', '| Механическая | 3 000 ₽ |'].join('\n');

  it('~1.7×-фикстура → ≤1.3×: абзацы срезаны С КОНЦА последней секции, заголовки и таблица целы', () => {
    const md = [
      '# Чистка лица: полное руководство', '',
      '## Что такое чистка лица', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 300), '',
      '## Сравнение подходов', '',
      para('АБЗАЦ-ПЕРВЫЙ', 300), '',
      TABLE, '',
      para('АБЗАЦ-ПОСЛЕДНИЙ-2', 480), '',
      para('АБЗАЦ-ПОСЛЕДНИЙ-1', 480), '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(MAX); // переполнение

    const res = trim0(md);
    expect(res.trimmed).toBe(true);
    expect(res.trimmedParagraphs).toBeGreaterThanOrEqual(1);
    expect(res.charsBefore).toBe(md.length);
    expect(res.charsAfter).toBe(res.markdown.length);
    // Тело в окне [floor .. max].
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    expect(res.markdown.length).toBeGreaterThanOrEqual(FLOOR);

    // Заголовки целы.
    expect(res.markdown).toMatch(/^# Чистка лица: полное руководство$/m);
    expect(res.markdown).toMatch(/^## Что такое чистка лица$/m);
    expect(res.markdown).toMatch(/^## Сравнение подходов$/m);
    // Таблица не тронута.
    expect(res.markdown).toContain('| Метод | Цена |');
    expect(res.markdown).toContain('| Механическая | 3 000 ₽ |');
    // Срезаны ЗАВЕРШАЮЩИЕ абзацы, первый абзац секции цел.
    expect(res.markdown).toContain('АБЗАЦ-ПЕРВЫЙ');
    expect(res.markdown).not.toContain('АБЗАЦ-ПОСЛЕДНИЙ-1');
    // Абзацы срезаются строго с конца: если остался предпоследний — есть и первый.
    if (res.markdown.includes('АБЗАЦ-ПОСЛЕДНИЙ-2')) {
      expect(res.markdown).toContain('АБЗАЦ-ПЕРВЫЙ');
    }
    // Порядок: срезан последний абзац (−1) — а защищённый абзац другой секции цел.
    expect(res.markdown).toContain('АБЗАЦ-ЗАЩИЩЁН');
  });

  it('1.2× → не трогается', () => {
    const md = [
      '# Тема', '',
      '## Секция', '',
      para('АБЗАЦ', 700), '',
      para('АБЗАЦ-ХВОСТ', 480), '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(TARGET);
    expect(md.length).toBeLessThanOrEqual(MAX);

    const res = trim0(md);
    expect(res.trimmed).toBe(false);
    expect(res.trimmedParagraphs).toBe(0);
    expect(res.markdown).toBe(md);
    expect(res.charsBefore).toBe(md.length);
    expect(res.charsAfter).toBe(md.length);
  });

  it('граница 1.3×: ровно max → не трогается; чуть больше → срез до ≤1.3× (пол ровно 1.05×)', () => {
    // База: H1 + секция с единственным (защищённым) абзацем 1031 → 1051 симв.
    // с завершающим \n. Хвост (через \n\n) добивает длину точно до границы.
    const base = ['# Тема', '', '## Секция', '', para('АБЗАЦ-ОСНОВНОЙ', 1031), ''].join('\n');
    const tailExact = MAX - base.length - 1; // + '\n' + tail === MAX
    const mdExact = base + '\n' + para('АБЗАЦ-ХВОСТ', tailExact);
    expect(mdExact.length).toBe(MAX); // ровно 1.30× — НЕ больше

    const resExact = trim0(mdExact);
    expect(resExact.trimmed).toBe(false);
    expect(resExact.markdown).toBe(mdExact);

    // 1.32×: срез хвоста оставляет ровно пол 1050 — резать можно (не ниже пола).
    const mdOver = base + '\n' + para('АБЗАЦ-ХВОСТ', tailExact + 20);
    expect(mdOver.length).toBe(MAX + 20);
    const res = trim0(mdOver);
    expect(res.trimmed).toBe(true);
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    expect(res.markdown.length).toBeGreaterThanOrEqual(FLOOR);
    expect(res.markdown).toContain('АБЗАЦ-ОСНОВНОЙ');
    expect(res.markdown).not.toContain('АБЗАЦ-ХВОСТ');
  });

  it('пол 1.05×: срез последнего абзаца уронил бы длину ниже пола → НЕ режем (лучше чуть больше)', () => {
    const md = [
      '# Тема', '',
      '## Секция', '',
      para('АБЗАЦ-ОСНОВНОЙ', 700), '',
      para('АБЗАЦ-ГИГАНТ', 620), '',
    ].join('\n');
    // ~1342 > 1300, но 1342 − 621 ≈ 721 < 1050 → срез запрещён полом.
    expect(md.length).toBeGreaterThan(MAX);
    const res = trim0(md);
    expect(res.trimmed).toBe(false);
    expect(res.trimmedParagraphs).toBe(0);
    expect(res.markdown).toBe(md);
  });

  it('последняя секция — таблица: таблицу не трогаем, режем абзацы предыдущей text-секции', () => {
    const TARGET2 = 2000;
    const md = [
      '# Тема руководства', '',
      para('ЛИД-АБЗАЦ', 900), '',
      '## Основная секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 400), '',
      para('АБЗАЦ-РЕЖЕМЫЙ-1', 800), '',
      para('АБЗАЦ-РЕЖЕМЫЙ-2', 800), '',
      '## Итоговая таблица', '',
      TABLE, '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(TARGET2 * 1.3);

    const res = trim0(md, { targetLength: TARGET2 });
    expect(res.trimmed).toBe(true);
    // Таблица и её заголовок целы.
    expect(res.markdown).toContain('| Метод | Цена |');
    expect(res.markdown).toMatch(/^##\s+Итоговая таблица$/m);
    // Лид (до первого H2) и первый абзац секции неприкосновенны.
    expect(res.markdown).toContain('ЛИД-АБЗАЦ');
    expect(res.markdown).toContain('АБЗАЦ-ЗАЩИЩЁН');
    // Срезан завершающий абзац предыдущей text-секции.
    expect(res.markdown).not.toContain('АБЗАЦ-РЕЖЕМЫЙ-2');
    expect(res.markdown.length).toBeLessThanOrEqual(TARGET2 * 1.3);
    expect(res.markdown.length).toBeGreaterThanOrEqual(TARGET2 * 1.05);
  });

  it('FAQ-секция и подпись никогда не режутся (хвост вне зоны трима)', () => {
    const faqBlock = [
      '## 10 необычных вопросов про Тема', '',
      '### Вопрос один?', '',
      para('ОТВЕТ-FAQ-ОДИН', 400), '',
      '### Вопрос два?', '',
      para('ОТВЕТ-FAQ-ДВА', 400), '',
      '**Автор статьи:** Иванов Иван Иванович, Врач-косметолог', '',
    ].join('\n');
    const md = [
      '# Тема', '',
      '## Единственная секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 500), '',
      faqBlock, '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(MAX);

    const res = trim0(md);
    // У секции один абзац (защищён), FAQ/подпись вне зоны → без трима, всё цело.
    expect(res.markdown).toBe(md);
    expect(res.trimmed).toBe(false);
    expect(res.markdown).toContain('ОТВЕТ-FAQ-ОДИН');
    expect(res.markdown).toContain('**Автор статьи:**');
  });

  it('последняя секция — список: список не трогаем, режем завершающие абзацы предыдущей text-секции', () => {
    const md = [
      '# Тема', '',
      '## Основная секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 700), '',
      para('АБЗАЦ-СРЕДНИЙ', 300), '',
      para('АБЗАЦ-ХВОСТ', 260), '',
      '## Итоговый список', '',
      '- пункт один списка;', '',
      '- пункт два списка.', '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(MAX);

    const res = trim0(md);
    expect(res.trimmed).toBe(true);
    // Список и его заголовок целы.
    expect(res.markdown).toContain('- пункт один списка;');
    expect(res.markdown).toContain('- пункт два списка.');
    expect(res.markdown).toMatch(/^##\s+Итоговый список$/m);
    // Резали предыдущую text-секцию: защищённый и средний абзацы целы, хвост срезан.
    expect(res.markdown).toContain('АБЗАЦ-ЗАЩИЩЁН');
    expect(res.markdown).toContain('АБЗАЦ-СРЕДНИЙ');
    expect(res.markdown).not.toContain('АБЗАЦ-ХВОСТ');
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    expect(res.markdown.length).toBeGreaterThanOrEqual(FLOOR);
  });

  it('абзацы режутся ПО ОДНОМУ с конца, пока не войдём в окно', () => {
    const md = [
      '# Тема', '',
      '## Секция', '',
      para('АБЗАЦ-ПЕРВЫЙ', 350), '',
      para('АБЗАЦ-ВТОРОЙ', 350), '',
      para('АБЗАЦ-ТРЕТИЙ', 350), '',
      para('АБЗАЦ-ЧЕТВЁРТЫЙ', 350), '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(MAX);

    const res = trim0(md);
    expect(res.trimmed).toBe(true);
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    // Первый абзац всегда остаётся (защита от скелетной секции).
    expect(res.markdown).toContain('АБЗАЦ-ПЕРВЫЙ');
    // Срез строго с конца: последний отсутствует, наличие остальных — префикс.
    expect(res.markdown).not.toContain('АБЗАЦ-ЧЕТВЁРТЫЙ');
    const markers = ['АБЗАЦ-ПЕРВЫЙ', 'АБЗАЦ-ВТОРОЙ', 'АБЗАЦ-ТРЕТИЙ'];
    const present = markers.filter((m) => res.markdown.includes(m));
    expect(present.length).toBe(markers.indexOf(present[present.length - 1]) + 1);
  });

  it('мусорный ввод (пусто/undefined/null) и targetLength<=0 не бросают, ввод не меняется', () => {
    expect(trimOverlongArticleBody('', { targetLength: 1000, tailReserveChars: 0 })).toMatchObject({ trimmed: false, markdown: '' });
    expect(trimOverlongArticleBody(undefined, { targetLength: 1000, tailReserveChars: 0 })).toMatchObject({ trimmed: false, markdown: '' });
    expect(trimOverlongArticleBody(null, { targetLength: 1000, tailReserveChars: 0 })).toMatchObject({ trimmed: false, markdown: '' });
    const md = '# Т\n\n## S\n\n' + 'x'.repeat(3000);
    expect(trim0(md, { targetLength: 0 })).toMatchObject({ trimmed: false, markdown: md });
    expect(trim0(md, { targetLength: null })).toMatchObject({ trimmed: false, markdown: md });
  });

  it('нет H2-секций → резать нечего, ввод не меняется', () => {
    const md = '# Только H1\n\n' + para('АБЗАЦ', 2500) + '\n';
    expect(md.length).toBeGreaterThan(MAX);
    const res = trim0(md);
    expect(res.trimmed).toBe(false);
    expect(res.markdown).toBe(md);
  });
});

/* ── FIX-D3 (quality-final 2026-08-21): база трима с резервом хвоста ────── */

describe('trimOverlongArticleBody — FIX-D3: пороги от (target − CHUNK_TAIL_RESERVE_CHARS)', () => {
  // QA-вердикт: трим ДО вставки хвоста, а BODY-LENGTH-RANGE мерит финал С
  // хвостом (FAQ ~3000 + подпись ~200). Без резерва на таргете 10к трим
  // останавливался на 13к, +хвост ≈ 16.2к = 1.62× → LENGTH-RANGE fail —
  // трим ломал ровно то, что чинил. Резерв — в ОБА порога.

  const TARGET = 10_000;
  // §6-A3 FIX-LEN (2026-08-25): резерв 3200 → 4000 → база трима 10000−4000 = 6000.
  const BASE = TARGET - CHUNK_TAIL_RESERVE_CHARS; // 6000
  const MAX = BASE * 1.3; // 7800
  const FLOOR = BASE * 1.05; // 6300

  function para(marker, len) {
    const filler =
      'Чистка лица удаляет ороговевшие клетки кожи и избытки кожного сала, выравнивает рельеф и тон лица, стимулирует кровообращение и обменные процессы в коже. ';
    let s = `${marker}: `;
    while (s.length < len) s += filler;
    return s.slice(0, len);
  }

  it('target 10k, тело ~1.6× → ≤ (10k−4000)×1.3 = 7800 и ≥ 6300 (бюджет под FAQ+подпись)', () => {
    const md = [
      '# Тема статьи', '',
      '## Основная секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 5400), '',
      '## Хвостовая секция', '',
      para('АБЗАЦ-ПЕРВЫЙ', 800), '',
      ...Array.from({ length: 11 }, (_, i) => para(`АБЗАЦ-ХВОСТ-${i + 1}`, 900)).flatMap((p) => [p, '']),
    ].join('\n');
    expect(md.length).toBeGreaterThan(TARGET * 1.6); // ~1.6× target
    expect(md.length).toBeGreaterThan(MAX);

    const res = trimOverlongArticleBody(md, { targetLength: TARGET }); // дефолт: резерв 4000
    expect(res.trimmed).toBe(true);
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    expect(res.markdown.length).toBeGreaterThanOrEqual(FLOOR);
    // Заголовки и первый абзац секции целы; хвостовые абзацы срезаны с конца.
    expect(res.markdown).toMatch(/^##\s+Основная секция$/m);
    expect(res.markdown).toMatch(/^##\s+Хвостовая секция$/m);
    expect(res.markdown).toContain('АБЗАЦ-ЗАЩИЩЁН');
    expect(res.markdown).toContain('АБЗАЦ-ПЕРВЫЙ');
    expect(res.markdown).not.toContain('АБЗАЦ-ХВОСТ-11');
  });

  it('floor тоже от базы с резервом: срез до 6426 (< прежнего пола 10.5к) разрешён', () => {
    // Тело 7928 > 7800; срез хвоста → 6426 ∈ [6300 .. 7800]. Со старым полом
    // (target×1.05 = 10500 > max 7800) пол стал бы фактическим стопом —
    // резать было бы нельзя вовсе. FIX-D3 разрешает.
    const md = [
      '# Тема статьи', '',
      '## Секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 6400), '',
      para('АБЗАЦ-ХВОСТ', 1500), '',
    ].join('\n');
    expect(md.length).toBeGreaterThan(MAX);

    const res = trimOverlongArticleBody(md, { targetLength: TARGET });
    expect(res.trimmed).toBe(true);
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    expect(res.markdown.length).toBeGreaterThanOrEqual(FLOOR);
    expect(res.markdown).toContain('АБЗАЦ-ЗАЩИЩЁН');
    expect(res.markdown).not.toContain('АБЗАЦ-ХВОСТ');
  });

  it('тело ~1.02× target (> 7800 с резервом) → трим срабатывает (раньше 1.3×-порог target не трогался)', () => {
    const md = [
      '# Тема статьи', '',
      '## Секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 6500), '',
      para('АБЗАЦ-ХВОСТ', 3700), '',
    ].join('\n');
    // ~1.02× target — ниже прежнего порога 1.3× target, но выше 1.3× базы.
    expect(md.length).toBeGreaterThan(MAX);
    expect(md.length).toBeLessThanOrEqual(TARGET * 1.3);

    const res = trimOverlongArticleBody(md, { targetLength: TARGET });
    expect(res.trimmed).toBe(true);
    expect(res.markdown.length).toBeLessThanOrEqual(MAX);
    expect(res.markdown.length).toBeGreaterThanOrEqual(FLOOR);
  });

  it('пол базы: срез ниже 6300 запрещён → ввод без изменений', () => {
    const md = [
      '# Тема статьи', '',
      '## Секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 5500), '',
      para('АБЗАЦ-ГИГАНТ', 3000), '',
    ].join('\n');
    // ~8528 > 7800; срез → ~5526 < 6300 (пол базы) → запрещён.
    const res = trimOverlongArticleBody(md, { targetLength: TARGET });
    expect(res.trimmed).toBe(false);
    expect(res.markdown).toBe(md);
  });

  it('короткий таргет: пол базы target/2 — резерв не вырождает трим', () => {
    // target 3200: чистая формула дала бы базу 0 → пол поднимает её до 1600
    // (max 2080 / floor 1680). Тело ~9к режется щадяще, но не до килобайта:
    // защищённые абзацы останавливают срез задолго до max.
    const md = '# Тема\n\n## Секция\n\n' + para('АБЗАЦ-ЗАЩИЩЁН', 5000) + '\n\n' + para('АБЗАЦ-ХВОСТ', 2000) + '\n';
    expect(md.length).toBeGreaterThan(3200 * 1.3);
    const res = trimOverlongArticleBody(md, { targetLength: 3200 });
    // Хвостовой абзац срезан (тело > 1.3× пола базы 1600 = 2080), НО ниже
    // пола 1680 не режем и защищённый абзац цел.
    expect(res.markdown).toContain('АБЗАЦ-ЗАЩИЩЁН');
    expect(res.markdown).not.toContain('АБЗАЦ-ХВОСТ');
    expect(res.markdown.length).toBeGreaterThanOrEqual(1600 * 1.05);

    // target 4000 (G1c-подобные фикстуры): база = max(0, 2000) = 2000 →
    // обычное тело ~1.3к НЕ трогается (раньше резалось бы до ~1к).
    const md2 = '# Тема статьи\n\n## Секция один\n\n' + para('АБЗАЦ-1', 600) + '\n\n## Секция два\n\n' + para('АБЗАЦ-2', 600) + '\n';
    expect(trimOverlongArticleBody(md2, { targetLength: 4000 })).toMatchObject({ trimmed: false, markdown: md2 });
  });

  it('tailReserveChars: 0 возвращает прежнюю семантику (пороги от чистого target)', () => {
    const md = [
      '# Тема статьи', '',
      '## Секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 7150), '',
      para('АБЗАЦ-ХВОСТ', 2000), '',
    ].join('\n'); // ~9180: ≤ 1.3× target (13000), > 1.3× базы (8840)
    const res = trimOverlongArticleBody(md, { targetLength: TARGET, tailReserveChars: 0 });
    expect(res.trimmed).toBe(false);
    expect(res.markdown).toBe(md);
  });
});

/* ── §6-A1 FIX-H1 (2026-08-25): H1-гарантия главного запроса ───────────── */

describe('ensureH1WithMainQuery — §6-A1: ведущий H1 обязан содержать главный запрос', () => {
  const MQ = 'лазерная эпиляция интимная зона';

  it('H1 без ключа → H1 := «{MainQuery с заглавной}: {старый H1 со строчной}», остальное не тронуто', () => {
    const md = `# Анатомические особенности интимной зоны: что важно знать до первой процедуры\n\n## Подготовка\n\n${HEALTHY_PARA}`;
    const res = ensureH1WithMainQuery(md, MQ);
    expect(res.fixed).toBe(true);
    expect(res.newH1).toBe(
      'Лазерная эпиляция интимная зона: анатомические особенности интимной зоны: что важно знать до первой процедуры',
    );
    expect(res.text.startsWith(`# ${res.newH1}`)).toBe(true);
    expect(res.text).not.toMatch(/^# Анатомические/m);
    // Тело документа не тронуто.
    expect(res.text).toContain('## Подготовка');
    expect(res.text).toContain(HEALTHY_PARA);
  });

  it('H1 уже содержит ключ (морфо, разбавленно) → не тронут', () => {
    const md = `# Всё о процедуре: лазерная эпиляция глубоких зон\n\n## Секция\n\n${HEALTHY_PARA}`;
    const res = ensureH1WithMainQuery(md, 'лазерная эпиляция');
    expect(res.fixed).toBe(false);
    expect(res.text).toBe(md);
    expect(res.newH1).toBeUndefined();
  });

  it('морфо-стандарт FIX-S1: короткое слово ключа (<5 симв.) матчится только точно — «в интимной зоне» НЕ покрывает «…зона» → фикс применяется', () => {
    const md = `# Лазерная эпиляция в интимной зоне: гид\n\n## Секция\n\n${HEALTHY_PARA}`;
    const res = ensureH1WithMainQuery(md, MQ);
    expect(res.fixed).toBe(true);
    expect(res.newH1.startsWith('Лазерная эпиляция интимная зона:')).toBe(true);
  });

  it('mainQuery null/undefined/пусто/пробелы → не тронут', () => {
    const md = `# Анатомические особенности: гид\n\n## Секция\n\n${HEALTHY_PARA}`;
    for (const q of [null, undefined, '', '   ']) {
      expect(ensureH1WithMainQuery(md, q)).toEqual({ text: md, fixed: false });
    }
  });

  it('H1 отсутствует (только H2 / пустой ввод / null) → не тронут, не бросает', () => {
    const onlyH2 = `## Секция\n\n${HEALTHY_PARA}`;
    expect(ensureH1WithMainQuery(onlyH2, MQ)).toEqual({ text: onlyH2, fixed: false });
    expect(ensureH1WithMainQuery('', MQ)).toEqual({ text: '', fixed: false });
    expect(ensureH1WithMainQuery(undefined, MQ)).toEqual({ text: '', fixed: false });
    expect(ensureH1WithMainQuery(null, MQ)).toEqual({ text: '', fixed: false });
  });

  it('старый H1 обрезается до 80 симв. (первый символ — строчная)', () => {
    const md = `# ${'А'.repeat(120)}\n\n## Секция\n\n${HEALTHY_PARA}`;
    const res = ensureH1WithMainQuery(md, 'ботокс');
    expect(res.fixed).toBe(true);
    // Первая строчная — только первый символ старого H1, далее как было.
    expect(res.newH1).toBe(`Ботокс: а${'А'.repeat(79)}`);
  });

  it('H1 внутри code-fence не считается: найден первый настоящий H1, фенс цел', () => {
    const md = [
      '```markdown', '# Фейковый заголовок', '```', '',
      '# Реальный заголовок статьи', '', '## Секция', '', HEALTHY_PARA,
    ].join('\n');
    const res = ensureH1WithMainQuery(md, 'ботокс');
    expect(res.fixed).toBe(true);
    expect(res.newH1).toBe('Ботокс: реальный заголовок статьи');
    expect(res.text).toContain('# Фейковый заголовок');
  });
});

/* ── §6-A3 FIX-LEN (2026-08-25): резерв хвоста 4000 ─────────────────────── */

describe('CHUNK_TAIL_RESERVE_CHARS — §6-A3: резерв хвоста статьи (FAQ+подпись)', () => {
  /** Абзац РОВНО len символов (как в FIX-D3-дескрайбе выше). */
  function para(marker, len) {
    const filler =
      'Чистка лица удаляет ороговевшие клетки кожи и избытки кожного сала, выравнивает рельеф и тон лица, стимулирует кровообращение и обменные процессы в коже. ';
    let s = `${marker}: `;
    while (s.length < len) s += filler;
    return s.slice(0, len);
  }

  it('константа = 4000 (FAQ ~3000 + подпись ~200 + запас чанк-стопа)', () => {
    expect(CHUNK_TAIL_RESERVE_CHARS).toBe(4000);
  });

  it('target 10k с ДЕФОЛТНЫМ резервом: тело ~1.02× target триммится в окно базы; финал +FAQ ~3.3к ≤ 1.4× target', () => {
    const TARGET = 10_000;
    const base = TARGET - CHUNK_TAIL_RESERVE_CHARS; // 6000
    const md = [
      '# Тема статьи', '',
      '## Секция', '',
      para('АБЗАЦ-ЗАЩИЩЁН', 6500), '',
      para('АБЗАЦ-ХВОСТ', 3700), '',
    ].join('\n');
    // ~1.02× target — «нормальный» объём по старым меркам, но >1.3× базы.
    expect(md.length).toBeLessThanOrEqual(TARGET * 1.3);
    expect(md.length).toBeGreaterThan(base * 1.3);

    const res = trimOverlongArticleBody(md, { targetLength: TARGET }); // резерв по умолчанию
    expect(res.trimmed).toBe(true);
    expect(res.markdown.length).toBeLessThanOrEqual(base * 1.3);
    expect(res.markdown.length).toBeGreaterThanOrEqual(base * 1.05);

    // Финал С хвостом (FAQ ~3.3к поверх тела) — в окне BODY-LENGTH-RANGE 0.7–1.4×.
    const faq =
      '## 10 необычных вопросов о теме статьи\n\n' +
      Array.from({ length: 10 }, () => `### Вопрос про тему?\n\n${para('ОТВЕТ-FAQ', 300)}\n\n`).join('');
    const finalLen = (res.markdown + '\n\n' + faq).length;
    expect(finalLen / TARGET).toBeGreaterThanOrEqual(0.7);
    expect(finalLen / TARGET).toBeLessThanOrEqual(1.4);
  });
});

describe('generateFallbackArticle', () => {
  it('produces a full article object from a structure + context', () => {
    const result = generateFallbackArticle(
      {
        h1Ru: 'Тест',
        sectionsRu: [{ headingRu: 'Раздел', purposeRu: 'Контент', keyPointsRu: ['пункт'] }],
      },
      { specialistName: 'Иванов', serviceName: 'Услуга', projectTitle: 'Компания' }
    );

    expect(result).toBeTypeOf('object');
    expect(result.titleRu).toBe('Тест');
    expect(result.descriptionRu).toBeTypeOf('string');
    expect(result.descriptionRu.length).toBeGreaterThan(0);
    expect(result.articleMarkdownRu).toBeTypeOf('string');
    expect(result.articleMarkdownRu).toContain('# Тест');
    expect(result.articleMarkdownRu).toContain('## Раздел');
    expect(result.faqRu).toEqual([]);
    expect(result.claimsForReviewRu).toEqual([]);
    expect(result.riskyPhrasesRu).toEqual([]);
    expect(result._fallbackGenerated).toBe(true);
    expect(result._fallbackWordCount).toBeGreaterThan(0);
  });

  it('does not crash on null inputs and returns a default article', () => {
    const result = generateFallbackArticle(null, null);
    expect(result).toBeTypeOf('object');
    expect(result.titleRu).toBe('Статья');
    expect(result.articleMarkdownRu).toContain('# Статья');
    expect(result._fallbackGenerated).toBe(true);
    expect(result._fallbackWordCount).toBeGreaterThan(0);
  });

  it('does not crash on empty objects', () => {
    const result = generateFallbackArticle({}, {});
    expect(result).toBeTypeOf('object');
    expect(result.titleRu).toBe('Статья');
    expect(result.articleMarkdownRu).toBeTypeOf('string');
  });

  it('uses context.articleTitle when structureData has no h1Ru', () => {
    const result = generateFallbackArticle({}, { articleTitle: 'Из контекста' });
    expect(result.titleRu).toBe('Из контекста');
    expect(result.articleMarkdownRu).toContain('# Из контекста');
  });

  it('includes specialist name in content when provided', () => {
    const result = generateFallbackArticle({}, { specialistName: 'Доктор Ватсон' });
    expect(result.articleMarkdownRu).toContain('Доктор Ватсон');
  });

  it('includes price in content when provided', () => {
    const result = generateFallbackArticle({}, { priceLabel: '5 000 ₽' });
    expect(result.articleMarkdownRu).toContain('5 000 ₽');
  });
});

describe('postProcessArticle', () => {
  it('returns {ok:false} when articleMarkdownRu is empty', () => {
    const result = postProcessArticle({ parsed: { articleMarkdownRu: '' } });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns {ok:true} with valid markdown and returns parsed data', () => {
    const input = {
      parsed: {
        articleMarkdownRu: '# Заголовок\n\n## Первый раздел\n\nТекст раздела.',
        faqRu: [],
        titleRu: 'Заголовок',
      },
    };
    const result = postProcessArticle(input);
    expect(result.ok).toBe(true);
    expect(result.result.parsed.articleMarkdownRu).toBeTypeOf('string');
    expect(result.result.postProcessed.sectionCount).toBeGreaterThanOrEqual(1);
  });

  // U4 (2026-08-20): легаси-вставка мини-FAQ из faqRu УДАЛЕНА. Единственный
  // источник FAQ — конвейерный faq-generator («10 необычных вопросов» в
  // saveFinalVersion); faqRu больше нигде не рендерится (поле контракта
  // остаётся — роль его заполняет).
  it('does NOT insert a legacy FAQ block when faqRu is provided (U4)', () => {
    const input = {
      parsed: {
        articleMarkdownRu: '# Title\n\n## Section\n\nSome text.',
        faqRu: [
          { questionRu: 'Вопрос раз?', answerRu: 'Ответ раз.' },
          { questionRu: 'Вопрос два?', answerRu: 'Ответ два.' },
        ],
      },
    };
    const result = postProcessArticle(input);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.result.parsed.articleMarkdownRu).toBe('# Title\n\n## Section\n\nSome text.');
    expect(result.result.parsed.articleMarkdownRu).not.toContain('Часто задаваемые вопросы');
    expect(result.result.parsed.articleMarkdownRu).not.toContain('Вопрос раз?');
    expect(result.result.postProcessed.faqInserted).toBeUndefined();
  });

  it('large faqRu does not change markdown either (no insertion path at all)', () => {
    const markdown = '# Title\n\n## Section\n\nУникальный текст секции статьи.';
    const result = postProcessArticle({
      parsed: {
        articleMarkdownRu: markdown,
        faqRu: Array.from({ length: 12 }, (_, i) => ({ questionRu: `В${i}?`, answerRu: `О${i}.` })),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.result.parsed.articleMarkdownRu).toBe(markdown);
    expect(result.result.postProcessed.totalChars).toBe(markdown.length);
  });

  it('does not crash on empty input {}', () => {
    const result = postProcessArticle({});
    expect(result.ok).toBe(false);
  });

  it('does not crash on undefined (default param kicks in)', () => {
    const result = postProcessArticle();
    expect(result.ok).toBe(false);
  });

  // NOTE: postProcessArticle(null) throws TypeError because the `= {}`
  // default only applies to `undefined`, not `null`. This is a real
  // robustness gap in server/article-post-processor.mjs (destructure of null).
  it('throws on null input (documented code gap)', () => {
    expect(() => postProcessArticle(null)).toThrow(TypeError);
  });

  // B3: the catalog-injection branch in postProcessArticle was dead code (catalog
  // was never passed by any caller) and has been removed. The single source of
  // internal-link injection is now saveFinalVersion in the worker. This test
  // pins that contract: passing a catalog here must NOT inject links.
  it('does NOT inject internal links even when a catalog is passed (dead branch removed)', () => {
    const markdown = '# Title\n\n## Section\n\nУслуга Ботокс доступна.';
    const result = postProcessArticle({
      parsed: { articleMarkdownRu: markdown, faqRu: [] },
      catalog: {
        services: [{ name: 'Ботокс', url: 'https://www.example.com/services/botoks' }],
        specialists: [],
      },
    });
    expect(result.ok).toBe(true);
    // No markdown link to the service URL should have been added here.
    expect(result.result.parsed.articleMarkdownRu).not.toContain(
      'https://www.example.com/services/botoks'
    );
    // B3: the internalLinks metric was removed along with the dead branch.
    expect(result.result.postProcessed.internalLinks).toBeUndefined();
  });

  // P3 (2026-08-16): length-aware expansion («Дополнительная экспертная
  // информация») удалён. Секция была набивкой из повторяющихся keyPoints
  // (одни и те же пункты ×3) и не несла читателю ценности; недобор объёма
  // решается на уровне промптов/chunking, а не дублированием списков.
  // Пинним контракт: даже при сильном недоборе (<85% target) и наличии
  // keyPoints/verifiedFacts тех. секция НЕ генерируется.
  it('does NOT append «Дополнительная экспертная информация» on big volume shortfall (P3)', () => {
    const shortMarkdown = '# Title\n\n## Section\n\nКороткий текст.';
    const result = postProcessArticle({
      parsed: { articleMarkdownRu: shortMarkdown, faqRu: [], titleRu: 'Title' },
      targetLength: 50_000,
      keyPoints: ['ключевой пункт один', 'ключевой пункт два'],
      verifiedFacts: [{ factRu: 'Проверенный факт.' }],
    });
    expect(result.ok).toBe(true);
    expect(result.result.parsed.articleMarkdownRu).toBe(shortMarkdown);
    expect(result.result.parsed.articleMarkdownRu).not.toMatch(/Дополнительная экспертная информация/);
    expect(result.result.postProcessed.wordsAdded).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * seo-deterministic (2026-08-27, план 20260827-seo-deterministic v1.1):
 * три детерминированных пост-правила — injectExpertsBlock (b),
 * ensureSiteMentions (c), reduceKeySpam (a). Порядок в воркере: b → c → a.
 * ════════════════════════════════════════════════════════════════════════ */

const SEO_KEY = 'лазерная эпиляция';
// M2: ключи ядра живут в semanticCore.lsiTermsRu (частотный источник убран).
const SEO_CORE_CTX = { mainQueryRu: SEO_KEY, queryClustersRu: [], lsiTermsRu: [SEO_KEY] };
const SEO_CTX = { semanticCore: SEO_CORE_CTX, targetLength: 10_000 };

/** Уникальный нейтральный наполнитель БЕЗ ключей до нужного объёма. */
function seoFillerTo(parts, minChars) {
  let i = 0;
  while (parts.join('\n').length < minChars) {
    i += 1;
    parts.push(`Нейтральное предложение №${i} описывает восстановительный период и домашний уход без поисковых фраз.`, '');
  }
  return parts;
}

const SPAM_PARA = (i) =>
  `Абзац №${i}: лазерная эпиляция даёт стойкий результат при курсовом подходе, важно соблюдать интервалы между визитами и рекомендации косметолога после каждого сеанса.`;
const DILUTED_PARA = (i) =>
  `Абзац №${i}: лазерная и аппаратная эпиляция дополняют друг друга в курсе, а график посещений утверждает косметолог на очной консультации.`;
const INTRO_PARA =
  'ПЕРВОЕ-ВХОЖДЕНИЕ: лазерная эпиляция относится к аппаратным методам удаления волос и требует курса процедур, назначенного косметологом после осмотра.';

/** Тело с N спам-абзацами (точные вхождения ключа) + наполнитель до норматива. */
function spamDoc({ paragraphs = 30, para = SPAM_PARA, minChars = 8600, faqWithKey = false } = {}) {
  const parts = ['# Лазерная эпиляция: полное руководство', '', INTRO_PARA, ''];
  for (let i = 1; i <= paragraphs; i += 1) parts.push(para(i), '');
  seoFillerTo(parts, minChars);
  const faqHeading = faqWithKey ? '## 10 необычных вопросов про лазерная эпиляция' : '## 10 необычных вопросов про процедуру';
  parts.push(faqHeading, '', '### Вопрос один?', '', 'Короткий честный ответ без ключей.', '');
  return parts.join('\n');
}

const countSubstrings = (md, s) => md.toLowerCase().split(s.toLowerCase()).length - 1;

const h2Headings = (md) =>
  [...md.matchAll(/^ {0,3}##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1].trim());
const h2WithKeys = (md, key = SEO_KEY) => h2Headings(md).filter((h) => keyUsedInText(h, key));

describe('reduceKeySpam — v1.1 п.1: авторедукция плотности ядра', () => {
  it('пер-ключ превышение: лишние точные вхождения редуцируются с конца, плотность ≤ per-key fail-капа', () => {
    const md = spamDoc();
    const before = countSubstrings(md, SEO_KEY); // ~32 (H1 + интро + 30 абзацев)
    expect(before).toBeGreaterThan(30);

    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.perKey).toBeGreaterThanOrEqual(5);
    const after = countSubstrings(res.text, SEO_KEY);
    expect(after).toBeLessThan(before);

    // Постчек-паритет: пер-ключ плотность после редукции ≤ 2.5% (fail-кап).
    const report = runArticlePostcheck({ markdown: res.text, context: SEO_CTX });
    const perKey = report.rules.find((r) => r.id === 'SEO-DENSITY-PER-KEY');
    expect(perKey.details.worst.share).toBeLessThanOrEqual(0.0251);
    // Первое вхождение (интро-абзац) неприкосновенно.
    expect(res.text).toContain('ПЕРВОЕ-ВХОЖДЕНИЕ: лазерная эпиляция');
    // H1 не тронут.
    expect(res.text).toMatch(/^# Лазерная эпиляция: полное руководство$/m);
  });

  it('untouchable-зоны (v1.1 п.2+п.5): анкор, таблица, FAQ, блок экспертов не тронуты', () => {
    const parts = ['# Лазерная эпиляция: полное руководство', '', INTRO_PARA, ''];
    for (let i = 1; i <= 25; i += 1) parts.push(SPAM_PARA(i), '');
    seoFillerTo(parts, 8600);
    const ANCHOR = `[лазерная эпиляция](${'https://company-origin.test/services/laser'})`;
    parts.push('Смотрите подробнее на', '', `${ANCHOR} — страница услуги.`, '');
    parts.push('| Метод | Эффект |', '|---|---|', '| лазерная эпиляция | стойкий результат |', '');
    parts.push('## Консультация специалистов компании Пример', '',
      'Иванова Анна Петровна, эксперт по подбору решений — лазерная эпиляция и аппаратные методики ([страница специалиста](https://company-origin.test/doctors/ivanova)).', '');
    parts.push('## 10 необычных вопросов про лазерная эпиляция', '', '### Вопрос один?', '', 'Короткий ответ.', '');
    const md = parts.join('\n');

    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.perKey).toBeGreaterThanOrEqual(3); // тело редуцировано
    // Анкор целый (и текст, и URL).
    expect(res.text).toContain(ANCHOR);
    // Таблица цела.
    expect(res.text).toContain('| лазерная эпиляция | стойкий результат |');
    // FAQ-зона цела.
    expect(res.text).toContain('## 10 необычных вопросов про лазерная эпиляция');
    // Блок экспертов цел.
    expect(res.text).toContain('## Консультация специалистов компании Пример');
    expect(res.text).toContain('лазерная эпиляция и аппаратные методики');
  });

  it('разбавленные вхождения не заменяемы: текст не рвём, честный cap-not-reached', () => {
    // minChars 12000: общая плотность 62/1520 ≈ 4.1% ≤ fail-капа 4.5% —
    // срабатывает ТОЛЬКО пер-ключ фаза (весь перебор разбавлен → отказ).
    const md = spamDoc({ paragraphs: 30, para: DILUTED_PARA, minChars: 12_000 });
    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.text).toBe(md); // честный отказ — не рвать текст
    expect(res.reduced.perKey).toBe(0);
    expect(res.reduced.total).toBe(0);
    expect(Array.isArray(res.stats.capNotReached)).toBe(true);
    expect(res.stats.capNotReached.length).toBeGreaterThanOrEqual(1);
    expect(res.stats.capNotReached[0].key).toBe(SEO_KEY);
  });

  it('заголовки: доля с ключами > 0.65 → лишние (с конца) заменяются вне-ядровым словом', () => {
    const parts = ['# Лазерная эпиляция: полное руководство', ''];
    for (let i = 1; i <= 10; i += 1) {
      const heading = i <= 8 ? `Лазерная эпиляция: аспект №${i}` : `Общие рекомендации №${i}`;
      parts.push(`## ${heading}`, '', `Нейтральный абзац №${i} про уход и восстановление без ключей.`, '');
    }
    seoFillerTo(parts, 8600);
    parts.push('## 10 необычных вопросов про процедуру', '', '### Вопрос?', '', 'Ответ.', '');
    const md = parts.join('\n');
    expect(h2Headings(md).length).toBe(11); // 10 контентных + FAQ
    expect(h2WithKeys(md).length).toBe(8);

    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.headings).toBeGreaterThanOrEqual(1);
    // Заголовки не пропали и не задублировались.
    expect(h2Headings(res.text).length).toBe(11);
    // Доля с ключами (H2/H3 вне FAQ-тел, знаменатель — паритет постчека) вошла в окно ≤0.65: 8/11→7/11.
    expect(h2WithKeys(res.text).length).toBeLessThanOrEqual(7);
    // Замена — вне-ядровым словом (заголовок не развалился: номинативное слово на месте ключа).
    expect(res.text).toMatch(/^## (Работа|Метод|Инструмент|Технология|Решение|Этап|Подход|Техника): аспект №/m);
    // Постчек-паритет: SEO-HEADINGS-SPAM больше не фейлит.
    const report = runArticlePostcheck({ markdown: res.text, context: SEO_CTX });
    expect(report.rules.find((r) => r.id === 'SEO-HEADINGS-SPAM').status).toBe('pass');
  });

  it('текст < SEO_MIN_NORM_CHARS (8000) → no-op', () => {
    const parts = [`# ${SEO_KEY}: гид`, ''];
    for (let i = 1; i <= 12; i += 1) parts.push(SPAM_PARA(i), '');
    const md = parts.join('\n');
    expect(md.length).toBeLessThan(8000);
    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.text).toBe(md);
    expect(res.reduced.perKey + res.reduced.total + res.reduced.headings).toBe(0);
  });

  it('идемпотентность: повторный вызов не меняет текст', () => {
    const md = spamDoc();
    const first = reduceKeySpam(md, SEO_CORE_CTX);
    const second = reduceKeySpam(first.text, SEO_CORE_CTX);
    expect(second.text).toBe(first.text);
    expect(second.reduced.perKey + second.reduced.total + second.reduced.headings).toBe(0);
  });

  it('мусорный ввод (пусто/undefined/null, ядро без ключей) не бросает', () => {
    expect(reduceKeySpam('', SEO_CORE_CTX, {}).text).toBe('');
    expect(reduceKeySpam(undefined, SEO_CORE_CTX, {}).text).toBe('');
    expect(reduceKeySpam(null, SEO_CORE_CTX, {}).text).toBe('');
    const short = '# Т\n\n## S\n\nТекст.';
    expect(reduceKeySpam(short, {}, {}).text).toBe(short);
  });
});

/* ── QA#2 блокер B1: делекция словоформы не оставляет висячих предлогов ─── */

// Косвенные формы ключа («лазерной эпиляции») — морфо-вхождения без точного
// совпадения словоформы → путь ДЕЛЕКЦИИ (v1.1 п.1), а не замены.
const GENITIVE_PARA = (i) =>
  `Абзац №${i}: восстановление после лазерной эпиляции занимает от двух до четырёх недель, а контроль косметолога остаётся обязательным условием каждого этапа курса.`;
const DATIVE_PARA = (i) =>
  `Подход №${i} к лазерной эпиляции формируется индивидуально после консультации и диагностики состояния кожи пациента.`;
const DLYA_PARA = (i) =>
  `Рекомендации №${i} для лазерной эпиляции включают отказ от загара и агрессивных пилингов за несколько недель до первого сеанса.`;
const MULTI_SENT_PARA = (i) =>
  `Совет №${i} актуален всегда. Подготовка нужна для лазерной эпиляции. Дальнейший план утверждает косметолог.`;
const SOLO_PARA = (i) => `Совет №${i} для лазерной эпиляции.`;

describe('reduceKeySpam — QA#2 B1: предлог уходит вместе с косвенной словоформой', () => {
  it('«после лазерной эпиляции» → «после» удаляется ВМЕСТЕ со спаном (нет «восстановление после занимает»)', () => {
    const md = spamDoc({ paragraphs: 30, para: GENITIVE_PARA });
    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.perKey).toBeGreaterThanOrEqual(3);
    // Редукция была: косвенных вхождений стало меньше.
    expect(countSubstrings(res.text, 'лазерной эпиляции')).toBeLessThan(countSubstrings(md, 'лазерной эпиляции'));
    // НИГДЕ нет висячего предлога после делекции.
    expect(res.text).not.toMatch(/после\s+занимает/);
    expect(res.text).not.toMatch(/восстановление после занимает/);
    // Грамматичный результат на местах редукции.
    expect(res.text).toMatch(/восстановление занимает от двух/);
    // H1 (точная форма, untouchable) цел.
    expect(res.text).toMatch(/^# Лазерная эпиляция: полное руководство$/m);
  });

  it('«к лазерной эпиляции» и «для лазерной эпиляции» → предлоги к/для уходят вместе со спаном', () => {
    const parts = ['# Лазерная эпиляция: полное руководство', '', INTRO_PARA, ''];
    for (let i = 1; i <= 30; i += 1) parts.push(i % 2 ? DATIVE_PARA(i) : DLYA_PARA(i), '');
    seoFillerTo(parts, 8600);
    parts.push('## 10 необычных вопросов про процедуру', '', '### Вопрос один?', '', 'Короткий честный ответ без ключей.', '');
    const md = parts.join('\n');

    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.perKey).toBeGreaterThanOrEqual(3);
    expect(countSubstrings(res.text, 'лазерной эпиляции')).toBeLessThan(countSubstrings(md, 'лазерной эпиляции'));
    // Нет висячих «к формируется» / «для включают».
    expect(res.text).not.toMatch(/\bк\s+формируется/);
    expect(res.text).not.toMatch(/\bдля\s+включают/);
    // Грамматичные остатки на местах редукции.
    expect(res.text).toMatch(/Подход №\d+ формируется индивидуально/);
    expect(res.text).toMatch(/Рекомендации №\d+ включают отказ/);
  });

  it('эскалация на предложение: остаток <3 слов («Подготовка нужна.») → всё предложение удалено', () => {
    const md = spamDoc({ paragraphs: 30, para: MULTI_SENT_PARA });
    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.perKey).toBeGreaterThanOrEqual(3);
    // Соседние предложения абзаца целы, обрывочное — удалено ЦЕЛИКОМ.
    expect(res.text).toMatch(/Совет №\d+ актуален всегда\.\s+Дальнейший план утверждает косметолог\./);
    // Огрызка «Подготовка нужна.» нет: фраза живёт только в kept-вхождениях,
    // где предложение осталось ЦЕЛИКОМ (с ключом), никогда — обрывком.
    for (const line of res.text.split('\n')) {
      if (line.includes('Подготовка нужна')) expect(line).toContain('для лазерной эпиляции');
    }
    expect(res.text).not.toMatch(/Подготовка нужна\.\s+Дальнейший/); // огрызок между соседями
  });

  it('однопредложенческий абзац с обрывочным остатком → строка-абзац удаляется целиком, без заглушек', () => {
    const md = spamDoc({ paragraphs: 30, para: SOLO_PARA });
    const before = (md.match(/^Совет №\d+ для лазерной эпиляции\.$/gm) || []).length;
    expect(before).toBe(30);

    const res = reduceKeySpam(md, SEO_CORE_CTX);
    expect(res.reduced.perKey).toBeGreaterThanOrEqual(3);
    const after = (res.text.match(/^Совет №\d+ для лазерной эпиляции\.$/gm) || []).length;
    expect(after).toBeLessThan(before); // лишние абзацы ушли
    // НЕТ огрызков-заглушек (QA: «срезать заглушку вида "Абзац N14."» нельзя):
    expect(res.text).not.toMatch(/^Совет №\d+[.:]?\s*$/m);
    expect(res.text).not.toMatch(/^Абзац №\d+[:.]?\s*$/m);
    // Соседний контент цел: H1, интро (первое вхождение), FAQ.
    expect(res.text).toMatch(/^# Лазерная эпиляция: полное руководство$/m);
    expect(res.text).toContain('ПЕРВОЕ-ВХОЖДЕНИЕ: лазерная эпиляция');
    expect(res.text).toContain('## 10 необычных вопросов про процедуру');
  });

  it('все существующие контракты стабильны: идемпотентность на косвенных формах', () => {
    const md = spamDoc({ paragraphs: 30, para: GENITIVE_PARA });
    const first = reduceKeySpam(md, SEO_CORE_CTX);
    const second = reduceKeySpam(first.text, SEO_CORE_CTX);
    expect(second.text).toBe(first.text);
    expect(second.reduced.perKey + second.reduced.total + second.reduced.headings).toBe(0);
  });
});

/* ── v1.1 задача 2: injectExpertsBlock ─────────────────────────────────── */

const EXPERTS = [
  { fullName: 'Иванова Анна Петровна', pageUrl: 'https://company-origin.test/doctors/ivanova', position: 'эксперт по подбору решений', specialization: 'лазерные и аппаратные технологии в косметологии' },
  { fullName: 'Петров Пётр Иванович', pageUrl: 'https://company-origin.test/doctors/petrov', position: 'косметолог', specialization: 'инъекционные методики' },
  { fullName: 'Сидорова Мария Львовна', pageUrl: 'https://company-origin.test/doctors/sidorova', position: 'дерматовенеролог', specialization: 'дерматоонкология и трихология' },
  { fullName: 'Кузнецов Игорь Львович', pageUrl: '', position: 'хирург', specialization: 'без страницы' },
];

const EXPERTS_FAQ = '## 10 необычных вопросов про процедуру\n\n### Вопрос?\n\nОтвет.';

function expertsDoc() {
  return [
    '# Тема статьи: гид', '',
    'Вводный абзац о методе коррекции и восстановительном периоде без упоминаний специалистов.', '',
    '## Основная часть', '',
    'Нейтральный абзац о подготовке, ходе процедуры и уходе после неё, без фамилий и должностей.', '',
    '## Заключение', '',
    'Итоговый абзац о консультации и индивидуальном плане.', '',
    EXPERTS_FAQ, '',
  ].join('\n');
}

describe('injectExpertsBlock — v1.1 задача 2: блок консультации (без выбранного специалиста)', () => {
  it('0 упоминаний каталога → блок ПЕРЕД FAQ: 2-3 буллета с разными pageUrl и подписью компании', () => {
    const md = expertsDoc();
    const res = injectExpertsBlock(md, EXPERTS, 'Пример', 'seed-1');
    expect(res.inserted).toBe(true);
    const blockIdx = res.markdown.indexOf(res.heading);
    const faqIdx = res.markdown.indexOf(EXPERTS_FAQ);
    expect(blockIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(faqIdx);
    // Заголовок содержит имя компании в исходной форме.
    expect(res.heading).toContain('Пример');
    // 3 специалиста (у 4-го нет pageUrl — не выбран), уникальные URL.
    expect(res.specialistsUsed.length).toBe(3);
    const urls = res.markdown.match(/\]\(https:\/\/company-origin\.test\/doctors\/[a-z]+\)/g) || [];
    expect(new Set(urls).size).toBe(3);
    expect(res.markdown).toContain('Подобрать метод коррекции и составить личный план можно на очной консультации:');
    expect(res.markdown).toContain('[страница специалиста](https://company-origin.test/doctors/ivanova)');
    // Буллеты: ФИО + должность + специализация.
    expect(res.markdown).toMatch(/- Иванова Анна Петровна, эксперт по подбору решений — лазерные и аппаратные технологи/i);
  });

  it('≥2 имён каталога уже морфо-упомянуты → no-op', () => {
    const md = expertsDoc().replace(
      'Нейтральный абзац о подготовке, ходе процедуры и уходе после неё, без фамилий и должностей.',
      'Опыт специалистов — Иванова Анна Петровна и Петров Пётр Иванович — описан в разделе отзывов.',
    );
    const res = injectExpertsBlock(md, EXPERTS, 'Пример', 'seed-1');
    expect(res.inserted).toBe(false);
    expect(res.markdown).toBe(md);
  });

  it('heading-гард: блок любого из 3 вариантов уже есть → no-op (идемпотентность)', () => {
    for (const heading of [
      '## Консультация специалистов компании Пример',
      '## Консультация экспертов компании Пример',
      '## Эксперты компании Пример: как попасть на приём',
    ]) {
      const md = expertsDoc().replace('## Заключение', `${heading}\n\nТекст блока.\n\n## Заключение`);
      const res = injectExpertsBlock(md, EXPERTS, 'Пример', 'seed-2');
      expect(res.inserted).toBe(false);
      expect(res.markdown).toBe(md);
    }
    // Идемпотентность повторным вызовом.
    const first = injectExpertsBlock(expertsDoc(), EXPERTS, 'Пример', 'seed-1');
    const second = injectExpertsBlock(first.markdown, EXPERTS, 'Пример', 'seed-1');
    expect(second.inserted).toBe(false);
    expect(second.markdown).toBe(first.markdown);
  });

  it('legacy-заголовок блока экспертов (статья до перехода) → no-op, второй блок не вставляется', () => {
    // Технический маркер старого формата собран из фрагментов: в файле нет слов одной отрасли.
    const legacyHeading = ['## Консультация ', 'вра', 'чей ', 'клини', 'ки Пример'].join('');
    const md = expertsDoc().replace('## Заключение', `${legacyHeading}\n\nТекст блока.\n\n## Заключение`);
    const res = injectExpertsBlock(md, EXPERTS, 'Пример', 'seed-legacy');
    expect(res.inserted).toBe(false);
    expect(res.markdown).toBe(md);
  });

  it('FAQ нет → блок перед ПОСЛЕДНИМ H2 (заключением)', () => {
    const md = expertsDoc().replace(`\n${EXPERTS_FAQ}\n`, '\n');
    const res = injectExpertsBlock(md, EXPERTS, 'Пример', 'seed-3');
    expect(res.inserted).toBe(true);
    const blockIdx = res.markdown.indexOf(res.heading);
    const conclusionIdx = res.markdown.indexOf('## Заключение');
    const mainIdx = res.markdown.indexOf('## Основная часть');
    expect(blockIdx).toBeLessThan(conclusionIdx);
    expect(blockIdx).toBeGreaterThan(mainIdx);
  });

  it('ротация от seedId: разные seed — разный первый специалист (детерминированно)', () => {
    const firstNames = ['1', '2', '3', '4', '5', '6'].map((seed) => {
      const res = injectExpertsBlock(expertsDoc(), EXPERTS, 'Пример', seed);
      return res.specialistsUsed[0].name;
    });
    expect(new Set(firstNames).size).toBeGreaterThan(1);
    // Детерминизм: тот же seed — тот же результат.
    const a = injectExpertsBlock(expertsDoc(), EXPERTS, 'Пример', '2').markdown;
    const b = injectExpertsBlock(expertsDoc(), EXPERTS, 'Пример', '2').markdown;
    expect(a).toBe(b);
  });

  it('мусорный ввод: пустой markdown / каталог без pageUrl → no-op без throw', () => {
    expect(injectExpertsBlock('', EXPERTS, 'X', 's').inserted).toBe(false);
    expect(injectExpertsBlock(undefined, EXPERTS, 'X', 's').inserted).toBe(false);
    expect(injectExpertsBlock(expertsDoc(), [], 'X', 's').inserted).toBe(false);
    expect(injectExpertsBlock(expertsDoc(), [{ fullName: 'Без Страницы', pageUrl: '' }], 'X', 's').inserted).toBe(false);
  });
});

/* ── v1.1 задача 3: ensureSiteMentions ───────────────────────────────── */

function mentionsDoc({ withExpertsBlock = true } = {}) {
  const base = [
    '# Тема статьи: гид', '',
    'Вводный абзац о методе коррекции и восстановительном периоде.', '',
    '## Основная часть', '',
    'Нейтральный абзац без упоминания компании.', '',
  ];
  if (withExpertsBlock) {
    base.push(
      '## Консультация специалистов компании Пример', '',
      'Подобрать метод коррекции и составить личный план можно на очной консультации:', '',
      '- Иванова Анна Петровна, эксперт по подбору решений — лазерные технологии ([страница специалиста](https://company-origin.test/doctors/ivanova))', '',
    );
  }
  base.push(EXPERTS_FAQ, '');
  return base.join('\n');
}

describe('ensureSiteMentions — v1.1 задача 3: CTA-упоминания компании (≤2)', () => {
  it('дефицит + блок экспертов → 2 CTA: одна в блоке, одна в конце тела перед блоком/FAQ', () => {
    const md = mentionsDoc(); // 1 упоминание (заголовок блока)
    const res = ensureSiteMentions(md, 'Пример', 3, 'seed-1');
    expect(res.added).toBe(2);
    expect(res.mentionsBefore).toBe(1);
    expect(res.mentionsAfter).toBe(3);
    // Обе фразы содержат имя компании в исходной форме (не склонённое).
    const phraseLines = res.markdown.split('\n').filter((l) => l.includes('Пример') && !l.startsWith('#') && !l.startsWith('-'));
    expect(phraseLines.length).toBe(2);
    // Одна CTA — внутри блока (после буллетов, до FAQ), другая — до заголовка блока.
    const blockIdx = res.markdown.indexOf('## Консультация специалистов компании Пример');
    const faqIdx = res.markdown.indexOf(EXPERTS_FAQ);
    const inBlock = phraseLines.find((l) => res.markdown.indexOf(l) > blockIdx && res.markdown.indexOf(l) < faqIdx);
    const beforeBlock = phraseLines.find((l) => res.markdown.indexOf(l) < blockIdx);
    expect(inBlock).toBeTruthy();
    expect(beforeBlock).toBeTruthy();
  });

  it('норма упоминаний → не трогает', () => {
    const md = mentionsDoc().replace(
      'Нейтральный абзац без упоминания компании.',
      'Специалисты компании Пример рекомендуют курс. Вторая строка про компанию Пример и уход.',
    ); // 1 (заголовок блока) + 2 = 3
    const res = ensureSiteMentions(md, 'Пример', 3, 'seed-1');
    expect(res.added).toBe(0);
    expect(res.markdown).toBe(md);
  });

  it('блока нет → обе CTA в конец тела перед FAQ; FAQ цел', () => {
    const md = mentionsDoc({ withExpertsBlock: false }); // 0 упоминаний
    const res = ensureSiteMentions(md, 'Пример', 2, 'seed-2');
    expect(res.added).toBe(2);
    expect(res.mentionsAfter).toBe(2);
    const faqIdx = res.markdown.indexOf(EXPERTS_FAQ);
    const phraseLines = res.markdown.split('\n').filter((l) => l.includes('Пример'));
    expect(phraseLines.length).toBe(2);
    for (const line of phraseLines) expect(res.markdown.indexOf(line)).toBeLessThan(faqIdx);
    expect(res.markdown).toContain(EXPERTS_FAQ);
  });

  it('идемпотентность + substring-гард: существующая фраза не дублируется', () => {
    const existing = 'Записаться на консультацию в компанию Пример можно по телефону или через форму на сайте.';
    const md = mentionsDoc({ withExpertsBlock: false }).replace(
      'Нейтральный абзац без упоминания компании.',
      existing,
    ); // 1 упоминание, min 3
    const res = ensureSiteMentions(md, 'Пример', 3, 'seed-4');
    expect(res.added).toBe(2); // две ДРУГИЕ фразы
    expect(countSubstrings(res.markdown, existing)).toBe(1);
    // Повторный вызов — норма достигнута, no-op.
    const second = ensureSiteMentions(res.markdown, 'Пример', 3, 'seed-4');
    expect(second.added).toBe(0);
    expect(second.markdown).toBe(res.markdown);
  });

  it('FAQ нет → CTA в конец документа; min ≤ 0 / пустое имя → no-op', () => {
    const md = mentionsDoc({ withExpertsBlock: false }).replace(`\n${EXPERTS_FAQ}\n`, '\n');
    const res = ensureSiteMentions(md, 'Пример', 2, 'seed-5');
    expect(res.added).toBe(2);
    expect(res.markdown.trimEnd().endsWith('.')).toBe(true); // документ заканчивается CTA-предложением
    expect(countSubstrings(res.markdown, 'Пример')).toBe(2);

    expect(ensureSiteMentions(md, 'Пример', 0, 's').added).toBe(0);
    expect(ensureSiteMentions(md, 'Пример', null, 's').added).toBe(0);
    expect(ensureSiteMentions(md, '', 3, 's').added).toBe(0);
    expect(ensureSiteMentions('', 'Пример', 3, 's').added).toBe(0);
    expect(ensureSiteMentions(undefined, 'Пример', 3, 's').added).toBe(0);
  });
});


describe('mergeEmptySections — G1(c)-pass2: секция, опустевшая ПОСЛЕ контент-мутаторов', () => {
  it('огрызок 62 симв (трим выжег тело до одной фразы) сливается повторным проходом; FAQ-хвост не тронут', () => {
    // Реальный кейс e18dc6ec: после трима/детерминаторов от секции осталась
    // одна фраза — первый проход (до мутаторов) её не видел.
    const md = [
      '# Криолиполиз или Ультраформер', '',
      '## Принцип действия', '',
      HEALTHY_PARA, '',
      '## Динамика изменений и период реабилитации', '',
      'Четкое понимание сроков помогает правильно настроить ожидания.', '',
      '## 10 необычных вопросов про процедуру', '',
      '### Вопрос 1?', '',
      'Ответ.', '',
      '### Вопрос 2?', '',
      'Ответ.', '',
      '### Вопрос 3?', '',
      'Ответ.', '',
    ].join('\n');

    const res = mergeEmptySections(md);
    expect(res.count).toBe(1);
    expect(res.mergedHeadings).toEqual(['динамика изменений и период реабилитации']);
    expect(res.markdown).not.toContain('## Динамика изменений');
    expect(res.markdown).toContain('Четкое понимание сроков');
    // FAQ-секция за границей слияния — жива.
    expect(res.markdown).toContain('## 10 необычных вопросов');
  });

  it('идемпотентность: повторный проход на уже слитом тексте — count 0 (pass2 в воркере безопасен)', () => {
    const once = mergeEmptySections([
      '# Т', '', '## Живая секция', '', HEALTHY_PARA, '', '## Скелет', '', 'Мало.', '',
    ].join('\n'));
    expect(once.count).toBe(1);
    const twice = mergeEmptySections(once.markdown);
    expect(twice.count).toBe(0);
    expect(twice.markdown).toBe(once.markdown);
  });
});

/* ── P2-2: injectFormRecommendationBlock — слот §1.3 ────────────────── */

describe('injectFormRecommendationBlock — детерминированный блок записи (audit 7.5)', () => {
  /** Тело статьи без хвоста. */
  const BODY_MD = [
    '# Чистка лица: виды процедур', '',
    '## Виды чисток', '',
    HEALTHY_PARA, '',
    '## Заключение', '',
    'Чистка лица подбирается индивидуально после осмотра косметологом.', '',
  ].join('\n');
  const EXPERTS_MD = [
    '## Консультация специалистов компании Пример', '',
    'Подобрать метод коррекции можно на очной консультации:', '',
    '- Иванова Анна Сергеевна, эксперт по подбору решений', '',
  ].join('\n');
  const FAQ_MD = [
    '## 10 необычных вопросов про чистку лица', '',
    '### Больно ли делать чистку?', '',
    'Дискомфорт индивидуален и зависит от вида чистки.', '',
  ].join('\n');
  const SIGN_MD = '**Автор статьи:** Иванова Анна Сергеевна, эксперт по подбору решений';

  it('вставляет блок ПОСЛЕ блока экспертов (штатный порядок §1.3), перед FAQ', () => {
    const md = [BODY_MD, '', EXPERTS_MD, '', FAQ_MD, '', '---', '', SIGN_MD].join('\n');
    const out = injectFormRecommendationBlock(md, 'Пример', 'art-1');
    expect(out.inserted).toBe(true);
    expect(hasFormRecommendationBlock(out.markdown)).toBe(true);
    // порядок: эксперты → блок записи → FAQ
    const iExperts = out.markdown.indexOf('## Консультация специалистов');
    const iForm = out.markdown.indexOf('## Как записаться');
    const iFaq = out.markdown.indexOf('## 10 необычных вопросов');
    expect(iExperts).toBeGreaterThan(-1);
    expect(iForm).toBeGreaterThan(iExperts);
    expect(iFaq).toBeGreaterThan(iForm);
  });

  it('без блока экспертов — вставляет ПЕРЕД FAQ-секцией', () => {
    const md = [BODY_MD, '', FAQ_MD, '', '---', '', SIGN_MD].join('\n');
    const out = injectFormRecommendationBlock(md, 'Пример', 'art-1');
    expect(out.inserted).toBe(true);
    expect(out.markdown.indexOf('## Как записаться')).toBeLessThan(out.markdown.indexOf('## 10 необычных вопросов'));
  });

  it('без FAQ — вставляет ПЕРЕД подписью автора', () => {
    const md = [BODY_MD, '', '---', '', SIGN_MD].join('\n');
    const out = injectFormRecommendationBlock(md, 'Пример', 'art-1');
    expect(out.inserted).toBe(true);
    expect(out.markdown.indexOf('## Как записаться')).toBeLessThan(out.markdown.indexOf('**Автор статьи:**'));
  });

  it('без экспертов/FAQ/подписи — добавляет в КОНЕЦ документа', () => {
    const out = injectFormRecommendationBlock(BODY_MD, 'Пример', 'art-1');
    expect(out.inserted).toBe(true);
    expect(out.markdown.trim().endsWith('первому обращению.')).toBe(true);
  });

  it('идемпотентность: блок уже есть — no-op, текст не меняется (BullMQ-retry)', () => {
    const once = injectFormRecommendationBlock(BODY_MD, 'Пример', 'art-1');
    const twice = injectFormRecommendationBlock(once.markdown, 'Пример', 'art-1');
    expect(twice.inserted).toBe(false);
    expect(twice.reason).toBe('already-present');
    expect(twice.markdown).toBe(once.markdown);
  });

  it('crash-safe: некорректный вход → вход возвращается неизменным (нестроки → «»), НИКОГДА не бросает', () => {
    for (const bad of [null, undefined, 42, {}, '', '   ']) {
      let out = null;
      expect(() => {
        out = injectFormRecommendationBlock(bad, 'Company', 'a1');
      }).not.toThrow();
      expect(out.markdown).toBe(typeof bad === 'string' ? bad : '');
      expect(out.inserted).toBe(false);
    }
  });

  it('содержимое — чистый markdown без HTML; имя компании в исходной форме', () => {
    const out = injectFormRecommendationBlock(BODY_MD, 'Пример', 'art-1');
    expect(out.markdown).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(out.markdown).toContain('Пример');
    expect(out.heading).toMatch(/^Как записаться/);
  });

  it('постчек FORM-REC-PRESENT на выходе — pass (roundtrip контракта B→I→postcheck)', () => {
    const md = [BODY_MD, '', EXPERTS_MD, '', FAQ_MD, '', '---', '', SIGN_MD].join('\n');
    const out = injectFormRecommendationBlock(md, 'Пример', 'art-1');
    const report = runArticlePostcheck({ markdown: out.markdown, html: '', context: {} });
    const formRec = report.rules.find((r) => r.id === 'FORM-REC-PRESENT');
    expect(formRec.status).toBe('pass');
  });
});
