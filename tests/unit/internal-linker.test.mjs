import { describe, it, expect, vi } from 'vitest';
import { injectInternalLinks, __test__ } from '../../server/lib/internal-linker.mjs';

/**
 * W3 (2026-08-22): internal-linker — три приоритета ссылок
 * на домен сайта (норматив seo-requirements, раздел 2):
 *   1) каноническая ссылка на страницу услуги (первые 1200 симв., fallback на
 *      первый упомянутый сервис каталога в зоне, иначе честный skip+лог);
 *   2) сайт → главная (первое упоминание siteName, ровно один раз);
 *   3) каталог — прежний name-matching (first-occurrence, длинные имена
 *      приоритетнее) на остаток общего бюджета maxLinks.
 * Плюс no-link зоны (FAQ-секции, подпись автора) и метаданные для постчека.
 * Регресс базового name-matching покрыта отдельным describe (тест-файла раньше
 * не существовало — либа жила только интеграцией article-tail-smoke).
 */

const BASE = 'https://company.example';
const EPIL_URL = `${BASE}/uslugi/lazernaya-epilyaciya`;

const BODY = [
  '# Лазерная эпиляция: полное руководство',
  'Лазерная эпиляция — популярный метод удаления волос. В компании Пример работа выполняется на современном оборудовании.',
  '## Как проходит процедура',
  'Сеанс занимает от 15 минут до часа: мастер подбирает параметры индивидуально.',
  '## Заключение',
  'Курсовой подход даёт устойчивый результат.',
].join('\n\n');

const CANON_OPTS = {
  canonicalServiceUrl: EPIL_URL,
  canonicalServiceName: 'Лазерная эпиляция',
};
const SITE_OPTS = {
  sourceSiteBaseUrl: `${BASE}/`,
  siteName: 'Пример',
};

/** Абзац-заполнитель длиной >1200 симв. (чтобы целевое имя оказалось «вне зоны»). */
function filler(targetWord) {
  const sentence = 'Длинный вводный абзац с подробным описанием темы и контекста процедуры.';
  const paragraph = Array.from({ length: 26 }, () => sentence).join(' ');
  return paragraph + ` Только здесь впервые упомянута ${targetWord}.`;
}

