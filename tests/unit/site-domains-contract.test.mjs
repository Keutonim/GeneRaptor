import { describe, it, expect } from 'vitest';
import { runArticlePostcheck } from '../../server/lib/article-postcheck.mjs';

/**
 * Контракт домена сайта в постчеке (нейтральные имена).
 *
 * Контекст постчека принимает домены сайта под нейтральным ключом
 * `siteDomains` — это единственный авторитетный ключ. Этот файл фиксирует
 * контракт: посторонние ключи не принимаются, переименование переменной
 * не имеет права изменить поведение.
 */

/** Минимальный документ: одна инлайн-ссылка на сайт. */
const DOC_WITH_LINK = [
  '# Ремонт квартир',
  '',
  'Короткий текст статьи.',
  '',
  'Подробнее: [наши услуги](https://example.test/services/remont).',
  '',
].join('\n');

function report(contextOverrides = {}) {
  return runArticlePostcheck({
    markdown: DOC_WITH_LINK,
    html: '<h1>Ремонт квартир</h1>',
    context: {
      topic: 'Ремонт квартир',
      targetLength: 500,
      ...contextOverrides,
    },
  });
}

function ruleById(result, id) {
  return result.rules.find((r) => r.id === id);
}

describe('siteDomains — нейтральный ключ домена сайта в постчеке', () => {
  it('нейтральный ключ siteDomains засчитывает ссылки на домен сайта', () => {
    const result = report({ siteDomains: ['example.test'] });
    const rule = ruleById(result, 'LINKS-PRESENT');
    expect(rule.status).toBe('pass');
    expect(rule.details.count).toBe(1);
    expect(rule.message).toContain('Инлайн-ссылок на домен сайта: 1');
  });

  it('посторонний ключ не принимается как домены сайта', () => {
    const result = report({ legacyDomains: ['example.test'] });
    const rule = ruleById(result, 'LINKS-PRESENT');
    // Домен не распознан → честный слепой режим, а не приём чужого ключа.
    expect(rule.message).toContain('домен сайта не задан');
  });

  it('siteDomains — единственный источник доменов сайта', () => {
    const result = report({
      siteDomains: ['example.test'],
      legacyDomains: ['other.test'],
    });
    const rule = ruleById(result, 'LINKS-PRESENT');
    expect(rule.details.count).toBe(1);
    expect(rule.message).toContain('Инлайн-ссылок на домен сайта: 1');
  });

  it('ссылка на чужой домен не засчитывается как ссылка на сайт', () => {
    const result = report({ siteDomains: ['other.test'] });
    const rule = ruleById(result, 'LINKS-PRESENT');
    expect(rule.details.count).toBe(0);
    expect(rule.status).toBe('fail');
  });

  it('без домена правило честно сообщает о слепом режиме и называет нейтральный ключ', () => {
    const result = report({});
    const linksPresent = ruleById(result, 'LINKS-PRESENT');
    expect(linksPresent.message).toContain('домен сайта не задан');
    const countRule = ruleById(result, 'LINKS-SITE-COUNT');
    expect(countRule.status).toBe('skipped');
    expect(countRule.message).toContain('siteDomains');
  });
});
