/**
 * Golden fixture for the article postcheck parity test.
 *
 * Two fixtures, both deterministic (no randomness, no clock, no network):
 *
 *  1. `goldenTopic` — a topic-only article body (the «golden topic»
 *     regression fixture): one H1, ten H2 sections with real plain text and a
 *     FAQ block of eight H3 questions. It is long enough (≫ SEO_MIN_NORM_CHARS)
 *     for the volume-dependent norms to apply, so the keyword-count and
 *     keyword-density rules are actually evaluated.
 *  2. `generatedBody` — the body produced by the mocked generation pipeline
 *     (tests/fixtures/role-outputs.mjs → ARTICLE_MARKDOWN), i.e. the
 *     «generated fixture» of the parity check.
 *
 * The context carries ONLY the semantic core (main query, query clusters, LSI)
 * — the M2 pipeline has no wordstat source any more, so the fixture must not
 * pretend one exists.
 */

/** The generated body of the mocked pipeline (tests/fixtures/role-outputs.mjs). */
export const GENERATED_BODY = [
  '# Имплантация зубов: полное руководство',
  '',
  '## Введение',
  '',
  'Имплантация — современный метод восстановления утраченных зубов. ' +
    'Титановый винт интегрируется в костную ткань и служит надёжной опорой для коронки.',
  '',
  '## Этапы лечения',
  '',
  '- Консультация и планирование',
  '- Хирургический этап установки импланта',
  '- Ортопедический этап установки коронки',
  '',
  '## Реабилитация',
  '',
  'После операции следует соблюдать рекомендации врача. ' +
    'Процесс приживления занимает от 3 до 6 месяцев.',
  '',
].join('\n');

/** Semantic core of the golden topic — the only keyword source after M2. */
export const GOLDEN_SEMANTIC_CORE = {
  mainQueryRu: 'имплантация зубов',
  queryClustersRu: [
    {
      clusterRu: 'имплантация зубов',
      queriesRu: ['имплантация зубов цена', 'как выбрать имплант для зуба'],
    },
    {
      clusterRu: 'этапы имплантации',
      queriesRu: ['этапы установки импланта зуба', 'сколько длится имплантация зубов'],
    },
  ],
  lsiTermsRu: ['имплантолог', 'остеоинтеграция', 'синус-лифтинг', 'абатмент'],
};

/** Deterministic sentence pool — the body is built from it by index. */
const SENTENCES = [
  'Имплантация зубов начинается с консультации имплантолога и диагностики.',
  'Врач оценивает состояние костной тканей и подбирает подходящий абатмент.',
  'Остеоинтеграция занимает от трёх до шести месяцев при правильном уходе.',
  'Синус-лифтинг нужен, когда объём кости над имплантом недостаточен.',
  'Цена имплантации зубов зависит от производителя импланта и объёма работ.',
  'После установки импланта зуба временная коронка защищает приживление.',
  'Пациент получает письменные рекомендации по гигиене после вмешательства.',
  'Контрольный визит показывает, как прошла остеоинтеграция импланта.',
  'Постоянная коронка изготавливается по цифровому слепу в лаборатории.',
  'Имплантолог подбирает цвет и форму коронки под естественный ряд зубов.',
  'Профилактика снижает риск отторжения импланта в первые годы.',
  'Пациенту объясняют, как пользоваться ирригатором после имплантации.',
  'Этапы установки импланта зуба включают диагностику, операцию и протезирование.',
  'Перед вмешательством сдают базовые анализы и делают снимок челюсти.',
  'Хирург подбирает длину импланта по высоте костной тканей.',
  'Абатмент соединяет винт с коронкой и выравнивает ось нагрузки.',
  'В первые дни после операции назначают щадящую диету и холодные компрессы.',
  'Через несколько месяцев делают контрольный снимок и оценивают кость.',
  'Корона из диоксида циркония выглядит естественно и не вызывает аллергии.',
  'Пациенту подробно объясняют правила ухода за имплантом.',
  'Если имплант подвижен, его удаляют и планируют повторную установку.',
  'Планирование лечения занимает от семи до четырнадцати дней.',
  'Опытный имплантолог показывает пациенту план на консультации.',
  'Стоимость лечения озвучивают после осмотра и расчёта объёма работ.',
];

/**
 * Build one H2 section with deterministic paragraphs.
 * @param {string} title
 * @param {number} index - section index (drives the sentence rotation)
 * @param {number} paragraphs
 * @param {number} sentencesPerParagraph
 */
function buildSection(title, index, paragraphs, sentencesPerParagraph) {
  const lines = [`## ${title}`, ''];
  for (let p = 0; p < paragraphs; p++) {
    const parts = [];
    for (let k = 0; k < sentencesPerParagraph; k++) {
      parts.push(SENTENCES[(index * 7 + p * 5 + k * 3) % SENTENCES.length]);
    }
    lines.push(parts.join(' '), '');
  }
  return lines.join('\n');
}

/** FAQ block: one H2 + eight H3 questions, each with a keyed answer. */
function buildFaq() {
  const questions = [
    'Сколько стоит имплантация зубов под ключ?',
    'Какая разница между синус-лифтингом и имплантацией?',
    'Что такое остеоинтеграция импланта?',
    'Какой врач ведёт имплантацию зубов?',
    'Сколько длится имплантация зубов?',
    'Как выбрать имплант для зуба?',
    'Когда можно ставить постоянную коронку?',
    'Нужно ли менять абатмент после приживления?',
  ];
  const lines = ['## Частые вопросы', ''];
  questions.forEach((q, i) => {
    lines.push(`### ${q}`, '');
    lines.push(
      `Ответ на вопрос ${i + 1}: имплантация зубов проходит под контролем имплантолога, ` +
        'а остеоинтеграция занимает несколько месяцев.',
      '',
    );
  });
  return lines.join('\n');
}

const SECTION_TITLES = [
  'Что такое имплантация зубов',
  'Как проходит консультация имплантолога',
  'Диагностика перед имплантацией зубов',
  'Хирургический этап имплантации',
  'Синус-лифтинг и костная пластика',
  'Выбор абатмента и импланта',
  'Ортопедический этап и коронка',
  'Приживление и реабилитация',
  'Профилактика после имплантации',
  'Частые ошибки пациентов',
];

/** The golden topic body (topic-only article, deterministic). */
export const GOLDEN_TOPIC_BODY = [
  '# Имплантация зубов: полное руководство',
  '',
  'Имплантация зубов — современный метод восстановления утраченных зубов. ' +
    'Титановый винт интегрируется в костную ткань и служит надёжной опорой для коронки. ' +
    'Ниже — полное руководство о том, как проходит имплантация зубов, ' +
    'сколько занимает остеоинтеграция и как выбрать имплант для зуба.',
  '',
  ...SECTION_TITLES.map((title, i) => buildSection(title, i, 4, 4)),
  buildFaq(),
].join('\n');

/**
 * Postcheck context for the golden topic: semantic core only.
 * No wordstat source exists after M2 — the fixture must mirror the pipeline.
 */
export const GOLDEN_CONTEXT = {
  semanticCore: GOLDEN_SEMANTIC_CORE,
  structuredOutputs: {},
  timings: [],
  finalizedVia: 'primary',
};

/** Postcheck context for the generated body (same shape). */
export const GENERATED_CONTEXT = {
  semanticCore: GOLDEN_SEMANTIC_CORE,
  structuredOutputs: {},
  timings: [],
  finalizedVia: 'primary',
};