describe('internal-linker — регресс базового name-matching (каталог)', () => {
  it('первое вхождение услуги в теле → markdown-ссылка; анкор = исходный регистр текста', () => {
    const catalog = { services: [{ name: 'Мезотерапия', url: `${BASE}/uslugi/mezoterapiya` }] };
    const md = '## Заголовок секции\n\nПациентам проводится мезотерапия по показаниям. Мезотерапия повторяется.';
    const out = injectInternalLinks(md, catalog);
    expect(out).toBe(
      '## Заголовок секции\n\nПациентам проводится [мезотерапия](' + `${BASE}/uslugi/mezoterapiya` + ') по показаниям. Мезотерапия повторяется.'
    );
  });

  it('длинное имя приоритетнее короткого (Ultraformer MPT vs Ultraformer)', () => {
    const catalog = {
      services: [
        { name: 'Ultraformer', url: `${BASE}/a` },
        { name: 'Ultraformer MPT', url: `${BASE}/b` },
      ],
    };
    const out = injectInternalLinks('Оборудование Ultraformer MPT установлено в компании.', catalog);
    expect(out).toContain('[Ultraformer MPT](' + `${BASE}/b` + ')');
    expect(out).not.toContain(`[Ultraformer](${BASE}/a)`);
  });

  it('word-boundary: имя внутри другого слова НЕ матчится (кириллица/латиница)', () => {
    const catalog = { services: [{ name: 'Ботокс', url: `${BASE}/botox` }] };
    expect(injectInternalLinks('Ботоксный токсин и неБотокс', catalog)).toBe('Ботоксный токсин и неБотокс');
  });

  it('защищённые контексты: заголовок, ячейка таблицы, inline-code, готовая ссылка', () => {
    const catalog = { services: [{ name: 'Мезотерапия', url: `${BASE}/m` }] };
    expect(injectInternalLinks('## Мезотерапия в деталях', catalog)).not.toContain(`](${BASE}/m`);
    expect(injectInternalLinks('| Процедура | Цена |\n|---|---|\n| Мезотерапия | 5000 |', catalog)).not.toContain(`](${BASE}/m`);
    expect(injectInternalLinks('Команда `Мезотерапия` в коде', catalog)).not.toContain(`](${BASE}/m`);
    // Уже обёрнутая ссылка не обёртывается вторично (нет «[[Мезотерапия](…)](…)»).
    const linked = injectInternalLinks(`См. [Мезотерапия](${BASE}/old) здесь`, catalog);
    expect(linked).not.toContain(`](${BASE}/m)`);
    expect(linked).not.toMatch(/\[\[Мезотерапия\]/);
  });

  it('имя короче 4 символов каталога не линкуется', () => {
    const catalog = { services: [{ name: 'УЗИ', url: `${BASE}/uzi` }] };
    expect(injectInternalLinks('УЗИ делают утром.', catalog)).toBe('УЗИ делают утром.');
  });

  it('maxLinks ограничивает каталог; дефолт прежний (8)', () => {
    expect(__test__.DEFAULT_MAX_LINKS).toBe(8);
    const services = ['Гинекология', 'Дерматология', 'Трихология', 'Урология'].map((n) => ({
      name: n,
      url: `${BASE}/${n.toLowerCase()}`,
    }));
    const md = services.map((s) => `Упоминаем ${s.name} в тексте.`).join(' ');
    const out = injectInternalLinks(md, { services }, { maxLinks: 2, returnAudit: true });
    expect(out.linksAdded.catalog).toBe(2);
    expect((out.markdown.match(/\]\(https:\/\/company\.example\//g) || []).length).toBe(2);
  });

  it('дедуп по URL: два имени с одним URL → одна ссылка', () => {
    const catalog = {
      services: [
        { name: 'Мезотерапия лица', url: `${BASE}/m` },
        { name: 'Мезотерапия', url: `${BASE}/m` },
      ],
    };
    const out = injectInternalLinks('Мезотерапия лица и мезотерапия тела.', catalog, { returnAudit: true });
    expect((out.markdown.match(new RegExp(`\\]\\(${BASE}/m\\)`, 'g')) || []).length).toBe(1);
  });

  it('без совпадений и без мусорных входов — текст не меняется', () => {
    const catalog = { services: [{ name: 'Мезотерапия', url: `${BASE}/m` }] };
    expect(injectInternalLinks('Другой текст без услуг.', catalog)).toBe('Другой текст без услуг.');
    expect(injectInternalLinks('', catalog)).toBe('');
    expect(injectInternalLinks(null, catalog)).toBe(null);
    expect(injectInternalLinks('Текст', null)).toBe('Текст');
    const out = injectInternalLinks('Текст', { services: [] }, { returnAudit: true });
    expect(out.markdown).toBe('Текст');
    expect(out.injected).toEqual([]);
  });

  it('returnAudit:false → строка (обратная совместимость)', () => {
    const catalog = { services: [{ name: 'Мезотерапия', url: `${BASE}/m` }] };
    expect(typeof injectInternalLinks('Проводится мезотерапия.', catalog)).toBe('string');
  });
});

describe('internal-linker — каноническая ссылка на услугу (W3, норматив 2.2)', () => {
  it('канон в зоне: первое вхождение названия в первых 1200 симв. → [name](canonicalUrl)', () => {
    const out = injectInternalLinks(BODY, { services: [] }, { ...CANON_OPTS, returnAudit: true });
    // H1 содержит название, но заголовок — защищённый контекст: линкуется тело.
    expect(out.markdown).toContain(`[Лазерная эпиляция](${EPIL_URL})`);
    expect(out.linksAdded.canonical).toBe(1);
    expect(out.canonicalServiceUrl).toBe(EPIL_URL);
    expect(out.injected[0]).toMatchObject({ kind: 'canonical', url: EPIL_URL });
  });

  it('канон в зоне при живом каталоге: ссылка одна (URL-дедуп), каталог не дублирует', () => {
    const catalog = { services: [{ name: 'Лазерная эпиляция', url: EPIL_URL }] };
    const out = injectInternalLinks(BODY, catalog, { ...CANON_OPTS, returnAudit: true });
    expect((out.markdown.match(new RegExp(`\\]\\(${EPIL_URL}\\)`, 'g')) || []).length).toBe(1);
    expect(out.linksAdded).toEqual({ canonical: 1, siteMain: 0, catalog: 0 });
  });

  it('канон вне зоны: название впервые после 1200 симв. → canonical не ставится', () => {
    const md = [
      '# Другая тема статьи',
      filler('лазерная эпиляция'), // >1200 симв. до первого вхождения
      '## Заключение',
      'Итог.',
    ].join('\n\n');
    const out = injectInternalLinks(md, { services: [] }, { ...CANON_OPTS, returnAudit: true });
    expect(out.linksAdded.canonical).toBe(0);
    expect(out.markdown).not.toContain(`](${EPIL_URL})`);
    // Ожидаемый канон-URL всё равно возвращается постчек-контексту (честный warn).
    expect(out.canonicalServiceUrl).toBe(EPIL_URL);
  });

  it('fallback: имени канона нет в зоне, но упомянут сервис каталога → ссылка на ЕГО url', () => {
    const md = [
      '# Уход за кожей',
      'Комплексный уход: мезотерапия и чистка лица.',
      '## Заключение',
      'Итог.',
    ].join('\n\n');
    const catalog = { services: [{ name: 'мезотерапия', url: `${BASE}/m` }] };
    const out = injectInternalLinks(md, catalog, { ...CANON_OPTS, returnAudit: true });
    expect(out.linksAdded.canonical).toBe(0);
    expect(out.linksAdded.catalog).toBe(1);
    expect(out.markdown).toContain(`[мезотерапия](${BASE}/m)`);
  });

  it('fallback с URL канона в каталоге засчитывается каноном', () => {
    const md = [
      '# Уход за кожей',
      'Популярность лазерной эпиляции бикини растёт второй год подряд.',
      '## Заключение',
      'Итог.',
    ].join('\n\n');
    // Имени канона («Лазерная эпиляция») в тексте НЕТ — косвенный падеж; в
    // каталоге сервис с тем же URL под другой (падежной) формой названия.
    const catalog = { services: [{ name: 'лазерной эпиляции бикини', url: EPIL_URL }] };
    const out = injectInternalLinks(md, catalog, { ...CANON_OPTS, returnAudit: true });
    expect(out.linksAdded.canonical).toBe(1);
    expect(out.markdown).toContain(`[лазерной эпиляции бикини](${EPIL_URL})`);
  });

  it('нет вхождения: ни имя канона, ни сервисы каталога в зоне → честный skip+лог', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const md = [
        '# Уход за кожей',
        'Общий текст без названий процедур в начале статьи.',
        '## Заключение',
        'Итог.',
      ].join('\n\n');
      const out = injectInternalLinks(md, { services: [] }, { ...CANON_OPTS, returnAudit: true });
      expect(out.linksAdded).toEqual({ canonical: 0, siteMain: 0, catalog: 0 });
      expect(out.markdown).not.toContain('](');
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/canonical skip/u));
    } finally {
      log.mockRestore();
    }
  });

  it('URL канона без схемы нормализуется в https://', () => {
    const out = injectInternalLinks(BODY, { services: [] }, {
      canonicalServiceUrl: 'company.example/uslugi/lazernaya-epilyaciya',
      canonicalServiceName: 'Лазерная эпиляция',
      returnAudit: true,
    });
    expect(out.markdown).toContain(`[Лазерная эпиляция](https://company.example/uslugi/lazernaya-epilyaciya)`);
  });

  it('мусорные канон-опции пропускаются молча (старое поведение)', () => {
    const out = injectInternalLinks(BODY, { services: [] }, {
      canonicalServiceUrl: '   ',
      canonicalServiceName: '',
      returnAudit: true,
    });
    expect(out.linksAdded.canonical).toBe(0);
    expect(out.markdown).toBe(BODY);
  });
});

