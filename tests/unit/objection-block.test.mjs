import { describe, it, expect } from 'vitest';
import {
  hasObjectionSection,
  objectionSectionValid,
  buildFormRecommendationBlock,
  hasFormRecommendationBlock,
} from '../../server/lib/objection-block.mjs';
import { findForbiddenPromises } from '../../server/lib/article-postcheck.mjs';
import { agentRoleMap } from '../../server/agent-role-data.mjs';

/**
 * P2-2: objection-section deterministic guards + form
 * recommendation block (audit items 7.4/7.5). Pure lib — no LLM, no I/O.
 * The forbidden-promise lexicon is NOT duplicated here: the check reuses
 * findForbiddenPromises from article-postcheck.mjs (single source, P1a).
 */

/* ── hasObjectionSection ─────────────────────────────────────────────── */

describe('hasObjectionSection — детект секции возражений по корню заголовка', () => {
  it('true: «## Возражения и сомнения клиентов» (корень «возражени»)', () => {
    expect(hasObjectionSection('# Тема\n\n## Возражения и сомнения клиентов\n\nТекст.')).toBe(true);
  });
  it('true: «## Мифы о решении» (корень «миф»)', () => {
    expect(hasObjectionSection('## Мифы о решении\n\nТекст.')).toBe(true);
  });
  it('true: падежи/регистр — «Возражений клиентов», «мифы и правда»', () => {
    expect(hasObjectionSection('## Ответы на возражений клиентов')).toBe(true);
    expect(hasObjectionSection('## мифы и правда о чистке')).toBe(true);
  });
  it('false: обычные контентные секции без корня', () => {
    expect(hasObjectionSection('## Виды решений\n\n## Реабилитация')).toBe(false);
    expect(hasObjectionSection('Обычный текст про возражения в абзаце, но заголовка нет.')).toBe(false);
  });
  it('false: корень внутри ДРУГОГО слова в заголовке не матчится (\\p{L}-гард слева)', () => {
    expect(hasObjectionSection('## Превозражения клиентов')).toBe(false);
    expect(hasObjectionSection('## Смифы и сомнения')).toBe(false);
  });
  it('false: пустой/нестроковый ввод; заголовок внутри code-fence не считается', () => {
    expect(hasObjectionSection('')).toBe(false);
    expect(hasObjectionSection(null)).toBe(false);
    expect(hasObjectionSection('```\n## Возражения клиентов\n```\n\nТекст.')).toBe(false);
  });
});

/* ── objectionSectionValid ───────────────────────────────────────────── */

/** Валидная секция возражений: ≥2 H3-вопросов с содержательными ответами. */
function validObjectionSection() {
  return [
    '## Возражения и сомнения клиентов', '',
    'Сомнения перед выбором решения естественны — разберём частые из них с опорой на факты.', '',
    '### Нужно ли личное обращение?', '',
    'Результат зависит от исходных условий и выбранного способа работы.', '',
    '### Правда, что всё решается за один визит?', '',
    'Нет: часть задач решается на этапе консультации и настройки.', '',
  ].join('\n');
}

describe('objectionSectionValid — ≥2 H3-вопросов + без запрещённых обещаний', () => {
  it('valid: 2 H3-вопроса с ответами, без обещаний', () => {
    const res = objectionSectionValid(validObjectionSection());
    expect(res.valid).toBe(true);
    expect(res.questionItems).toBe(2);
    expect(res.promiseHits).toHaveLength(0);
  });

  it('invalid: секции возражений нет вовсе (reason not-found)', () => {
    const res = objectionSectionValid('# Тема\n\n## Виды решений\n\nТекст.');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('not-found');
  });

  it('invalid: один H3-вопрос — «опустошённая» секция (reason too-few-questions)', () => {
    const md = [
      '## Возражения клиентов', '',
      '### Больно ли это?', '',
      'Ответ на единственный вопрос вполне содержательный и корректный.', '',
    ].join('\n');
    const res = objectionSectionValid(md);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('too-few-questions');
  });

  it('invalid: H3 есть, но НЕ вопросные (без «?») — не Q-style', () => {
    const md = [
      '## Мифы о решении', '',
      '### Первый миф', '',
      'Разбор первого мифа с опорой на источники и отраслевые наблюдения экспертов.', '',
      '### Второй миф', '',
      'Разбор второго мифа с опорой на источники и отраслевые наблюдения экспертов.', '',
    ].join('\n');
    const res = objectionSectionValid(md);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('too-few-questions');
  });

  it('invalid: обещание результата внутри секции (лексика BODY-NO-PROMISES)', () => {
    const md = [
      '## Возражения клиентов', '',
      '### Больно ли это?', '',
      'Нет, решение полностью безопасно и даёт мгновенный результат без усилий.', '',
      '### Правда, что дорого?', '',
      'Мы гарантируем результат этой услуги, поэтому цена оправдана полностью.', '',
    ].join('\n');
    const res = objectionSectionValid(md);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('promise-lexicon');
    expect(res.promiseHits.length).toBeGreaterThanOrEqual(2);
  });

  it('отрицательная форма от лица эксперта («не может гарантировать») — НЕ обещание', () => {
    const md = validObjectionSection().replace(
      'Результат зависит от исходных условий и выбранного способа работы.',
      'Эксперт не может гарантировать результат без уточнения задачи: итог индивидуален.',
    );
    const res = objectionSectionValid(md);
    expect(res.valid).toBe(true);
    expect(res.promiseHits).toHaveLength(0);
  });

  it('обещание ВНЕ секции возражений не портит валидность секции (зона — одна секция)', () => {
    const md = validObjectionSection() + '\n\n## Заключение\n\nМы гарантируем результат всем клиентам компании.';
    const res = objectionSectionValid(md);
    expect(res.valid).toBe(true);
  });
});

