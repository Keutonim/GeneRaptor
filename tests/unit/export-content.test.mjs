import { describe, it, expect } from 'vitest';
import { exportPayload } from '../../src/features/shared/exportContent';

const MARKDOWN = '# Заголовок\n\nТекст абзаца.';

describe('exportPayload — единая точка выбора, что копировать', () => {
  it('предпочитает поле движка, если оно есть', () => {
    const content = {
      contentHtml: '<h1>Заголовок</h1>',
      contentText: 'Заголовок',
      contentMarkdown: MARKDOWN,
    };
    expect(exportPayload(content, 'html')).toBe('<h1>Заголовок</h1>');
    expect(exportPayload(content, 'text')).toBe('Заголовок');
    expect(exportPayload(content, 'markdown')).toBe(MARKDOWN);
  });

  it('выводит формат из markdown движка, если поле движка пустое', () => {
    const content = { contentHtml: '', contentText: '', contentMarkdown: MARKDOWN };
    expect(exportPayload(content, 'html')).toBe('<h1>Заголовок</h1>\n<p>Текст абзаца.</p>');
    expect(exportPayload(content, 'text')).toBe('Заголовок\n\nТекст абзаца.');
    expect(exportPayload(content, 'markdown')).toBe(MARKDOWN);
  });

  it('возвращает пустую строку без содержимого', () => {
    expect(exportPayload(null, 'html')).toBe('');
    expect(exportPayload({ contentHtml: '', contentText: '', contentMarkdown: '' }, 'text')).toBe('');
  });
});