describe('internal-linker — сайт → главная (W3, норматив 2.4)', () => {
  it('первое упоминание siteName → [name](baseUrl), ровно один раз', () => {
    const md = BODY + '\n\nВо втором абзаце Пример упоминается снова.';
    const out = injectInternalLinks(md, { services: [] }, { ...SITE_OPTS, returnAudit: true });
    expect((out.markdown.match(new RegExp(`\\[Пример\\]\\(${BASE}/\\)`, 'g')) || []).length).toBe(1);
    expect(out.linksAdded.siteMain).toBe(1);
    expect(out.injected[0]).toMatchObject({ kind: 'site-home', url: `${BASE}/` });
  });

  it('компания упомянута только в H1/H2-заголовке — ссылка не ставится в заголовок', () => {
    const md = '# Пример: компания\n\nОбщий текст без упоминания бренда в теле.';
    const out = injectInternalLinks(md, { services: [] }, { ...SITE_OPTS, returnAudit: true });
    expect(out.linksAdded.siteMain).toBe(0);
  });

  it('нет упоминания компании → честный skip+лог, siteMain=0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = injectInternalLinks('# Тема\n\nТекст без бренда.', { services: [] }, { ...SITE_OPTS, returnAudit: true });
      expect(out.linksAdded.siteMain).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/site-home skip/u));
    } finally {
      log.mockRestore();
    }
  });

  it('opts.siteName — единственный вход имени компании для прохода «сайт → главная»', () => {
    // Нейтральный контракт: имя компании приходит только под ключом siteName.
    const named = injectInternalLinks(BODY, { services: [] }, {
      ...SITE_OPTS,
      siteName: 'Пример',
      returnAudit: true,
    });
    expect(named.linksAdded.siteMain).toBe(1);
    expect(named.injected[0]).toMatchObject({ kind: 'site-home', url: `${BASE}/` });

    const unnamed = injectInternalLinks(BODY, { services: [] }, {
      ...SITE_OPTS,
      siteName: undefined,
      returnAudit: true,
    });
    expect(unnamed.linksAdded.siteMain).toBe(0);
  });

  it('аудит linksAdded несёт только нейтральные ключи — без скрытых алиасов', () => {
    const out = injectInternalLinks(BODY, { services: [] }, { ...SITE_OPTS, returnAudit: true });
    expect(out.linksAdded.siteMain).toBe(1);
    // В JSON уходит только нейтральная форма, и скрытых (неперечисляемых)
    // алиасов у счётчиков нет — аудит сериализуется как есть.
    expect(Object.keys(out.linksAdded)).toEqual(['canonical', 'siteMain', 'catalog']);
    expect(Object.getOwnPropertyNames(out.linksAdded)).toEqual(['canonical', 'siteMain', 'catalog']);
  });

  it('без baseUrl или без siteName — проход отключён (дефолт-поведение воркера)', () => {
    const noUrl = injectInternalLinks(BODY, { services: [] }, { siteName: 'Пример', returnAudit: true });
    expect(noUrl.linksAdded.siteMain).toBe(0);
    const noName = injectInternalLinks(BODY, { services: [] }, { sourceSiteBaseUrl: BASE, returnAudit: true });
    expect(noName.linksAdded.siteMain).toBe(0);
  });
});

