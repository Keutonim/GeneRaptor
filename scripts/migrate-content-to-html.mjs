/**
 * B1 — миграция article_version.content_html из markdown в HTML.
 *
 * Контекст: до фикса B1 worker клал сырой markdown (с [текст](url) ссылками)
 * в content_html/content_text. После B1 worker рендерит markdown → HTML.
 * Этот скрипт приводит в соответствие УЖЕ существующие строки: перегенерирует
 * content_html из markdown, пересчитывает content_text (плейн-текст из HTML)
 * и character_count.
 *
 * Idempotency: строки, где content_html уже похож на HTML (см. looksLikeHtml),
 * пропускаются — повторный прогон безопасен (no-op для уже-HTML).
 *
 * Запуск (из корня проекта, с доступом к нужной БД через DATABASE_URL):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/db \
 *     node scripts/migrate-content-to-html.mjs
 *
 *   APPLY=true node scripts/migrate-content-to-html.mjs   # применить запись
 *   (по умолчанию — dry-run, только отчёт)
 *
 * Бэкап ДО миграции: backups/full-20260729-234035.dump
 * Откат: восстановление БД из дампа backups/full-20260729-234035.dump.
 */
import { PrismaClient } from '@prisma/client';
import {
  renderMarkdownToHtml,
  htmlToPlainText,
  looksLikeHtml,
} from '../server/lib/markdown-renderer.mjs';

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === 'true';

/**
 * Решает, нужно ли мигрировать конкретную строку.
 * @param {{ contentHtml: string|null }} row
 * @returns {boolean}
 */
export function shouldMigrate(row) {
  const ch = row?.contentHtml;
  if (typeof ch !== 'string' || !ch.trim()) return false; // пустой/NULL — нечего мигрировать
  return !looksLikeHtml(ch); // мигрируем, только если это ещё НЕ HTML (т.е. markdown)
}

/**
 * Перегенерирует поля версии из markdown content_html.
 * @param {string} markdownContent
 * @returns {{ contentHtml: string, contentText: string, characterCount: number }}
 */
export function migrateRow(markdownContent) {
  const contentHtml = renderMarkdownToHtml(markdownContent);
  const contentText = htmlToPlainText(contentHtml);
  return { contentHtml, contentText, characterCount: contentText.length };
}

async function main() {
  const versions = await prisma.articleVersion.findMany({
    select: { id: true, version: true, contentHtml: true, articleId: true },
    orderBy: { articleId: 'asc' },
  });

  console.log(`ArticleVersion rows total: ${versions.length}`);

  const toMigrate = versions.filter((v) => shouldMigrate(v));
  const alreadyHtml = versions.length - toMigrate.length;

  console.log(`Already HTML (skipped): ${alreadyHtml}`);
  console.log(`Markdown to migrate: ${toMigrate.length}`);
  console.log('---');

  if (!toMigrate.length) {
    console.log('Nothing to migrate. Idempotent no-op.');
    return;
  }

  let migrated = 0;
  for (const v of toMigrate) {
    const result = migrateRow(v.contentHtml);
    console.log(
      `  v${v.version} (article ${v.articleId.slice(0, 8)}): ` +
        `${(v.contentHtml || '').length} chars md → ${result.contentHtml.length} chars html, ` +
        `${result.characterCount} plain-text chars`
    );
    if (APPLY) {
      await prisma.articleVersion.update({
        where: { id: v.id },
        data: {
          contentHtml: result.contentHtml,
          contentText: result.contentText,
          characterCount: result.characterCount,
        },
      });
    }
    migrated++;
  }

  console.log('---');
  console.log(`Migrated: ${migrated}`);
  console.log(APPLY ? 'Mode: APPLY (changes written to DB)' : 'Mode: DRY-RUN (re-run with APPLY=true to write)');
}

// Запускаем main() только при прямом вызове скрипта (не при импорте в тестах).
const isMainEntry = import.meta.url === `file://${process.argv[1]}`;

if (isMainEntry) {
  main()
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
