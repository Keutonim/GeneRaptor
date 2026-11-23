import { useEffect, useState } from 'react';
import { X, TriangleAlert, Check, Minus } from 'lucide-react';
import type { ArticleDetailsPostcheckFields, PostcheckRule } from '../hooks/useApi';
import { COVER_AGENT_NAME, coverSkipNote } from '../data/cover';
import { useI18n, type TranslationParams } from '../i18n';
import '../styles/details.css';

interface ArticleDetailsModalProps {
  /** null = модалка закрыта. */
  articleId: string | null;
  onClose: () => void;
}

type Translate = (key: string, params?: TranslationParams) => string;

type AgentRunDetails = {
  agentName: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costRub: number | null;
  error: string | null;
};

type ResearchSourceDetails = {
  id: string;
  title: string | null;
  sourceUrl: string | null;
  evidenceLevel: string;
  snippet: string;
};

type DetailsResponse = ArticleDetailsPostcheckFields & {
  id: string;
  topic: string;
  targetLength: number;
  characterCount: number | null;
  sourcesByProvider: Record<string, ResearchSourceDetails[]>;
  sourcesTotal: number;
  agentRuns: AgentRunDetails[];
  /** Cover wave: свежие cover-поля статьи, ЕСЛИ бэк их отдаёт в /details
   * (контракт заморожен только для /content — здесь поля опциональны,
   *  блок обложки деградирует до стоимости из agent_run «Генерация обложки»). */
  /** M5: обложка лежит в локальном хранилище; байты — GET /api/articles/:id/cover. */
  coverFile?: string | null;
  coverModel?: string | null;
  coverCostRub?: number | null;
  coverGeneratedAt?: string | null;
  /** Cover checkbox wave: фаза обложки + причина пропуска/ошибки —
   * источник обязательной заметки (показ только при skipped/failed). */
  coverStatus?: string | null;
  coverSkipReason?: string | null;
};

/** W3: имя служебного рана пост-проверки. Синхронизировано с
 *  POSTCHECK_AGENT_NAME в server/lib/article-postcheck.mjs (единственный
 *  источник на бэке). Этот ран — НЕ этап генерации: в «Прогрессе по ролям»
 *  он фильтруется, отчёт живёт в секции «Качество статьи». */
const POSTCHECK_AGENT_NAME = 'Пост-проверка качества';

/** W3: человекочитаемые названия блоков правил (контракт Dev-A: блоки
 *  head/seo/body/faq/sig/links/process). Неизвестный блок — как есть. */
const POSTCHECK_BLOCK_KEYS: Record<string, string> = {
  head: 'details.block.head',
  seo: 'details.block.seo',
  body: 'details.block.body',
  faq: 'details.block.faq',
  sig: 'details.block.sig',
  links: 'details.block.links',
  process: 'details.block.process',
};

function postcheckBlockLabel(block: string, t: Translate): string {
  const key = POSTCHECK_BLOCK_KEYS[block];
  return key ? t(key) : block;
}

/** Провайдеры-бренды совпадают в RU/EN; «unknown» — переводимый ярлык. */
const PROVIDER_KEYS: Record<string, string> = {
  unknown: 'details.providerUnknown',
};

function providerLabel(p: string, t: Translate): string {
  const key = PROVIDER_KEYS[p];
  return key ? t(key) : p;
}

const RUN_STATUS_KEYS: Record<string, string> = {
  pending: 'details.status.pending',
  running: 'details.status.running',
  completed: 'details.status.completed',
  failed: 'details.status.failed',
  skipped: 'details.status.skipped',
};

function runStatusLabel(status: string, t: Translate): string {
  const key = RUN_STATUS_KEYS[status];
  return key ? t(key) : status;
}

/** Коды пропуска обложки → ключи словаря (тексты из src/data/cover.ts
 *  остаются для панели обложки, здесь — локализованные строки модалки). */
const COVER_SKIP_KEYS: Record<string, string> = {
  cover_budget_exceeded: 'details.coverSkip.budget',
  cover_disabled: 'details.coverSkip.disabled',
  cover_not_configured: 'details.coverSkip.notConfigured',
  cover_empty_article: 'details.coverSkip.emptyArticle',
  cover_exists: 'details.coverSkip.exists',
  cover_generation_failed: 'details.coverSkip.generationFailed',
  cover_save_failed: 'details.coverSkip.saveFailed',
  cover_compression_failed: 'details.coverSkip.compressionFailed',
  cover_in_progress: 'details.coverSkip.inProgress',
};

