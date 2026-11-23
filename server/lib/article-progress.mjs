/**
 * W2 (2026-08-14): единый источник правды о проценте готовности статьи.
 *
 * До этого процент считали в трёх местах по-разному:
 *   - GET /api/articles/:id/progress (локальный round((stage-1)/11*100));
 *   - WS-броадкасты воркера (round(i/11*100) + свой расчёт при финализации);
 *   - списка статей не было вовсе.
 * needs_review в /progress давал 0 (findIndex → -1) — QA-блокер.
 *
 * Теперь и serializeArticle (список/детали), и /progress берут ЧИСЛО здесь.
 * Карта 11 генерируемых статусов — ОДНА на проект: свере́на с порядком
 * agentRoleData × ROLE_STATUS_MAP (server/workers/article-generation.mjs:145-160
 * и server/routes/articles.mjs — идентичны).
 *
 * Контракт:
 *   draft/pending/queued/stopped → 0
 *   генерируемые (11 ролей)      → round(i/11*100)   // i — 0-based индекс роли
 *   needs_review/ready/completed/published → 100
 *   error/failed                 → null  // «неизвестно», фронт прячет полосу
 *   неизвестный статус           → null
 *
 * Расхождение, закрытое в hardening (H-06): финальный WS-кадр воркера при
 * needs_review слал round(step/11*100) (45–82 %) вместо 100, хотя прогон был
 * завершён. Теперь финальный кадр воркера (server/workers/article-generation.mjs)
 * всегда percent=100 и currentStage=totalStages, а /progress для needs_review
 * отдаёт currentStage=totalStages (см. articleProgressOverview ниже).
 */

/** Порядок = порядок ролей в agentRoleData (сверено с ROLE_STATUS_MAP воркера и роутов). */
import { MANUAL_PUBLISH_STATUS, isFinalStatus } from './article-status.mjs';
import { agentRoleData } from '../agent-role-data.mjs';
import { ROLE_STATUS_MAP, latestAgentRun } from './article-stages.mjs';

export const GENERATION_STATUSES = [
  'topic_generation', // 0 → 0%
  'brief_preparation', // 1 → 8%
  'knowledge_base', // 2 → 15%
  'research', // 3 → 23%
  'semantic_strategy', // 4 → 31%
  'structure', // 5 → 38%
  'article_writing', // 6 → 46%
  'factcheck', // 7 → 54%
  'seo_review', // 8 → 62%
  'quality_control', // 9 → 69%
  'humanize', // 10 → 77%
];

export const PROGRESS_TOTAL_STAGES = GENERATION_STATUSES.length; // 11

// W «Автоматизация» (2026-10-27): published_manual — новый терминальный статус
// ручной отметки «опубликовано». Литерал живёт в article-status.mjs (один
// источник правды), здесь только расширяем карту прогресса.
export const FINAL_STATUSES = ['needs_review', 'ready', 'completed', 'published', MANUAL_PUBLISH_STATUS];
export { isFinalStatus };
const FAILED_STATUSES = ['error', 'failed'];
const ZERO_STATUSES = ['draft', 'pending', 'queued', 'stopped'];

/**
 * Процент готовности статьи по её статусу.
 *
 * @param {string|null|undefined} status — Article.status.
 * @returns {number|null} 0..100 или null («неизвестно»: ошибка/незнакомый статус).
 */
export function articleProgress(status) {
  if (typeof status !== 'string' || status === '') return null;

  const stageIndex = GENERATION_STATUSES.indexOf(status);
  if (stageIndex !== -1) {
    // Тот же расчёт, что был в /progress: (stage-1)/11 == i/11 (0-based).
    return Math.round((stageIndex / PROGRESS_TOTAL_STAGES) * 100);
  }
  if (FINAL_STATUSES.includes(status)) return 100;
  if (FAILED_STATUSES.includes(status)) return null;
  if (ZERO_STATUSES.includes(status)) return 0;
  return null;
}

/**
 * Сводный вид прогресса статьи.
 *
 * Вынесено из GET /api/articles/:id/progress, чтобы маршрут оставался тонким,
 * а расчёт жил в одном месте. Контракт полей НЕ изменён: те же восемь полей,
 * что и раньше (status/currentStage/totalStages/stageName/agentName/
 * description/percent/message) — их читает src/hooks/useWebSocketProgress.ts.
 *
 * @param {{status?:string|null, agentRuns?:Array<object>}} article
 * @returns {{status:string, currentStage:number, totalStages:number, stageName:string,
 *            agentName:string, description:string, percent:number|null, message:string}}
 */
export function articleProgressOverview({ status, agentRuns = [] } = {}) {
  const runs = Array.isArray(agentRuns) ? agentRuns : [];
  const totalStages = PROGRESS_TOTAL_STAGES;

  if (status === 'draft') {
    return {
      status,
      currentStage: 0,
      totalStages,
      stageName: 'Ожидание запуска',
      agentName: 'system',
      description: 'Статья создана, генерация ещё не запущена',
      percent: articleProgress(status),
      message: 'Ожидание запуска',
    };
  }

  if (status === 'stopped') {
    return {
      status,
      currentStage: 0,
      totalStages,
      stageName: 'Остановлено',
      agentName: 'system',
      description: 'Генерация остановлена оператором',
      percent: articleProgress(status),
      message: 'Генерация остановлена',
    };
  }

  if (status === 'ready' || status === 'published') {
    return {
      status,
      currentStage: totalStages,
      totalStages,
      stageName: 'Готово',
      agentName: 'humanizer',
      description: 'Статья готова',
      percent: articleProgress(status),
      message: 'Генерация завершена',
    };
  }

  if (status === 'needs_review') {
    // Прогон завершён, но контент требует ручной проверки: это ТЕРМИНАЛЬНЫЙ
    // кадр (percent=100, currentStage=totalStages) — как и WS-кадр воркера.
    const lastRun = latestAgentRun(runs);
    return {
      status,
      currentStage: totalStages,
      totalStages,
      stageName: 'Требуется проверка',
      agentName: lastRun?.agentName || 'system',
      description: 'Контент сохранён, требуется ручная проверка',
      percent: articleProgress(status),
      message: 'Генерация завершена, контент требует ручной проверки',
    };
  }

  if (status === 'failed') {
    const failedRun = runs.find((run) => run?.status === 'failed');
    return {
      status,
      currentStage: 0,
      totalStages,
      stageName: 'Ошибка',
      agentName: failedRun?.agentName || 'system',
      description: failedRun?.error || 'Генерация завершилась с ошибкой',
      // null, не 0: у упавшей статьи процент «неизвестен» — как в списке.
      percent: articleProgress(status),
      message: failedRun?.error || 'Генерация завершилась с ошибкой',
    };
  }

  // Статусы в процессе генерации.
  const currentAgentName = latestAgentRun(runs)?.agentName || null;

  // Номер текущего этапа — по маппингу статуса статьи на роль каталога.
  const roleIndex = agentRoleData.findIndex(
    (role) => role.id === status || ROLE_STATUS_MAP[role.id] === status,
  );
  const currentStage = roleIndex >= 0 ? roleIndex + 1 : 0;
  const stageName =
    roleIndex >= 0 ? agentRoleData[roleIndex].nameRu : currentAgentName || 'Подготовка';

  return {
    status,
    currentStage,
    totalStages,
    stageName,
    agentName: currentAgentName || 'system',
    description: stageName,
    percent: articleProgress(status),
    message: `Выполняется этап: ${stageName}`,
  };
}