describe('internal-linker — no-link зоны: FAQ и подпись (норматив 2.1)', () => {
  it('упоминание ТОЛЬКО внутри FAQ-секции не линкуется', () => {
    const md = [
      '# Тема статьи',
      'Общий текст без услуг.',
      '## 10 необычных вопросов: Тема статьи',
      '### Больно ли делать мезотерапию?',
      'Нет: мезотерапия выполняется с анестезией.',
    ].join('\n\n');
    const catalog = { services: [{ name: 'мезотерапия', url: `${BASE}/m` }] };
    const out = injectInternalLinks(md, catalog, { returnAudit: true });
    expect(out.markdown).not.toContain(`](${BASE}/m`);
    expect(out.injected).toEqual([]);
  });

  it('«Часто задаваемые вопросы» — тоже FAQ-зона; вхождение до зоны линкуется, внутри — нет', () => {
    const md = [
      '# Тема статьи',
      'Мезотерапия упоминается в теле статьи.',
      '## Часто задаваемые вопросы (FAQ)',
      '### Вопрос',
      'Ответ, где снова идёт мезотерапия.',
    ].join('\n\n');
    const catalog = { services: [{ name: 'мезотерапия', url: `${BASE}/m` }] };
    const out = injectInternalLinks(md, catalog, { returnAudit: true });
    expect((out.markdown.match(new RegExp(`\\]\\(${BASE}/m\\)`, 'g')) || []).length).toBe(1);
    expect(out.markdown.indexOf(`](${BASE}/m)`)).toBeLessThan(out.markdown.indexOf('## Часто задаваемые'));
  });

  it('FAQ-зона защищает и ссылку сайт→главная', () => {
    const md = [
      '# Тема',
      'Текст без бренда в теле.',
      '## 10 необычных вопросов: Тема',
      'Ответ: в Пример процедура доступна.',
    ].join('\n\n');
    const out = injectInternalLinks(md, { services: [] }, { ...SITE_OPTS, returnAudit: true });
    expect(out.linksAdded.siteMain).toBe(0);
  });

  it('подпись «Автор статьи:» — тоже no-link зона', () => {
    const md = [
      '# Тема',
      'Мезотерапия в теле статьи.',
      '---',
      '**Автор статьи:** Иванов, специалист по мезотерапии лица',
    ].join('\n\n');
    const catalog = { services: [{ name: 'мезотерапия', url: `${BASE}/m` }] };
    const out = injectInternalLinks(md, catalog, { returnAudit: true });
    expect((out.markdown.match(new RegExp(`\\]\\(${BASE}/m\\)`, 'g')) || []).length).toBe(1);
    expect(out.markdown.indexOf(`](${BASE}/m)`)).toBeLessThan(out.markdown.indexOf('**Автор статьи:**'));
  });

  it('заголовок FAQ внутри code-fence НЕ открывает зону (ложных зон нет)', () => {
    const md = [
      '# Тема',
      '```\n## 10 необычных вопросов: Тема\n```',
      'Мезотерапия после фенса линкуется.',
    ].join('\n\n');
    const catalog = { services: [{ name: 'мезотерапия', url: `${BASE}/m` }] };
    const out = injectInternalLinks(md, catalog, { returnAudit: true });
    expect(out.markdown).toContain(`[Мезотерапия](${BASE}/m)`);
  });
});