/** ux-fixes U3: короткая подпись причины needs_review для строки списка
 *  (списки генерации и истории). Схлопываем переводы строк/двойные пробелы и
 *  режем до ~60 символов с «…»; полная причина — в title-подсказке строки
 *  и в этой модалке. */
export function truncateReviewReason(reason: string, maxLength = 60): string {
  const clean = reason.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Группировка правил по block с сохранением порядка первого появления. */
function groupPostcheckRulesByBlock(rules: PostcheckRule[]): { block: string; rules: PostcheckRule[] }[] {
  const groups: { block: string; rules: PostcheckRule[] }[] = [];
  const indexByBlock = new Map<string, number>();
  for (const rule of rules) {
    const idx = indexByBlock.get(rule.block);
    if (idx === undefined) {
      indexByBlock.set(rule.block, groups.length);
      groups.push({ block: rule.block, rules: [rule] });
    } else {
      groups[idx].rules.push(rule);
    }
  }
  return groups;
}

/** W3: строка правила чек-листа. Иконка по status: pass (приглушённо) /
 *  fail (цвет по severity) / skipped. details рисуем только строкой
 *  (typeof-гард: контракт допускает любые JSON-значения). */
function PostcheckRuleRow({ rule }: { rule: PostcheckRule }) {
  const iconClass =
    rule.status === 'fail'
      ? rule.severity === 'blocker'
        ? 'quality-rule__icon--fail-blocker'
        : rule.severity === 'major'
          ? 'quality-rule__icon--fail-major'
          : 'quality-rule__icon--fail-minor'
      : rule.status === 'pass'
        ? 'quality-rule__icon--pass'
        : 'quality-rule__icon--skipped';
  const Icon = rule.status === 'pass' ? Check : rule.status === 'fail' ? X : Minus;
  return (
    <div className="quality-rule">
      <span className={`quality-rule__icon ${iconClass}`}>
        <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className="quality-rule__body">
        <span className="quality-rule__id">{rule.id}</span>
        {rule.status === 'fail' && <span className="quality-rule__severity"> · {rule.severity}</span>}
        <div className="quality-rule__message">{rule.message}</div>
        {typeof rule.details === 'string' && rule.details !== '' && (
          <div className="quality-rule__details">{rule.details}</div>
        )}
      </span>
    </div>
  );
}

export function ArticleDetailsModal({ articleId, onClose }: ArticleDetailsModalProps) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Ошибка хранится ключом словаря — текст собирается при рендере (язык).
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // W3: свёртка чек-листа качества — по умолчанию только проваленные правила;
  // сбрасывается при смене статьи (вместе с data ниже).
  const [showAllPostcheckRules, setShowAllPostcheckRules] = useState(false);

  useEffect(() => {
    if (!articleId) {
      setData(null);
      setErrorKey(null);
      setShowAllPostcheckRules(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorKey(null);
    setData(null);
    setShowAllPostcheckRules(false);
    fetch(`/api/articles/${articleId}/details`)
      .then(async (res) => {
        if (res.status === 404) throw new Error('details.notFound');
        if (!res.ok) throw new Error('details.loadError');
        return (await res.json()) as DetailsResponse;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) {
          const key = err instanceof Error ? err.message : '';
          setErrorKey(key === 'details.notFound' || key === 'details.loadError' ? key : 'details.error');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  if (!articleId) return null;

  const numberFormat = new Intl.NumberFormat(locale);

  // Объём: отклонение полученного от запрошенного.
  let volumeText = '—';
  let deviationText = '';
  if (data) {
    const got = data.characterCount;
    const want = data.targetLength;
    if (got != null) {
      volumeText = t('details.chars', { count: numberFormat.format(got) });
      if (want > 0) {
        const dev = ((got - want) / want) * 100;
        const sign = dev > 0 ? '+' : '';
        deviationText = ` · ${sign}${dev.toFixed(1)}%`;
      }
    }
  }

  const providers = data ? Object.keys(data.sourcesByProvider) : [];

  // W3: служебный ран пост-проверки — не этап генерации (фильтрация по имени,
  // константа синхронна с POSTCHECK_AGENT_NAME на бэке). Его отчёт живёт в
  // секции «Качество статьи»; счётчик «Этапов: N» считает только роли.
  // Cover wave: ран «Генерация обложки» фильтруется тем же приёмом — обложка
  // не этап текстового конвейера; её результат показан компактным блоком ниже.
  const visibleAgentRuns = data
    ? data.agentRuns.filter(
        (r) => r.agentName !== POSTCHECK_AGENT_NAME && r.agentName !== COVER_AGENT_NAME,
      )
    : [];

  // Cover wave: данные компактного блока обложки. Приоритет — свежие
  // cover-поля статьи (если бэк отдаёт их в /details); фолбэк стоимости —
  // последний успешный ран «Генерация обложки» (append-only леджер).
  const coverRuns = data ? data.agentRuns.filter((r) => r.agentName === COVER_AGENT_NAME) : [];
  const coverFile = data?.coverFile ?? null;
  const coverModel = data?.coverModel ?? null;
  const coverCost =
    data?.coverCostRub ??
    coverRuns
      .filter((r) => r.costRub != null)
      .slice(-1)[0]?.costRub ??
    null;
  const coverGeneratedAtLabel = (() => {
    const raw = data?.coverGeneratedAt;
    if (!raw) return null;
    const time = new Date(raw).getTime();
    return Number.isFinite(time) ? new Date(time).toLocaleString(locale) : null;
  })();
  const hasCoverInfo = coverFile != null || coverModel != null || coverCost != null;

  // Cover checkbox wave: обязательная заметка о пропуске/ошибке — ТОЛЬКО
  // при coverStatus ∈ {skipped, failed}; при успехе её нет (есть сам блок
  // обложки), при отсутствии фазы — тоже. Текст — словарь по коду.
  const coverSkip = data?.coverStatus === 'skipped' || data?.coverStatus === 'failed'
    ? coverSkipNote(data?.coverSkipReason)
    : null;
  const coverNoteText = coverSkip && data?.coverSkipReason
    ? t(COVER_SKIP_KEYS[data.coverSkipReason] ?? 'details.coverSkip.default')
    : null;

  // W3: пост-проверка качества. Старый API/статья без полей → всё null,
  // секция деградирует в нейтральную строку «не проводилась» (?? null-безопасность).
  const postcheck = data?.postcheck ?? null;
  const needsReviewReason = data?.needsReviewReason ?? null;
  const postcheckRules = postcheck?.rules ?? [];
  const postcheckSummary = postcheck?.summary ?? null;
  const postcheckFailedRules = postcheckRules.filter((r) => r.status === 'fail');
  const postcheckGroups = groupPostcheckRulesByBlock(postcheckRules);
  // Свёртка: по умолчанию только fail-правила (они же источник verdict
  // fail/warn); группы без провалов скрываются целиком.
  const postcheckVisibleGroups = showAllPostcheckRules
    ? postcheckGroups
    : postcheckGroups
        .map((g) => ({ ...g, rules: g.rules.filter((r) => r.status === 'fail') }))
        .filter((g) => g.rules.length > 0);
  const postcheckHiddenCount = postcheckRules.length - postcheckFailedRules.length;

  const postcheckBannerText =
    postcheck?.verdict === 'ok'
      ? `${t('details.qualityOk')} (${t('details.rulesCount', { count: postcheckRules.length })})`
      : postcheck?.verdict === 'warn'
        ? t('details.qualityWarn')
        : t('details.qualityFail');
  const postcheckSubtitle = postcheck
    ? postcheckSummary
      ? t('details.qualityCounts', {
          pass: postcheckSummary.pass,
          fail: postcheckSummary.fail,
          skipped: postcheckSummary.skipped,
        })
      : t('details.qualityRules', { count: postcheckRules.length })
    : t('details.qualityNotRun');
  const postcheckCheckedAtText =
    typeof postcheck?.checkedAt === 'string' && postcheck.checkedAt !== ''
      ? new Date(postcheck.checkedAt).toLocaleString(locale)
      : null;

  return (
    <div className="details__overlay" onClick={onClose}>
      <div className="details__panel" onClick={(e) => e.stopPropagation()}>
        <div className="details__header">
          <h3 className="details__title">{t('details.title')}</h3>
          <button
            type="button"
            className="details__close"
            onClick={onClose}
            aria-label={t('details.close')}
          >
            <X size={18} />
          </button>
        </div>

        {loading && <div className="details__loading">{t('details.loading')}</div>}
        {errorKey && !loading && <div className="details__error">{t(errorKey)}</div>}

        {!loading && !errorKey && data && (
          <div className="details__body">
            {/* 1. Тема */}
            <details open className="details__section">
              <summary className="details__summary">{t('details.topic')}</summary>
              <div className="details__value">{data.topic}</div>
            </details>

            {/* 2. Объём */}
            <details open className="details__section">
              <summary className="details__summary">{t('details.volume')}</summary>
              <div className="details__grid">
                <div>
                  <span className="details__muted">{t('details.requested')}</span>{' '}
                  <strong>{t('details.chars', { count: numberFormat.format(data.targetLength) })}</strong>
                </div>
                <div>
                  <span className="details__muted">{t('details.received')}</span>{' '}
                  <strong>
                    {volumeText}
                    {deviationText}
                  </strong>
                </div>
              </div>
            </details>

            {/* 3. Качество статьи (W3): баннер-вердикт + причина needs_review +
                чек-лист правил по блокам. Служебный ран не входит в «Прогресс
                по ролям» — его отчёт живёт здесь. Секция раскрыта, когда есть
                что показать; у старых статей — нейтральная строка. */}
            <details
              open={postcheck != null || needsReviewReason != null}
              className="details__section"
            >
              <summary className="details__summary">
                {t('details.quality')}
                <span className="details__subtitle">{postcheckSubtitle}</span>
              </summary>
              <div className="details__grid">
                {/* ux-fixes U3: причина needs_review — ПРИОРИТЕТНАЯ строка
                    (реальная причина статуса с сервера: бюджет времени /
                    QC / качество), поэтому выше баннера-вердикта. Чек-лист
                    постчека ниже показывается как раньше (при fail — с
                    проваленными правилами). */}
                {needsReviewReason != null && (
                  <div className="quality-review-reason">
                    <TriangleAlert size={15} />
                    <span>{needsReviewReason}</span>
                  </div>
                )}
                {postcheck != null && (
                  <div className={`quality-banner quality-banner--${postcheck.verdict}`}>
                    {postcheck.verdict === 'ok' ? <Check size={16} /> : <TriangleAlert size={16} />}
                    {postcheckBannerText}
                  </div>
                )}
                {postcheck == null ? (
                  <div className="details__muted">{t('details.qualityLegacy')}</div>
                ) : (
                  <>
                    {postcheckCheckedAtText && (
                      <div className="details__muted--small">
                        {t('details.checkedAt', { date: postcheckCheckedAtText })}
                      </div>
                    )}
                    {postcheckRules.length === 0 ? (
                      <div className="details__muted">{t('details.noRules')}</div>
                    ) : (
                      <>
                        <div>
                          {postcheckVisibleGroups.map((group) => (
                            <div key={group.block} className="quality-block">
                              <div className="quality-block__title">
                                {postcheckBlockLabel(group.block, t)} · {group.rules.length}
                              </div>
                              {group.rules.map((rule) => (
                                <PostcheckRuleRow key={rule.id} rule={rule} />
                              ))}
                            </div>
                          ))}
                          {postcheckVisibleGroups.length === 0 && (
                            <div className="details__muted">{t('details.noFailures')}</div>
                          )}
                        </div>
                        {postcheckHiddenCount > 0 && (
                          <button
                            type="button"
                            className="quality-toggle"
                            onClick={() => setShowAllPostcheckRules((v) => !v)}
                          >
                            {showAllPostcheckRules
                              ? t('details.collapse')
                              : t('details.showAll', { count: postcheckRules.length })}
                          </button>
                        )}
                        {postcheckSummary != null && (
                          <div className="details__muted--small">
                            {t('details.qualityTotals', {
                              pass: postcheckSummary.pass,
                              fail: postcheckSummary.fail,
                              skipped: postcheckSummary.skipped,
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </details>

            {/* 4. Источники */}
            <details className="details__section">
              <summary className="details__summary">
                {t('details.sources')}
                <span className="details__subtitle">
                  {t('details.total', { count: data.sourcesTotal })}
                </span>
              </summary>
              <div className="details__grid">
                {providers.length === 0 ? (
                  <div className="details__muted">{t('details.noSources')}</div>
                ) : (
                  providers.map((p) => {
                    const list = data.sourcesByProvider[p];
                    return (
                      <div key={p}>
                        <div className="details__provider">
                          {providerLabel(p, t)} ({list.length})
                        </div>
                        <ul className="details__source-list">
                          {list.map((s) => (
                            <li key={s.id} className="details__source">
                              <div className="details__source-title">
                                {s.title || s.sourceUrl || t('details.untitled')}{' '}
                                <span className="details__muted--small">[{s.evidenceLevel}]</span>
                              </div>
                              {s.sourceUrl && (
                                <a
                                  className="details__source-link"
                                  href={s.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {s.sourceUrl}
                                </a>
                              )}
                              {s.snippet && <div className="details__source-snippet">{s.snippet}</div>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })
                )}
              </div>
            </details>

            {/* 5. Прогресс по ролям (W3: служебный ран «Пост-проверка качества»
                отфильтрован — постчек не является этапом генерации, счётчик
                «Этапов» считает только ролевые запуски, 11 ролей конвейера) */}
            <details className="details__section details__section--last">
              <summary className="details__summary">
                {t('details.roles')}
                <span className="details__subtitle">
                  {t('details.stages', { count: visibleAgentRuns.length })}
                </span>
              </summary>
              <div className="details__grid">
                {visibleAgentRuns.length === 0 ? (
                  <div className="details__muted">{t('details.noRuns')}</div>
                ) : (
                  <ul className="details__roles">
                    {visibleAgentRuns.map((r, idx) => {
                      const hasError = r.status === 'failed' || !!r.error;
                      const tokens =
                        r.inputTokens != null || r.outputTokens != null
                          ? t('details.tokens', { count: `${r.inputTokens ?? 0}/${r.outputTokens ?? 0}` })
                          : null;
                      const cost = r.costRub != null ? `${r.costRub.toFixed(2)}₽` : null;
                      return (
                        <li
                          key={idx}
                          className={hasError ? 'details__role details__role--error' : 'details__role'}
                        >
                          <strong>{r.agentName}</strong> — {runStatusLabel(r.status, t)}
                          {tokens && <> · {tokens}</>}
                          {cost && <> · {cost}</>}
                          {r.error && <div className="details__role-error">{r.error}</div>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {/* Cover wave: компактный блок обложки (изображение + модель +
                    стоимость) — рядом со списком стоимостей ролей. Ран
                    «Генерация обложки» отфильтрован из списка этапов выше. */}
                {hasCoverInfo && (
                  <div className="details__cover">
                    {coverFile != null && (
                      <img
                        className="details__cover-image"
                        src={`/api/articles/${articleId}/cover`}
                        alt={t('details.coverAlt')}
                      />
                    )}
                    <div className="details__cover-info">
                      <div className="details__cover-title">{t('details.cover')}</div>
                      {coverModel != null && <div>{t('details.model')} {coverModel}</div>}
                      {coverCost != null && <div>{t('details.cost')} {coverCost.toFixed(2)}₽</div>}
                      {coverGeneratedAtLabel != null && (
                        <div>{t('details.createdAt')} {coverGeneratedAtLabel}</div>
                      )}
                    </div>
                  </div>
                )}
                {/* Cover checkbox wave: заметка «обложка пропущена/не создана»
                    под блоком обложки — предупреждение (skipped) или опасность
                    (failed), 13px/1.5 как соседние строки блока. Кнопки ручной
                    генерации не добавляем — они в панели обложки превью; текст
                    ведёт туда словами («в панели обложки»). */}
                {coverNoteText && (
                  <div
                    role="note"
                    className={
                      coverSkip?.tone === 'danger'
                        ? 'details__note details__note--danger'
                        : 'details__note details__note--warning'
                    }
                  >
                    <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>{coverNoteText}</span>
                  </div>
                )}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
