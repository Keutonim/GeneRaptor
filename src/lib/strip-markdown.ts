/**
 * Убирает markdown-разметку, возвращая чистый текст.
 * Для кнопки "Скопировать текстом".
 */
export function stripMarkdown(md: string): string {
  if (!md) return '';
  let text = md;
  // Заголовки: # ## ### → просто текст
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Жирный/курсив: **text** *text* __text__ _text_ → text
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
  // Изображения: ![alt](url) → alt (ДО ссылок, иначе []() съест содержимое и оставит «!»)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Ссылки: [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Блоки кода: ```...``` → содержимое (ДО инлайн-кода, иначе `code` regex разберёт тройные backticks)
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');
  // Инлайн-код: `code` → code
  text = text.replace(/`([^`]+)`/g, '$1');
  // Цитаты: > text → text
  text = text.replace(/^>\s+/gm, '');
  // Списки: - * + в начале строки → убрать маркер
  text = text.replace(/^[ \t]*[-*+]\s+/gm, '');
  // Нумерованные списки: 1. 2. → убрать
  text = text.replace(/^[ \t]*\d+\.\s+/gm, '');
  // Горизонтальные линии: --- *** ___ → убрать
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');
  // Лишние пустые строки (больше 2 подряд → 2)
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
