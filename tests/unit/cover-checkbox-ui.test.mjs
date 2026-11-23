/**
 * Cover checkbox wave (design-cover-checkbox §3/§4/§5/§9): pure UI helpers of
 * the checkbox wave, exported from src/data/cover.ts and tested WITHOUT DOM
 * (idiom: a DOM-free unit test over the real modules — vitest transforms src
 * TS via vite; no @testing-library harness exists in this repo).
 *
 * Contract under test:
 *   - §3.3/§9.1  coverCheckboxHint — «+~5 ₽ …» for a known price, «Цена
 *     зависит от модели …» when the estimate is unknown;
 *   - §3.5/§9.1  deriveCoverCheckboxState — disabled only on an EXPLICIT
 *     available:false + reason; a failed/old-server payload stays optimistic;
 *   - §4.2/§9.2  coverBadge — badge label/tone/title per coverStatus, null
 *     when silent (ready / no request);
 *   - §4.3       hasCoverPhaseItems — the queue polling gate extension
 *     (requested|generating keep the 15s list poll alive);
 *   - §5/§6/§9.4 coverSkipNote — the RU skip/fail note keyed by
 *     coverSkipReason, tone warning (skipped) vs danger (failed);
 *   - §6         poll tunables + coverPollDeadlineExceeded (5s interval,
 *     ~5 min cap) for the ArticleCoverPanel self-refresh.
 */
import { describe, it, expect } from 'vitest';
import {
  coverCheckboxHint,
  deriveCoverCheckboxState,
  coverBadge,
  hasCoverPhaseItems,
  coverSkipNote,
  COVER_POLL_INTERVAL_MS,
  COVER_POLL_MAX_MS,
  coverPollDeadlineExceeded,
} from '../../src/data/cover';

const HINT_TAIL = 'обложка появится в карточке статьи после генерации';

describe('coverCheckboxHint (docs/ui-design.md)', () => {
  it('known estimate 4.82 → «+~5 ₽ · …» (honest ~ rounding)', () => {
    expect(coverCheckboxHint(4.82)).toBe(`+~5 ₽ · ${HINT_TAIL}`);
  });

  it('integer estimate 7 → «+~7 ₽ · …»', () => {
    expect(coverCheckboxHint(7)).toBe(`+~7 ₽ · ${HINT_TAIL}`);
  });

  it('null estimate (token-priced model / quality auto) → «Цена зависит от модели · …»', () => {
    expect(coverCheckboxHint(null)).toBe(`Цена зависит от модели · ${HINT_TAIL}`);
  });

  it('undefined (old server without §7.6 fields) → «Цена зависит от модели · …»', () => {
    expect(coverCheckboxHint(undefined)).toBe(`Цена зависит от модели · ${HINT_TAIL}`);
  });

  it('non-finite garbage never renders as a price', () => {
    expect(coverCheckboxHint(Number.NaN)).toBe(`Цена зависит от модели · ${HINT_TAIL}`);
    expect(coverCheckboxHint('4.82')).toBe(`Цена зависит от модели · ${HINT_TAIL}`);
  });
});

describe('deriveCoverCheckboxState (docs/ui-design.md)', () => {
  it('settings fetch failed (null) → optimistic enabled, no reason', () => {
    const s = deriveCoverCheckboxState(null);
    expect(s.disabled).toBe(false);
    expect(s.unavailableReason).toBeNull();
  });

  it('available:true → enabled checkbox, no reason, estimate passthrough', () => {
    const s = deriveCoverCheckboxState({ available: true, unavailableReason: null, estimatedCoverCostRub: 4.82 });
    expect(s.disabled).toBe(false);
    expect(s.unavailableReason).toBeNull();
    expect(s.estimatedCoverCostRub).toBe(4.82);
  });

  it('available:false + cover_disabled → disabled with the reason', () => {
    const s = deriveCoverCheckboxState({ available: false, unavailableReason: 'cover_disabled' });
    expect(s.disabled).toBe(true);
    expect(s.unavailableReason).toBe('cover_disabled');
  });

  it('available:false + cover_not_configured → disabled with the reason', () => {
    const s = deriveCoverCheckboxState({ available: false, unavailableReason: 'cover_not_configured' });
    expect(s.disabled).toBe(true);
    expect(s.unavailableReason).toBe('cover_not_configured');
  });

  it('old server (fields undefined) → optimistic enabled (design: «Неизвестно»)', () => {
    const s = deriveCoverCheckboxState({});
    expect(s.disabled).toBe(false);
    expect(s.unavailableReason).toBeNull();
    expect(s.estimatedCoverCostRub).toBeNull();
  });

  it('contradicting payload (available:false, no reason) does NOT block the checkbox', () => {
    const s = deriveCoverCheckboxState({ available: false, unavailableReason: null });
    expect(s.disabled).toBe(false);
  });
});

