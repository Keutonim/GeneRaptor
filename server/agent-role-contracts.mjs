const roleContracts = {
  'topic-selector': {
    nameRu: 'Контракт выбора темы',
    required: ['topicRu', 'angleRu', 'reasonRu', 'duplicateRisksRu', 'targetIntentRu'],
    shape: {
      topicRu: 'Приоритетная тема статьи.',
      angleRu: 'Угол подачи для читателя и SEO.',
      reasonRu: 'Почему эта тема выбрана сейчас.',
      duplicateRisksRu: ['Риски дублей с уже существующими материалами.'],
      targetIntentRu: 'Главный пользовательский интент.',
    },
  },
  'brief-preparer': {
    nameRu: 'Контракт задания на статью',
    required: ['briefRu', 'goalRu', 'toneRu', 'requiredBlocksRu', 'editorialLimitsRu'],
    shape: {
      briefRu: 'Краткое задание на статью.',
      goalRu: 'Цель материала.',
      toneRu: 'Тональность текста.',
      requiredBlocksRu: ['Обязательные блоки статьи.'],
      editorialLimitsRu: ['Редакционные ограничения и запреты.'],
    },
  },
  'knowledge-base-curator': {
    nameRu: 'Контракт базы знаний',
    required: ['verifiedFactsRu', 'authorProfileRu', 'internalLinksRu', 'knowledgeGapsRu'],
    shape: {
      verifiedFactsRu: [{ factRu: 'Факт из проекта.', sourceRu: 'Откуда факт взят внутри контекста.' }],
      authorProfileRu: 'Профиль специалиста или автора.',
      internalLinksRu: [{ anchorRu: 'Анкор.', targetRu: 'Целевая страница.', reasonRu: 'Почему ссылка нужна.' }],
      knowledgeGapsRu: ['Пробелы, которые нельзя заполнять догадками.'],
    },
  },
  'research-analyst': {
    nameRu: 'Контракт исследования',
    required: ['summaryRu', 'competitorThemesRu', 'claimsWithSourcesRu', 'riskFlagsRu', 'knowledgeGapsRu'],
    shape: {
      summaryRu: 'Короткий вывод исследования для статьи.',
      competitorThemesRu: ['Темы и углы конкурентов, если они переданы во входном контексте.'],
      claimsWithSourcesRu: [
        {
          claimRu: 'Тезис, который можно использовать дальше.',
          sourceRu: 'Источник внутри переданного контекста или пометка, что подтверждение отсутствует. Если в user-сообщении есть блок "Внешние источники (evidence-слой)", sourceRu должен ссылаться на реальный sourceUrl/provider из этого блока либо на "карточка услуги" / "не подтверждено".',
          evidenceLevelRu: 'Сильное / среднее / слабое / не подтверждено.',
        },
      ],
      riskFlagsRu: ['Отраслевые, юридические или смысловые риски тезисов.'],
      knowledgeGapsRu: ['Каких данных не хватает для безопасного текста.'],
    },
  },
  'semantic-strategist': {
    nameRu: 'Контракт семантики',
    required: ['mainQueryRu', 'queryClustersRu', 'lsiTermsRu', 'faqIntentsRu'],
    shape: {
      mainQueryRu: 'Основной запрос.',
      queryClustersRu: [{ clusterRu: 'Кластер.', queriesRu: ['Запросы внутри кластера.'] }],
      lsiTermsRu: ['Сопутствующие термины без переспама.'],
      faqIntentsRu: ['Вопросные интенты аудитории.'],
    },
  },
  'structure-architect': {
    nameRu: 'Контракт структуры',
    required: ['h1Ru', 'sectionsRu', 'logicRu', 'internalLinkMapRu'],
    shape: {
      h1Ru: 'H1 статьи.',
      // formatRu — ОПЦИОНАЛЬНОЕ поле секции: 'таблица', если секция сравнивает
      // 2+ сущности (методы/продукты/цены/плюсы-минусы) — article-author
      // оформит её GFM-таблицей. Отсутствие поля = обычный текст (не ломает
      // существующие контракты: поле не входит в required).
      sectionsRu: [{ headingRu: 'Заголовок H2/H3.', purposeRu: 'Зачем нужен блок.', keyPointsRu: ['Что раскрыть.'], formatRu: 'таблица | текст (опционально).' }],
      logicRu: 'Логика раскрытия темы.',
      internalLinkMapRu: [{ anchorRu: 'Анкор.', targetRu: 'Целевая страница.', placementRu: 'Где поставить.' }],
    },
  },
  'article-author': {
    nameRu: 'Контракт авторского черновика',
    required: ['titleRu', 'descriptionRu', 'articleMarkdownRu', 'faqRu', 'claimsForReviewRu', 'riskyPhrasesRu'],
    shape: {
      titleRu: 'SEO title на русском языке.',
      descriptionRu: 'Мета-описание на русском языке.',
      articleMarkdownRu: 'Полный черновик статьи в Markdown на русском языке (с inline-маркерами {{src:N}} для perplexity-логики).',
      faqRu: [{ questionRu: 'Вопрос читателя.', answerRu: 'Короткий безопасный ответ.' }],
      claimsForReviewRu: ['Тезисы, которые должен проверить фактчекер.'],
      riskyPhrasesRu: ['Формулировки, которые могут звучать как обещание результата.'],
      // sourceMapRu — optional (не fail-обязательное) поле: реестр источников
      // для perplexity-логики. Массив объектов { n, provider, sourceUrl, title }.
      // n совпадает с номером в маркерах {{src:n}} внутри articleMarkdownRu.
      // Сохраним как предупреждение (warning), если автор его не вернул, но не заблокируем пайплайн.
      sourceMapRu: [{ n: '1', provider: 'web', sourceUrl: 'https://...', title: 'Заголовок источника.' }],
    },
  },
  factchecker: {
    nameRu: 'Контракт фактчекинга',
    required: ['checkedArticleMarkdownRu', 'correctionsRu', 'forbiddenClaimsRu', 'reviewRequired'],
    shape: {
      checkedArticleMarkdownRu: 'Черновик после фактчекинга.',
      correctionsRu: [{ beforeRu: 'Исходная формулировка.', afterRu: 'Исправленная формулировка.', reasonRu: 'Причина исправления.' }],
      forbiddenClaimsRu: ['Недопустимые или неподтвержденные тезисы.'],
      reviewRequired: true,
      expertReviewerNoteRu: 'Что должен проверить эксперт или редактор.',
    },
  },
  'seo-reviewer': {
    nameRu: 'Контракт SEO-проверки',
    required: ['titleRu', 'descriptionRu', 'slugRu', 'intentScoreRu', 'seoFixesRu', 'internalLinksRu'],
    shape: {
      titleRu: 'Итоговый title.',
      descriptionRu: 'Итоговое description.',
      slugRu: 'Человекочитаемый адрес страницы латиницей или транслитерацией.',
      intentScoreRu: 'Оценка соответствия интенту.',
      seoFixesRu: ['Что улучшить без вреда для профессионального смысла.'],
      internalLinksRu: [{ anchorRu: 'Анкор.', targetRu: 'Куда вести ссылку.', reasonRu: 'Почему ссылка уместна.' }],
      faqSchemaRu: [{ questionRu: 'Вопрос.', answerRu: 'Ответ для схемы FAQ.' }],
    },
  },
  'quality-controller': {
    nameRu: 'Контракт контроля качества',
    required: ['verdictRu', 'criticalIssuesRu', 'finalizationAllowed', 'qualityChecklistRu'],
    shape: {
      verdictRu: 'Вердикт качества.',
      criticalIssuesRu: ['Критичные замечания, если есть.'],
      finalizationAllowed: false,
      qualityChecklistRu: [{ criterionRu: 'Критерий.', statusRu: 'Пройден / требует проверки.', commentRu: 'Комментарий.' }],
    },
  },
  humanizer: {
    nameRu: 'Контракт очеловечивания',
    required: ['finalArticleMarkdownRu', 'styleEditsRu', 'meaningPreserved'],
    shape: {
      finalArticleMarkdownRu: 'Финальная статья после стилистической обработки.',
      styleEditsRu: [{ beforeRu: 'Было.', afterRu: 'Стало.', reasonRu: 'Почему изменено.' }],
      meaningPreserved: true,
      forbiddenChangesRu: ['Что нельзя было менять.'],
    },
  },
};

function normalizeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function summarizeArray(value, fallback) {
  const items = asArray(value)
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        return Object.values(item)
          .map((entry) => normalizeText(entry))
          .filter(Boolean)
          .join(' — ');
      }
      return '';
    })
    .filter(Boolean);
  return items.length ? items.slice(0, 3).join('; ') : fallback;
}

export function getRoleOutputContract(roleId) {
  return roleContracts[roleId] || null;
}

export function buildRoleContractInstruction(roleId) {
  const contract = getRoleOutputContract(roleId);
  if (!contract) {
    return 'Для этой роли строгий структурированный контракт пока не задан. Верни результат на русском языке по ожидаемым выходам роли.';
  }

  return [
    `Для этой роли действует строгий структурированный контракт: ${contract.nameRu}.`,
    'Верни только один валидный JSON-объект без markdown-обертки, комментариев и текста до или после объекта.',
    'Все человекочитаемые значения внутри объекта должны быть на русском языке.',
    'Если данных не хватает, заполни соответствующие массивы пробелов и рисков, а не придумывай факты.',
    'Обязательные поля верхнего уровня:',
    contract.required.map((field) => `- ${field}`).join('\n'),
    'Ожидаемая форма объекта:',
    JSON.stringify(contract.shape, null, 2),
  ].join('\n');
}

