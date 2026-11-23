/**
 * CI workflow guard (hardening round, defect H-05).
 *
 * The workflow ended with
 *
 *   - name: Lint (if configured)
 *     run: npm run lint --if-present
 *
 * but package.json defines NO `lint` script (no eslint dependency, no eslint
 * config). `npm run lint --if-present` exits 0 without running anything, so
 * the CI log showed a green "lint" step that never linted — a silent check.
 *
 * Invariants pinned here:
 *   1. Every `npm run <script>` referenced by a CI step either resolves to a
 *      real package.json script, or the step says EXPLICITLY why it is skipped
 *      (a guarded `scripts.<name>` probe) — never silently.
 *   2. The mandatory gates stay in the workflow.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Split the `steps:` list into step blocks (`- name:` / `- uses:` entries). */
function stepBlocks(text) {
  return text
    .split(/\n(?=\s{6}- (?:name|uses):)/)
    .slice(1)
    .map((block) => ({
      name: (block.match(/- name:\s*(.+)/) ?? [, '(unnamed step)'])[1].trim(),
      body: block,
    }));
}

describe('CI workflow', () => {
  it('never references a missing package.json script without an explicit guard', () => {
    const missing = [];
    for (const step of stepBlocks(workflow)) {
      for (const match of step.body.matchAll(/npm\s+run\s+([a-zA-Z0-9:_-]+)/g)) {
        const script = match[1];
        if (pkg.scripts?.[script]) continue;
        // A missing script is allowed ONLY when the step probes for it and
        // explains the skip (e.g. `scripts.lint?0:1` + an echo).
        const guarded = new RegExp(`scripts\\??\\.${script}\\b`).test(step.body);
        if (!guarded) missing.push(`${step.name} -> npm run ${script}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('does not hide a missing script behind npm --if-present', () => {
    expect(workflow).not.toMatch(/npm run [a-zA-Z0-9:_-]+\s+--if-present/);
  });

  it('keeps the mandatory gates', () => {
    for (const command of [
      'npm ci',
      'npx prisma validate',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'npm run test:e2e',
      'npm run lint:brand',
    ]) {
      expect(workflow).toContain(command);
    }
  });

  /**
   * SEC-17: the CI installed with `npm ci --no-audit`, so a vulnerable
   * dependency set could reach the shipped tree without failing the build.
   * The audit is a SEPARATE step that fails the job on a high/critical
   * advisory in the production tree.
   */
  it('fails the job on a high/critical advisory in the production tree', () => {
    const auditStep = stepBlocks(workflow).find((step) => step.body.includes('npm audit'));
    expect(auditStep).toBeDefined();
    expect(auditStep.body).toMatch(/npm audit/);
    expect(auditStep.body).toMatch(/--omit=dev/);
    expect(auditStep.body).toMatch(/--audit-level=high/);
  });

  it('keeps the install step free of the audit (a separate step owns it)', () => {
    const installStep = stepBlocks(workflow).find((step) => step.body.includes('npm ci'));
    expect(installStep).toBeDefined();
    expect(installStep.body).toMatch(/--no-audit/);
  });
});