/* ── buildFormRecommendationBlock / hasFormRecommendationBlock ───────── */
describe('buildFormRecommendationBlock — детерминированный блок записи', () => {
  it('возвращает markdown-блок с H2 «Как записаться …» и советом по кнопке/форме', () => {
    const block = buildFormRecommendationBlock('Пример');
    expect(block.markdown).toMatch(/^## Как записаться[а-яё ]*/i);
    expect(block.heading).toMatch(/^Как записаться/);
    // advice about button / lead-form placement must be present (audit 7.5)
    const lower = block.markdown.toLowerCase();
    expect(lower).toContain('форм');
    expect(lower).toContain('кнопк');
    expect(block.markdown).toContain('Пример');
  });

  it('детерминирован: одинаковый вход → байт-в-байт одинаковый блок', () => {
    expect(buildFormRecommendationBlock('Компания А', 'art-1').markdown)
      .toBe(buildFormRecommendationBlock('Компания А', 'art-1').markdown);
  });

  it('без имени компании — блок всё равно строится (обезличенная форма)', () => {
    const block = buildFormRecommendationBlock('');
    expect(block.markdown).toMatch(/^## /);
    expect(hasFormRecommendationBlock(block.markdown)).toBe(true);
  });

  it('блок НЕ содержит запрещённых обещаний (лексика BODY-NO-PROMISES)', () => {
    for (const company of ['Пример', '']) {
      const block = buildFormRecommendationBlock(company, 'seed');
      expect(findForbiddenPromises(block.markdown)).toEqual([]);
    }
  });

  it('блок записи — нейтральный отраслевой текст (без отраслевой привязки)', () => {
    const block = buildFormRecommendationBlock('Пример', 'seed');
    expect(block.markdown).not.toMatch(/врач|пациент|медицин/i);
    expect(block.markdown).toContain('компанию Пример');
  });

  it('блок — чистый markdown: никакого HTML', () => {
    const block = buildFormRecommendationBlock('Компания', 's');
    expect(block.markdown).not.toMatch(/<\/?[a-z][^>]*>/i);
  });

  it('hasFormRecommendationBlock — детект обоих вариантов заголовка (идемпотентность)', () => {
    expect(hasFormRecommendationBlock('## Как записаться на консультацию\n\nТекст.')).toBe(true);
    expect(hasFormRecommendationBlock('## Как записаться на приём\n\nТекст.')).toBe(true);
    expect(hasFormRecommendationBlock('## Запись\n\nОбычная секция.')).toBe(false);
    expect(hasFormRecommendationBlock('')).toBe(false);
    expect(hasFormRecommendationBlock(null)).toBe(false);
  });
});

/* ── Prompt deltas (S1-B §1.5) — agent-role-data assertions ──────────── */

describe('agent-role-data — P2-2 prompt deltas', () => {
  it('structure-architect: тип секции возражений через formatRu: "возражения" (макс 1, опционально)', () => {
    const prompt = agentRoleMap.get('structure-architect')?.systemPrompt ?? '';
    expect(prompt).toContain('formatRu: "возражения"');
    expect(prompt).toMatch(/БЛОК ВОЗРАЖЕНИЙ/);
    // max one objection section per article
    expect(prompt).toMatch(/одн[а-яё]+ секци[а-яё]+/i);
  });

  it('article-author: правила секции возражений — H3-вопросы, спокойный тон, запрет обещаний', () => {
    const prompt = agentRoleMap.get('article-author')?.systemPrompt ?? '';
    expect(prompt).toMatch(/СЕКЦИЯ ВОЗРАЖЕНИЙ/);
    expect(prompt).toMatch(/formatRu: "возражения"/);
    // Q-style H3 items requirement
    expect(prompt).toMatch(/H3-заголовок в форме вопроса/i);
    // BODY-NO-PROMISES lexicon awareness: banned phrases enumerated in the prompt
    expect(prompt).toContain('гарантируем результат');
    expect(prompt).toContain('100%');
    expect(prompt).toContain('навсегда');
    // negated expert-voice disclaimer explicitly allowed
    expect(prompt).toMatch(/не может гарантировать результат/);
  });

  it('topic-selector: замороженная строка REVENUE-РАНЖИРОВАНИЕ (spec) — дословно', () => {
    const prompt = agentRoleMap.get('topic-selector')?.systemPrompt ?? '';
    const frozen =
      'REVENUE-РАНЖИРОВАНИЕ: если в контексте есть блок „Ранжированные кандидаты" — выбирай ' +
      'тему преимущественно из верхних позиций (спрос + выгода компании); отступай вниз только ' +
      'при риске дубля или несоответствии каталогу.';
    expect(prompt).toContain(frozen);
  });
});
