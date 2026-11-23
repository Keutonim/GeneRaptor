/**
 * Canned structured outputs for each of the 11 agent roles.
 *
 * Each object satisfies the `required` fields defined in
 * server/agent-role-contracts.mjs so that `normalizeStructuredRoleOutput`
 * marks the role as `ok: true`.
 *
 * `callRouterAI` mock wraps these into an OpenAI-shaped response:
 *   { status: 200, data: { choices: [{ message: { content: JSON.stringify(output) } }], usage: {...} } }
 */

const ARTICLE_MARKDOWN = [
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

export const roleOutputs = {
  'topic-selector': {
    topicRu: 'Имплантация зубов под ключ',
    angleRu: 'Пошаговое руководство для пациента',
    reasonRu: 'Высокий спрос и частые вопросы пациентов',
    duplicateRisksRu: ['Дубликатов с существующими статьями не обнаружено'],
    targetIntentRu: 'Узнать этапы и стоимость имплантации',
  },

  'brief-preparer': {
    briefRu: 'Подробная статья об имплантации зубов для пациентов',
    goalRu: 'Информировать и снять страхи пациента перед процедурой',
    toneRu: 'Доверительный и профессиональный',
    requiredBlocksRu: ['Введение', 'Этапы', 'Стоимость', 'Реабилитация'],
    editorialLimitsRu: ['Не давать медицинских гарантий'],
  },

  'knowledge-base-curator': {
    verifiedFactsRu: [
      { factRu: 'Импланты приживаются в 97% случаев.', sourceRu: 'Внутренняя статистика компании.' },
    ],
    authorProfileRu: 'Врач-имплантолог с 15-летним стажем',
    internalLinksRu: [
      { anchorRu: 'наши услуги', targetRu: '/services', reasonRu: 'Навигация к услугам.' },
    ],
    knowledgeGapsRu: ['Нет свежих фото до/после'],
  },

  'research-analyst': {
    summaryRu: 'Рынок имплантации растёт, пациенты ищут прозрачные цены.',
    competitorThemesRu: ['Конкуренты пишут про боль при имплантации'],
    claimsWithSourcesRu: [
      { claimRu: 'Имплантация безболезненна', strengthRu: 'среднее', sourceRu: 'Отзывы пациентов.' },
    ],
    riskFlagsRu: ['Не обещать 100% приживление'],
    knowledgeGapsRu: ['Нет данных по долгосрочным результатам'],
  },

  'semantic-strategist': {
    // Dev-D (2026-08-25, фикстура от Dev-A): mainQueryRu выровнен под H1-фикс
    // («чистка лица» НЕ входит в H1 фикстуры «Имплантация зубов…» → волна 3
    // проверяет срабатывание ensureH1WithMainQuery на chunk-dedupe-прогоне).
    mainQueryRu: 'чистка лица',
    queryClustersRu: [
      { clusterRu: 'Стоимость', queriesRu: ['цена имплантации', 'сколько стоит имплант'] },
    ],
    lsiTermsRu: ['титановый винт', 'костная интеграция', 'абатмент'],
    faqIntentsRu: ['Больно ли ставить имплант?', 'Сколько служит имплант?'],
  },

  'structure-architect': {
    h1Ru: 'Имплантация зубов: полное руководство',
    sectionsRu: [
      {
        headingRu: 'Введение',
        purposeRu: 'Объяснить, что такое имплантация',
        keyPointsRu: ['Определение', 'Преимущества'],
      },
      {
        headingRu: 'Этапы лечения',
        purposeRu: 'Описать процесс',
        keyPointsRu: ['Консультация', 'Хирургия', 'Коронка'],
      },
    ],
    logicRu: 'От простого к сложному, завершая реабилитацией',
    internalLinkMapRu: [
      { anchorRu: 'услуги', targetRu: '/services', placementRu: 'В блоке стоимости' },
    ],
  },

  'article-author': {
    titleRu: 'Имплантация зубов: полное руководство 2026',
    descriptionRu: 'Всё об имплантации: этапы, сроки, стоимость. Гид для пациента.',
    articleMarkdownRu: ARTICLE_MARKDOWN,
    faqRu: [{ questionRu: 'Больно ли ставить имплант?', answerRu: 'Процедура проходит под анестезией.' }],
    claimsForReviewRu: ['Импланты приживаются в 97% случаев'],
    riskyPhrasesRu: [],
  },

  factchecker: {
    checkedArticleMarkdownRu: ARTICLE_MARKDOWN,
    correctionsRu: [
      { beforeRu: '97% случаев', afterRu: 'до 97% случаев', reasonRu: 'Уточнение формулировки.' },
    ],
    forbiddenClaimsRu: [],
    reviewRequired: false,
    expertReviewerNoteRu: 'Спорных профессиональных утверждений не обнаружено.',
  },

  'seo-reviewer': {
    titleRu: 'Имплантация зубов — гид 2026',
    descriptionRu: 'Этапы, стоимость и сроки имплантации. Полный гид для пациента.',
    slugRu: 'implantaciya-zubov',
    intentScoreRu: 'Высокое соответствие интенту',
    seoFixesRu: ['Добавить больше LSI-терминов'],
    internalLinksRu: [{ anchorRu: 'услуги', targetRu: '/services', reasonRu: 'Внутренняя перелинковка.' }],
  },

  'quality-controller': {
    verdictRu: 'Статья готова к публикации',
    criticalIssuesRu: [],
    finalizationAllowed: true,
    qualityChecklistRu: [
      { criterionRu: 'Медицинская точность', statusRu: 'Пройден', commentRu: 'Без спорных тезисов.' },
    ],
  },

  humanizer: {
    finalArticleMarkdownRu: ARTICLE_MARKDOWN,
    styleEditsRu: [{ beforeRu: 'стало', afterRu: 'стало естественнее', reasonRu: 'Смягчение тона.' }],
    meaningPreserved: true,
    forbiddenChangesRu: ['Не менять медицинские термины'],
  },
};

/**
 * All 11 role ids in pipeline order (matches agentRoleData).
 * M2: the publishing roles (platform-adapter, publisher) are stripped.
 */
export const ALL_ROLE_IDS = [
  'topic-selector',
  'brief-preparer',
  'knowledge-base-curator',
  'research-analyst',
  'semantic-strategist',
  'structure-architect',
  'article-author',
  'factchecker',
  'seo-reviewer',
  'quality-controller',
  'humanizer',
];