describe('coverUnavailableMessage (docs/ui-design.md)', () => {
  it('texts verbatim for both reasons', async () => {
    const { coverUnavailableMessage } = await import('../../src/data/cover');
    expect(coverUnavailableMessage('cover_disabled')).toBe(
      'Генерация обложек отключена в настройках сервера.',
    );
    expect(coverUnavailableMessage('cover_not_configured')).toBe(
      'Обложка недоступна: не настроен провайдер для генерации обложек или не задан ключ ROUTERAI.',
    );
    expect(coverUnavailableMessage(null)).toBeNull();
    expect(coverUnavailableMessage('something_new')).toBeNull();
  });
});

describe('coverBadge (docs/ui-design.md)', () => {
  it('requested → neutral «Обложка после генерации» with the forecast title', () => {
    expect(coverBadge('requested')).toEqual({
      label: 'Обложка после генерации',
      tone: 'neutral',
      spinning: false,
      title: 'Обложка будет создана сразу после готовности текста статьи',
    });
  });

  it('generating → accent spinner badge; title carries the elapsed seconds', () => {
    expect(coverBadge('generating', 24)).toEqual({
      label: 'Генерация обложки…',
      tone: 'accent',
      spinning: true,
      title: 'Обычно 1–2 минуты, иногда до 5 минут. Ожидание: 24 с',
    });
  });

  it('generating without elapsed → title without the «Ожидание» tail', () => {
    expect(coverBadge('generating').title).toBe('Обычно 1–2 минуты, иногда до 5 минут.');
  });

  it('skipped → warning «Обложка пропущена»; title = the §9.4 note text', () => {
    const b = coverBadge('skipped', 0, 'cover_budget_exceeded');
    expect(b.label).toBe('Обложка пропущена');
    expect(b.tone).toBe('warning');
    expect(b.title).toContain('лимит на генерацию обложек в этом месяце исчерпан');
  });

  it('failed → danger «Обложка не создана»; title = the §9.4 note text', () => {
    const b = coverBadge('failed', 0, 'cover_generation_failed');
    expect(b.label).toBe('Обложка не создана');
    expect(b.tone).toBe('danger');
    expect(b.title).toContain('не удалось получить изображение у модели');
  });

  it('ready → no badge (the cover itself is the signal)', () => {
    expect(coverBadge('ready')).toBeNull();
  });

  it('null/undefined/unknown → no badge (old server, no request)', () => {
    expect(coverBadge(null)).toBeNull();
    expect(coverBadge(undefined)).toBeNull();
    expect(coverBadge('')).toBeNull();
    expect(coverBadge('some_future_state')).toBeNull();
  });
});