describe('internal-linker — no-link зона секции возражений (P2-2, §1.6)', () => {
  const OBJ_CATALOG = { services: [{ name: 'мезотерапия', url: `${BASE}/m` }] };

  /** Статья с секцией возражений в середине: до / внутри / после. */
  const OBJ_MD = [
    '# Тема статьи',
    'Введение: мезотерапия упоминается до возражений.',
    '## Возражения и сомнения пациентов',
    '### Больно ли делать мезотерапию?',
    'Нет: мезотерапия выполняется с анестезией, дискомфорт минимален.',
    '### Поможет ли мезотерапия навсегда?',
    'Врач не может гарантировать результат — итог зависит от показаний.',
    '## Уход после процедуры',
    'После процедуры уход простой, мезотерапия повторяется курсом.',
  ].join('\n\n');

  it('упоминание ВНУТРИ секции возражений не линкуется (услуга из зоны — без ссылки)', () => {
    // два РАЗНЫХ сервиса: один упомянут только внутри зоны (не линкуется),
    // другой — до зоны (линкуется): URL-дедуп не маскирует защиту зоны.
    const catalog = {
      services: [
        { name: 'мезотерапия', url: `${BASE}/m` },
        { name: 'пилинг', url: `${BASE}/p` },
      ],
    };
    const md = [
      '# Тема статьи',
      'Введение: пилинг упоминается до возражений.',
      '## Возражения и сомнения пациентов',
      '### Больно ли делать мезотерапию?',
      'Нет: мезотерапия выполняется с анестезией, дискомфорт минимален.',
      '## Уход после процедуры',
      'Уход простой.',
    ].join('\n\n');
    const out = injectInternalLinks(md, catalog, { returnAudit: true });
    const objStart = out.markdown.indexOf('## Возражения');
    const objEnd = out.markdown.indexOf('## Уход после процедуры');
    expect(out.markdown.slice(objStart)).not.toContain(`](${BASE}/m`);
    expect(out.markdown).toContain(`[пилинг](${BASE}/p)`);
  });

  it('упоминания ДО и ПОСЛЕ секции возражений линкуются (зона — сама секция, не хвост)', () => {
    const out = injectInternalLinks(OBJ_MD, OBJ_CATALOG, { returnAudit: true });
    // first-occurrence-only: линкуется ПЕРВОЕ упоминание (до зоны) —
    // но внутри и после зоны упоминания не должны получить ВТОРУЮ ссылку
    // (usedUrls-дедуп). Проверяем стабильнее: отдельный документ, где
    // упоминание есть только ПОСЛЕ зоны.
    const afterOnly = OBJ_MD.replace('Введение: мезотерапия упоминается до возражений.', 'Введение без услуг.');
    const out2 = injectInternalLinks(afterOnly, OBJ_CATALOG, { returnAudit: true });
    expect(out2.markdown).toContain(`[мезотерапия](${BASE}/m)`);
    expect(out2.injected[0].position).toBeGreaterThan(out2.markdown.indexOf('## Уход после процедуры'));
  });

  it('заголовок по корню «миф» тоже открывает зону', () => {
    const md = [
      '# Тема',
      'Введение без услуг.',
      '## Мифы о процедуре',
      'Мезотерапия вокруг мифов — не линкуем.',
      '## Уход',
      'Мезотерапия в следующей секции линкуется.',
    ].join('\n\n');
    const out = injectInternalLinks(md, OBJ_CATALOG, { returnAudit: true });
    const mythStart = out.markdown.indexOf('## Мифы о процедуре');
    const mythEnd = out.markdown.indexOf('## Уход');
    expect(out.markdown.slice(mythStart, mythEnd)).not.toContain(`](${BASE}/m`);
    expect(out.markdown.slice(mythEnd)).toContain(`[Мезотерапия](${BASE}/m)`);
  });

  it('H3-«миф» вне H2-секции возражений зону НЕ открывает (зона — только H2)', () => {
    const md = [
      '# Тема',
      'Введение без услуг.',
      '## Уход',
      '### Миф: мезотерапия опасна?',
      'Разбор — мезотерапия здесь линкуется.',
    ].join('\n\n');
    const out = injectInternalLinks(md, OBJ_CATALOG, { returnAudit: true });
    expect(out.markdown).toContain(`[мезотерапия](${BASE}/m)`);
  });

  it('заголовок возражений внутри code-fence зону НЕ открывает', () => {
    const md = [
      '# Тема',
      '```\n## Возражения пациентов\n```',
      'Мезотерапия после фенса линкуется.',
    ].join('\n\n');
    const out = injectInternalLinks(md, OBJ_CATALOG, { returnAudit: true });
    expect(out.markdown).toContain(`[Мезотерапия](${BASE}/m)`);
  });

  it('возражения + FAQ: обе зоны действуют одновременно', () => {
    const md = [
      '# Тема',
      'Введение без услуг.',
      '## Возражения пациентов',
      'Мезотерапия внутри возражений.',
      '## Уход',
      'Мезотерапия линкуется здесь.',
      '## 10 необычных вопросов: Тема',
      'Мезотерапия в FAQ — тоже нет.',
    ].join('\n\n');
    const out = injectInternalLinks(md, OBJ_CATALOG, { returnAudit: true });
    expect((out.markdown.match(new RegExp(`\\]\\(${BASE}/m\\)`, 'g')) || []).length).toBe(1);
    expect(out.markdown.indexOf(`](${BASE}/m)`)).toBeGreaterThan(out.markdown.indexOf('## Уход'));
    expect(out.markdown.indexOf(`](${BASE}/m)`)).toBeLessThan(out.markdown.indexOf('## 10 необычных'));
  });
});