export function normalizeStructuredRoleOutput(roleId, parsed, context) {
  const contract = getRoleOutputContract(roleId);
  if (!contract || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      hasContract: Boolean(contract),
      ok: !contract,
      missingFieldsRu: contract ? ['Модель не вернула объект по контракту роли.'] : [],
      summaryRu: contract ? 'Структурированный результат не распознан.' : 'Для роли нет структурированного контракта.',
      data: parsed ?? null,
    };
  }

  const fieldsAllowingEmptyArrays = [
    'competitorThemesRu', 'knowledgeGapsRu', 'duplicateRisksRu',
    'riskFlagsRu', 'editorialLimitsRu', 'requiredBlocksRu',
    'faqRu', 'internalLinksRu', 'internalLinkMapRu',
    'claimsForReviewRu', 'riskyPhrasesRu',
  ];

  const missing = contract.required.filter((field) => {
    const value = parsed[field];
    if (value == null || value === '') return true;
    if (Array.isArray(value) && value.length === 0 && !fieldsAllowingEmptyArrays.includes(field)) return true;
    return false;
  });

  // ── Внешние источники (evidence-слой): мягкая валидация для research-analyst ──
  // Если роли передан context.externalResearch (непустой массив ResearchSource),
  // claimsWithSourcesRu[].sourceRu должен ссылаться на реальный sourceUrl/provider
  // из этого блока, либо явно указывать «карточка услуги» / «не подтверждено».
  // Возвращается как warningsRu (НЕ ломает ok) — это подсказка модели/оператору,
  // а не жёсткий блокер пайплайна.
  const warningsRu = [];
  if (roleId === 'research-analyst' && Array.isArray(context?.externalResearch) && context.externalResearch.length) {
    const allowedSources = collectExternalResearchReferences(context.externalResearch);
    const claims = Array.isArray(parsed.claimsWithSourcesRu) ? parsed.claimsWithSourcesRu : [];
    const unverifiedClaims = claims.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const source = normalizeText(entry.sourceRu);
      if (!source) return true;
      // «не подтверждено» / «карточка ...» — допустимые пометки, не flagged.
      if (/не подтверждено|карточк/iu.test(source)) return false;
      // Иначе sourceRu должен содержать реальный sourceUrl или provider из блока.
      return !allowedSources.some((ref) => source.includes(ref));
    });
    if (unverifiedClaims.length) {
      warningsRu.push(
        `claimsWithSourcesRu: ${unverifiedClaims.length} тезис(ов) имеют sourceRu, не ссылающийся на реальный sourceUrl/provider из блока внешних источников (ожидаются ссылки на: ${allowedSources.join(', ') || '—'}).`
      );
    }
  }

  // ── Perplexity-логика (ADDENDUM 2026-07-10): sourceMapRu для article-author ──
  // Поле optional — не fail-обязательное. Если автор НЕ вернул реестр sourceMapRu
  // (массив объектов { n, provider, sourceUrl, title }), это предупреждение, а не
  // блокер: фактчекер всё равно проверит маркеры {{src:N}} в тексте, а strip снимет
  // их. Но без реестра аудит-след source→тезис обеднеет.
  if (roleId === 'article-author') {
    const sourceMap = parsed.sourceMapRu;
    if (sourceMap == null || (Array.isArray(sourceMap) && sourceMap.length === 0)) {
      warningsRu.push(
        'sourceMapRu: автор не вернул реестр источников (массив { n, provider, sourceUrl, title }). Перплексити-логика работает (маркеры {{src:N}} в тексте), но аудит-след источник→тезис будет неполным.'
      );
    } else if (!Array.isArray(sourceMap)) {
      warningsRu.push('sourceMapRu: ожидался массив объектов реестра, получен другой тип.');
    }
  }

  return {
    hasContract: true,
    ok: missing.length === 0,
    missingFieldsRu: missing.map((field) => `Не заполнено поле «${field}».`),
    warningsRu,
    summaryRu: summarizeStructuredRoleOutput(roleId, parsed),
    data: parsed,
  };
}

