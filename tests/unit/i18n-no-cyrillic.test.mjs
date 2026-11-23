/**
 * M7 — grep gate: no hardcoded Russian UI literals outside the RU table.
 *
 * The RU language table (src/i18n/dictionary.ts) is the single source of
 * Russian UI copy. Everything else under src/ must be locale-neutral: no
 * Cyrillic literals in code (comments are stripped before the scan).
 *
 * Exemptions are explicit — engine data, the export zone and the deletion
 * candidates (listed below).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

const EXEMPT = new Set([
  // RU language table — the source of truth for Russian UI copy.
  'src/i18n/dictionary.ts',
  // Engine data: role names, prompts, server-supplied cover messages.
  'src/data/agentRoles.ts',
  'src/data/cover.ts',
  // M8 zone (export + cover + article details).
  'src/components/ArticleDetailsModal.tsx',
  'src/components/CoverSettings.tsx',
  'src/features/shared/exportContent.ts',
  'src/features/shared/useArticleExport.ts',
  // M9 deletion candidates (proposed for the RU-literal cleanup).
  'src/components/ConfigBanner.tsx',
  'src/components/FaqButton.tsx',
  'src/components/FaqModal.tsx',
  'src/components/QueueElapsedBadge.tsx',
  'src/components/SearchableDropdown.tsx',
  'src/data/faqs.ts',
  'src/hooks/useElapsedTimer.ts',
  'src/lib/strip-markdown.ts',
]);

const CYRILLIC = /[\u0400-\u04FF\u0500-\u052F]/;

/** Drop comments so that prose in comments is not mistaken for UI copy. */
function stripComments(source, extension) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (extension === '.css') return out;
  return out
    .split('\n')
    .map((line) => {
      const quote = line.search(/['"`]/);
      const slash = line.indexOf('//');
      if (slash === -1) return line;
      if (quote !== -1 && quote < slash) return line;
      return line.slice(0, slash);
    })
    .join('\n');
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

describe('M7 — grep gate: no Russian UI literals outside the RU table', () => {
  it('finds no Cyrillic in src/ (comments excluded)', () => {
    const violations = [];
    for (const file of collectFiles(SRC)) {
      if (EXEMPT.has(file)) continue;
      const extension = file.slice(file.lastIndexOf('.'));
      const source = readFileSync(join(ROOT, file), 'utf8');
      const code = stripComments(source, extension);
      code.split('\n').forEach((line, index) => {
        if (CYRILLIC.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('keeps the exemption list small and documented', () => {
    expect(EXEMPT.size).toBeLessThanOrEqual(20);
  });
});