describe('internal-linker — общий бюджет и приоритеты (норматив 2.1)', () => {
  it('канон и ссылка на главную считают в общий бюджет maxLinks; maxLinks=1 → только канон', () => {
    const out = injectInternalLinks(BODY, { services: [] }, {
      ...CANON_OPTS,
      ...SITE_OPTS,
      maxLinks: 1,
      returnAudit: true,
    });
    expect(out.linksAdded).toEqual({ canonical: 1, siteMain: 0, catalog: 0 });
    expect(out.markdown).not.toContain(`[Пример](`);
  });

  it('maxLinks=2 → канон + главная; каталогу бюджета не остаётся', () => {
    const catalog = { services: [{ name: 'Лазерная эпиляция', url: EPIL_URL }] };
    const out = injectInternalLinks(BODY + '\n\nПример снова в тексте.', catalog, {
      ...CANON_OPTS,
      ...SITE_OPTS,
      maxLinks: 2,
      returnAudit: true,
    });
    expect(out.linksAdded).toEqual({ canonical: 1, siteMain: 1, catalog: 0 });
  });

  it('полный прогон: канон + главная + каталог в мета-объекте (контракт постчека)', () => {
    const out = injectInternalLinks(BODY, { services: [] }, {
      ...CANON_OPTS,
      ...SITE_OPTS,
      returnAudit: true,
    });
    expect(out).toHaveProperty('markdown', out.linkedContent);
    expect(out.linksAdded).toEqual({ canonical: 1, siteMain: 1, catalog: 0 });
    expect(out.canonicalServiceUrl).toBe(EPIL_URL);
    expect(out.markdown).toContain(`[Лазерная эпиляция](${EPIL_URL})`);
    expect(out.markdown).toContain(`[Пример](${BASE}/)`);
  });

  it('maxLinks=0 → ссылок нет, канон-URL всё равно возвращается в мета', () => {
    const out = injectInternalLinks(BODY, { services: [] }, { ...CANON_OPTS, maxLinks: 0, returnAudit: true });
    expect(out.markdown).toBe(BODY);
    expect(out.linksAdded).toEqual({ canonical: 0, siteMain: 0, catalog: 0 });
    expect(out.canonicalServiceUrl).toBe(EPIL_URL);
  });
});

/* ======================================================================
 * B2 (2026-08-25): специалисты — вне бюджета maxLinks. Каждое ПЕРВОЕ
 * упоминание КАЖДОГО специалиста каталога (с pageUrl) получает ссылку на его
 * страницу, даже если бюджет исчерпан (канон + главная + услуги). Услуги
 * по-прежнему бюджетируются окном linksByLength. Инвариант И1: ссылки на
 * специалистов ставит ТОЛЬКО линкер (детерминированно, из БД-каталога).
 * ==================================================================== */
