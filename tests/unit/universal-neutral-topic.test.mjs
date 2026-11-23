import { describe, it, expect } from 'vitest';
import { buildRoleExecutionMessages } from '../../server/agent-role-execution.mjs';
import {
  ensureSiteMentions,
  injectFormRecommendationBlock,
  generateFallbackArticle,
} from '../../server/article-post-processor.mjs';
import { buildFormRecommendationBlock } from '../../server/lib/objection-block.mjs';
import { generateUnusualFaqMarkdown } from '../../server/lib/faq-generator.mjs';
import { buildArticleJsonLd } from '../../server/lib/article-view-meta.mjs';
import { sanitizeArticle } from '../../server/lib/article-sanitizer.mjs';

/**
 * Универсальность отрасли.
 *
 * Пайплайн не должен подставлять медицинскую лексику в статью, если тема
 * нейтральная (например, ремонт квартир). Guard («industry-neutral
 * false-disclaimer») при этом остаётся родовым: он ловит ложный
 * профессиональный дисклеймер в ЛЮБОЙ отрасли, а не только в медицинской.
 */

/** Медицинская лексика — тот же класс токенов, который банит universal-gate. */
const MEDICAL_VOCABULARY =
  /клини|медицин|врач|пациент|стоматолог|имплант|диагноз|лекарств|минздрав|родд|онколог|поликлиник|медсестр|терапевт|\bclinic\b|\bmedical\b|\bdoctor\b|\bpatient\b|\bdental\b|\bphysician\b|\btherapy\b/iu;

const NEUTRAL_TOPIC = 'Ремонт квартир';
const NEUTRAL_COMPANY = 'СтройДом';

const NEUTRAL_BODY = [
  `# ${NEUTRAL_TOPIC}: как выбрать подрядчика`,
  '',
  '## С чего начать',
  '',
  'Ремонт квартиры начинается с фиксации объёма работ и составления сметы.',
  '',
  '## Стоимость',
  '',
  'Итоговая стоимость зависит от площади, выбранных материалов и сроков.',
  '',
  '## Как выбрать подрядчика',
  '',
  'Сравните сметы нескольких компаний, проверьте отзывы и уточните гарантии.',
  '',
].join('\n');

function medicalHits(text) {
  return String(text ?? '').match(new RegExp(MEDICAL_VOCABULARY.source, 'giu')) ?? [];
}

describe('универсальность отрасли — нейтральная тема не получает медицинскую лексику', () => {
  it('промпт автора для нейтральной темы свободен от медицинской лексики', () => {
    const messages = buildRoleExecutionMessages({
      roleId: 'article-author',
      projectTitle: NEUTRAL_TOPIC,
      articleTitle: `${NEUTRAL_TOPIC}: как выбрать подрядчика`,
      companyName: NEUTRAL_COMPANY,
      language: 'ru',
      semanticCore: { mainQueryRu: 'ремонт квартир' },
    });
    const prompt = messages.find((m) => m.role === 'user').content;
    expect(prompt.length).toBeGreaterThan(0);
    expect(medicalHits(prompt)).toEqual([]);
  });

  it('детерминированный постпродакшен для нейтральной темы свободен от медицинской лексики', () => {
    const mentions = ensureSiteMentions(NEUTRAL_BODY, NEUTRAL_COMPANY, 2, 'neutral-seed');
    expect(medicalHits(mentions.markdown)).toEqual([]);

    const injected = injectFormRecommendationBlock(mentions.markdown, NEUTRAL_COMPANY, 'article-1');
    expect(injected.markdown.length).toBeGreaterThan(0);
    expect(medicalHits(injected.markdown)).toEqual([]);

    const fallback = generateFallbackArticle(
      { sections: [{ headingRu: 'С чего начать' }] },
      { company: NEUTRAL_COMPANY, specialist: 'Иван Петров' },
    );
    expect(medicalHits(fallback.articleMarkdownRu)).toEqual([]);

    const formBlock = buildFormRecommendationBlock(NEUTRAL_COMPANY, 'neutral-seed');
    expect(medicalHits(formBlock.markdown)).toEqual([]);
  });

  it('FAQ и JSON-LD для нейтральной темы свободны от медицинской лексики', () => {
    const faq = generateUnusualFaqMarkdown(NEUTRAL_TOPIC, 10);
    expect(medicalHits(faq.markdown)).toEqual([]);

    const jsonLd = buildArticleJsonLd({
      title: `${NEUTRAL_TOPIC}: как выбрать подрядчика`,
      siteName: NEUTRAL_COMPANY,
      description: 'Как выбрать подрядчика для ремонта квартиры',
      faqEntries: [{ q: 'Сколько стоит ремонт?', a: 'Зависит от объёма работ.' }],
      updatedDate: '2026-01-01',
    });
    expect(medicalHits(JSON.stringify(jsonLd))).toEqual([]);
  });

  it('guard ложного профессионального дисклеймера остаётся родовым (не сломан)', () => {
    const sanitized = sanitizeArticle(
      [
        'Я не являюсь юристом, поэтому не даю юридическую консультацию.',
        '',
        'Обычная строка статьи про ремонт квартир.',
      ].join('\n'),
    );
    expect(sanitized.markdown).not.toMatch(/не являюсь/i);
    expect(sanitized.markdown).toContain('Обычная строка статьи про ремонт квартир.');
    expect(sanitized.report.counts.aiPhrases).toBeGreaterThan(0);
  });
});