/**
 * Собирает множество строк-«отпечатков» внешних источников, на которые
 * research-analyst вправе ссылаться в sourceRu: sourceUrl, provider и
 * нормализованное «внешний источник [provider]». Используется мягкой
 * валидацией — содержит ли sourceRu хотя бы один из отпечатков.
 */
function collectExternalResearchReferences(externalResearch) {
  const refs = new Set();
  for (const item of externalResearch) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeText(item.sourceUrl);
    const provider = normalizeText(item.provider);
    if (url) refs.add(url);
    if (provider) {
      refs.add(provider);
      refs.add(`внешний источник [${provider}]`);
    }
  }
  return Array.from(refs);
}

export function summarizeStructuredRoleOutput(roleId, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return 'Структурированный результат не распознан.';
  }

  if (roleId === 'research-analyst') {
    return [
      `Вывод: ${normalizeText(parsed.summaryRu, 'не указан')}`,
      `Тезисы: ${summarizeArray(parsed.claimsWithSourcesRu, 'не указаны')}`,
      `Риски: ${summarizeArray(parsed.riskFlagsRu, 'не указаны')}`,
    ].join(' · ');
  }

  if (roleId === 'article-author') {
    return [
      `Заголовок: ${normalizeText(parsed.titleRu, 'не указан')}`,
      `Описание: ${normalizeText(parsed.descriptionRu, 'не указано')}`,
      `Проверить: ${summarizeArray(parsed.claimsForReviewRu, 'нет отдельных тезисов')}`,
    ].join(' · ');
  }

  if (roleId === 'factchecker') {
    return [
      `Исправления: ${summarizeArray(parsed.correctionsRu, 'нет')}`,
      `Недопустимые тезисы: ${summarizeArray(parsed.forbiddenClaimsRu, 'нет')}`,
      parsed.reviewRequired ? 'Нужна экспертная проверка' : 'Экспертная проверка не запрошена',
    ].join(' · ');
  }

  if (roleId === 'seo-reviewer') {
    return [
      `Заголовок: ${normalizeText(parsed.titleRu, 'не указан')}`,
      `Адрес: ${normalizeText(parsed.slugRu, 'не указан')}`,
      `SEO-правки: ${summarizeArray(parsed.seoFixesRu, 'нет')}`,
    ].join(' · ');
  }

  const contract = getRoleOutputContract(roleId);
  if (contract) {
    const firstFields = contract.required
      .slice(0, 3)
      .map((field) => {
        const value = parsed[field];
        return `${field}: ${Array.isArray(value) ? summarizeArray(value, 'не указано') : normalizeText(value, 'не указано')}`;
      })
      .join(' · ');
    return `${contract.nameRu}: ${firstFields}`;
  }

  return 'Структурированный результат сохранен.';
}