describe('internal-linker — B2: каждый упомянутый специалист получает ссылку', () => {
  const DOCTORS = [
    { fullName: 'Иванова Анна Сергеевна', pageUrl: `${BASE}/doctors/ivanova` },
    { fullName: 'Петров Пётр Петрович', pageUrl: `${BASE}/doctors/petrov` },
    { fullName: 'Сидорова Мария Ивановна', pageUrl: `${BASE}/doctors/sidorova` },
  ];
  const MULTI_BODY = [
    '# Чистка лица: полное руководство',
    'Процедуру проводят Иванова Анна Сергеевна и Петров Пётр Петрович. Консультирует также Сидорова Мария Ивановна.',
    '## Заключение',
    'Иванова Анна Сергеевна принимает ежедневно.',
  ].join('\n\n');

  it('три упомянутых специалиста → три ссылки (по одной на первое вхождение каждого)', () => {
    const out = injectInternalLinks(MULTI_BODY, { services: [], specialists: DOCTORS }, { returnAudit: true });
    expect(out.markdown).toContain(`[Иванова Анна Сергеевна](${BASE}/doctors/ivanova)`);
    expect(out.markdown).toContain(`[Петров Пётр Петрович](${BASE}/doctors/petrov)`);
    expect(out.markdown).toContain(`[Сидорова Мария Ивановна](${BASE}/doctors/sidorova)`);
    // Первое вхождение каждого — ровно ОДНА ссылка (повтор не линкуется).
    expect((out.markdown.match(new RegExp(`\\]\\(${BASE}/doctors/ivanova\\)`, 'g')) || []).length).toBe(1);
    expect(out.injected.filter((i) => i.kind === 'specialist')).toHaveLength(3);
  });

  it('бюджет maxLinks исчерпан каноном → специалисты ВСЁ РАВНО линкуются, услуги — нет', () => {
    const services = ['Гинекология', 'Дерматология', 'Трихология'].map((n) => ({
      name: n, url: `${BASE}/${n.toLowerCase()}`,
    }));
    const md = [
      '# Лазерная эпиляция: гид',
      'Лазерная эпиляция популярна. Приём ведут Иванова Анна Сергеевна и Петров Пётр Петрович. Упоминаем гинекологию и дерматологию и трихологию.',
    ].join('\n\n');
    const out = injectInternalLinks(md, { services, specialists: DOCTORS }, {
      ...CANON_OPTS,
      maxLinks: 1, // бюджет съедает каноническая ссылка
      returnAudit: true,
    });
    expect(out.linksAdded.canonical).toBe(1);
    // Специалисты — вне бюджета:
    expect(out.markdown).toContain(`[Иванова Анна Сергеевна](${BASE}/doctors/ivanova)`);
    expect(out.markdown).toContain(`[Петров Пётр Петрович](${BASE}/doctors/petrov)`);
    // Услуги бюджета не получили:
    expect(out.markdown).not.toContain(`](https://company.example/гинекология)`);
    expect(out.markdown).not.toContain('](https://company.example/дерматология');
  });

  it('специалист БЕЗ pageUrl не линкуется (только специалисты с pageUrl)', () => {
    const md = 'Приём ведёт Кузнецова Ольга Львовна и Иванова Анна Сергеевна.';
    const out = injectInternalLinks(md, {
      services: [],
      specialists: [
        { fullName: 'Кузнецова Ольга Львовна', pageUrl: '' },
        { fullName: 'Иванова Анна Сергеевна', pageUrl: `${BASE}/doctors/ivanova` },
      ],
    }, { returnAudit: true });
    expect(out.markdown).toContain(`[Иванова Анна Сергеевна](${BASE}/doctors/ivanova)`);
    expect(out.markdown).toContain('Кузнецова Ольга Львовна');
    expect(out.markdown).not.toContain('[Кузнецова Ольга Львовна](');
  });

  it('упоминание специалиста только в FAQ-зоне не линкуется (no-link зона действует)', () => {
    const md = [
      '# Тема',
      'Текст без врачей в теле.',
      '## 10 необычных вопросов: Тема',
      'Ответ: приём ведёт Иванова Анна Сергеевна.',
    ].join('\n\n');
    const out = injectInternalLinks(md, { services: [], specialists: DOCTORS }, { returnAudit: true });
    expect(out.markdown).not.toContain(`](${BASE}/doctors/ivanova)`);
    expect(out.injected).toEqual([]);
  });

  it('регресс: budget-гейт услуг работает и при смешанном каталоге', () => {
    const services = ['Гинекология', 'Дерматология', 'Трихология', 'Урология'].map((n) => ({
      name: n, url: `${BASE}/${n.toLowerCase()}`,
    }));
    const md = services.map((s) => `Упоминаем ${s.name}.`).join(' ');
    const out = injectInternalLinks(md, { services, specialists: [] }, { maxLinks: 2, returnAudit: true });
    expect(out.linksAdded.catalog).toBe(2);
    expect((out.markdown.match(/\]\(https:\/\/company\.example\//g) || []).length).toBe(2);
  });
});

/* ======================================================================
 * P1d (2026-09-18): UTM-разметка internal-ссылок.
 * Флаг GENERAPTOR_UTM_ENABLED (truthy-парсер) — дефолт ВЫКЛ: поведение линкера
 * без env не меняется вовсе. utm_campaign передаёт воркер (article id).
 * Инварианты: UTM на ВСЕХ поставленных линкером ссылках (канон/главная/
 * каталог/специалисты); счётчики ссылок (linksAdded, число ссылок в
 * markdown, постчек LINKS-*) НЕ меняются от включения UTM; ожидаемый
 * канон-URL в аудите возвращается в ТОЙ форме, что реально ставится в
 * документ (UTM-форма при включённом флаге — иначе CANONICAL-LINK-ZONE
 * постчека не найдёт ссылку точным сравнением).
 * ==================================================================== */
describe('internal-linker — P1d: UTM-разметка (GENERAPTOR_UTM_ENABLED)', () => {
  const CAMPAIGN = 'art-111';
  const UTM = 'utm_source=generaptor&utm_medium=article&utm_campaign=art-111';
  const utmOf = (u) => `${u}?${UTM}`;

  afterEach(() => {
    delete process.env.GENERAPTOR_UTM_ENABLED;
  });

  it('флаг ВЫКЛ (env не задан) — поведение прежнее: ни одного utm_ в выдаче', () => {
    delete process.env.GENERAPTOR_UTM_ENABLED;
    const catalog = { services: [{ name: 'Мезотерапия', url: `${BASE}/m` }] };
    const out = injectInternalLinks('Проводится мезотерапия.', catalog, {
      ...CANON_OPTS,
      ...SITE_OPTS,
      utmCampaign: CAMPAIGN,
      returnAudit: true,
    });
    expect(out.markdown).not.toContain('utm_');
    expect(out.markdown).toContain(`[мезотерапия](${BASE}/m)`);
    expect(out.canonicalServiceUrl).toBe(EPIL_URL);
  });

  it('флаг ВКЛ — ВСЕ поставленные ссылки несут UTM (канон + главная + каталог)', () => {
    process.env.GENERAPTOR_UTM_ENABLED = '1';
    const catalog = { services: [{ name: 'Лазерная эпиляция', url: EPIL_URL }] };
    const out = injectInternalLinks(BODY + '\n\nПример снова в тексте.', catalog, {
      ...CANON_OPTS,
      ...SITE_OPTS,
      utmCampaign: CAMPAIGN,
      returnAudit: true,
    });
    expect(out.markdown).toContain(`[Лазерная эпиляция](${utmOf(EPIL_URL)})`);
    expect(out.markdown).toContain(`[Пример](${utmOf(`${BASE}/`)})`);
    // Ни одной ссылки без UTM линкер не ставит.
    expect(out.markdown).not.toMatch(/\]\(https:\/\/company\.example\/[^\)?]*\)/);
  });

  it('флаг ВКЛ — специалисты тоже с UTM; аудит injected хранит финальный URL', () => {
    process.env.GENERAPTOR_UTM_ENABLED = '1';
    const out = injectInternalLinks('Приём ведёт Иванова Анна Сергеевна.', {
      services: [],
      specialists: [{ fullName: 'Иванова Анна Сергеевна', pageUrl: `${BASE}/doctors/ivanova` }],
    }, { utmCampaign: CAMPAIGN, returnAudit: true });
    expect(out.markdown).toBe(
      `Приём ведёт [Иванова Анна Сергеевна](${utmOf(`${BASE}/doctors/ivanova`)}).`
    );
    expect(out.injected[0].url).toBe(utmOf(`${BASE}/doctors/ivanova`));
  });

  it('флаг ВКЛ — ожидаемый канон в аудите возвращается UTM-формой (постчек ищет точное совпадение)', () => {
    process.env.GENERAPTOR_UTM_ENABLED = '1';
    const out = injectInternalLinks(BODY, { services: [] }, {
      ...CANON_OPTS,
      utmCampaign: CAMPAIGN,
      returnAudit: true,
    });
    expect(out.canonicalServiceUrl).toBe(utmOf(EPIL_URL));
    expect(out.markdown).toContain(`[Лазерная эпиляция](${utmOf(EPIL_URL)})`);
  });

  it('счётчики ссылок НЕ зависят от UTM: linksAdded и число ссылок в markdown совпадают вкл/выкл', () => {
    const catalog = {
      services: [
        { name: 'Лазерная эпиляция', url: EPIL_URL },
        { name: 'Мезотерапия', url: `${BASE}/mez` },
      ],
    };
    const md = BODY + '\n\nПример снова в тексте, упоминаем и мезотерапию.';

    delete process.env.GENERAPTOR_UTM_ENABLED;
    const off = injectInternalLinks(md, catalog, {
      ...CANON_OPTS, ...SITE_OPTS, utmCampaign: CAMPAIGN, returnAudit: true,
    });
    process.env.GENERAPTOR_UTM_ENABLED = '1';
    const on = injectInternalLinks(md, catalog, {
      ...CANON_OPTS, ...SITE_OPTS, utmCampaign: CAMPAIGN, returnAudit: true,
    });

    expect(on.linksAdded).toEqual(off.linksAdded);
    const count = (s) => (s.match(/\]\(https?:\/\//g) || []).length;
    expect(count(on.markdown)).toBe(count(off.markdown));
    expect(count(on.markdown)).toBeGreaterThan(0);
    // Анкоры не меняются — только query у URL.
    expect(on.markdown.replace(/\?utm_[^)]*/g, '')).toBe(off.markdown);
  });

  it('существующий query в URL каталога сохраняется, UTM добавляется в конец', () => {
    process.env.GENERAPTOR_UTM_ENABLED = '1';
    const out = injectInternalLinks('Проводится мезотерапия.', {
      services: [{ name: 'Мезотерапия', url: `${BASE}/m?tab=price` }],
    }, { utmCampaign: CAMPAIGN, returnAudit: true });
    expect(out.markdown).toContain(`[мезотерапия](${BASE}/m?tab=price&${UTM})`);
  });

  it('идемпотентность повторной сборки: UTM-формы не дублируются при повторном прогоне функции', () => {
    process.env.GENERAPTOR_UTM_ENABLED = '1';
    const catalog = { services: [{ name: 'Мезотерапия', url: `${BASE}/m` }] };
    const first = injectInternalLinks('Проводится мезотерапия.', catalog, {
      utmCampaign: CAMPAIGN, returnAudit: true,
    });
    // Повторный прогон по уже связанному тексту: protected-context не даёт
    // повторно обернуть ссылку — UTM не задваивается.
    const second = injectInternalLinks(first.markdown, catalog, {
      utmCampaign: CAMPAIGN, returnAudit: true,
    });
    expect(second.markdown).toBe(first.markdown);
    expect((second.markdown.match(/utm_source=generaptor/g) || []).length).toBe(1);
  });

  it('falsy-значения env (0/false/off) держат флаг ВЫКЛ', () => {
    for (const value of ['0', 'false', 'off']) {
      process.env.GENERAPTOR_UTM_ENABLED = value;
      const out = injectInternalLinks('Проводится мезотерапия.', {
        services: [{ name: 'Мезотерапия', url: `${BASE}/m` }],
      }, { utmCampaign: CAMPAIGN, returnAudit: true });
      expect(out.markdown).not.toContain('utm_');
    }
  });
});