describe('hasCoverPhaseItems (docs/ui-design.md)', () => {
  it('requested|generating keep the poll alive', () => {
    expect(hasCoverPhaseItems([{ coverStatus: 'requested' }])).toBe(true);
    expect(hasCoverPhaseItems([{ coverStatus: 'generating' }])).toBe(true);
  });

  it('terminal/absent statuses do not', () => {
    expect(hasCoverPhaseItems([{ coverStatus: 'ready' }])).toBe(false);
    expect(hasCoverPhaseItems([{ coverStatus: 'skipped' }])).toBe(false);
    expect(hasCoverPhaseItems([{ coverStatus: 'failed' }])).toBe(false);
    expect(hasCoverPhaseItems([{ coverStatus: null }])).toBe(false);
    expect(hasCoverPhaseItems([{}])).toBe(false);
    expect(hasCoverPhaseItems([])).toBe(false);
  });

  it('mixed list: one requested row among ready rows keeps the poll alive', () => {
    expect(hasCoverPhaseItems([{ coverStatus: 'ready' }, { coverStatus: 'requested' }])).toBe(true);
  });
});

describe('coverSkipNote (docs/ui-design.md)', () => {
  it('skip codes → warning tone, §9.4 texts verbatim', () => {
    expect(coverSkipNote('cover_budget_exceeded')).toEqual({
      text: 'Обложка не создана: лимит на генерацию обложек в этом месяце исчерпан. Статья готова без обложки — создать её можно вручную в панели обложки.',
      tone: 'warning',
    });
    expect(coverSkipNote('cover_disabled')).toEqual({
      text: 'Обложка не создана: генерация обложек отключена в настройках.',
      tone: 'warning',
    });
    expect(coverSkipNote('cover_not_configured')).toEqual({
      text: 'Обложка не создана: не настроен провайдер для генерации обложек (нужен ключ ROUTERAI).',
      tone: 'warning',
    });
    expect(coverSkipNote('cover_empty_article')).toEqual({
      text: 'Обложка не создана: сначала сгенерируйте текст статьи — обложка строится по нему.',
      tone: 'warning',
    });
    expect(coverSkipNote('cover_exists')).toEqual({
      text: 'Обложка уже есть — повторная генерация пропущена, лимит не расходуется.',
      tone: 'warning',
    });
    expect(coverSkipNote('cover_article_not_found')?.tone).toBe('warning');
    expect(coverSkipNote('cover_in_progress')).toEqual({
      text: 'Обложка уже генерируется — дождитесь окончания.',
      tone: 'warning',
    });
  });

  it('fail codes → danger tone', () => {
    expect(coverSkipNote('cover_generation_failed')).toEqual({
      text: 'Обложка не создана: не удалось получить изображение у модели. Создать обложку можно вручную в панели обложки.',
      tone: 'danger',
    });
    expect(coverSkipNote('cover_save_failed')).toEqual({
      text: 'Обложка не создана: не удалось сохранить обложку на диск.',
      tone: 'danger',
    });
    expect(coverSkipNote('cover_compression_failed')).toEqual({
      text: 'Обложка не создана: не удалось сжать статью для генерации обложки.',
      tone: 'danger',
    });
  });

  it('unknown code → generic warning note (forward compatibility)', () => {
    expect(coverSkipNote('cover_something_new')).toEqual({
      text: 'Обложка не создана. Подробности — в журнале генерации.',
      tone: 'warning',
    });
  });

  it('null/undefined reason → no note', () => {
    expect(coverSkipNote(null)).toBeNull();
    expect(coverSkipNote(undefined)).toBeNull();
    expect(coverSkipNote('')).toBeNull();
  });
});

describe('cover poll tunables (docs/ui-design.md §9 refresh loop)', () => {
  it('5s interval, ~5 min cap', () => {
    expect(COVER_POLL_INTERVAL_MS).toBe(5000);
    expect(COVER_POLL_MAX_MS).toBe(300000);
  });

  it('coverPollDeadlineExceeded: before the cap false, after true', () => {
    const start = 1_000_000;
    expect(coverPollDeadlineExceeded(start, start + COVER_POLL_MAX_MS)).toBe(false);
    expect(coverPollDeadlineExceeded(start, start + COVER_POLL_MAX_MS + 1)).toBe(true);
    expect(coverPollDeadlineExceeded(null, start + 999999)).toBe(false); // no start → never exceeds
  });
});
