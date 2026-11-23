# Дизайн UI GeneRaptor

> **Статус:** оболочка v1: 3 вкладки, 3 секции настроек, токен-гейт, токены тем,
> полный словарь RU/EN, контролы экспорта, блок «Поисковые источники» в секции
> «Провайдеры и ключи» с keyless-вертикалями «используется автоматически по теме».
> Контракт «3 вкладки + 3 секции» — жёсткий: четвёртой вкладки и четвёртой секции
> не существует и не документируется. Все значения проверены по коду (`файл:строка`).

---

## RU

### 1. Направление

«Редакционная точность»: интерфейс типографской мастерской, а не дашборда. Пустое
пространство — часть набора; акцентный цвет — только на действии. Язык интерфейса —
деловой, без маркетинга; ошибки — с диагнозом и предложением. Тексты RU/EN хранятся в
словаре, в коде строк нет.

### 2. Дизайн-язык

- Шрифты: системный стек — Segoe UI Variable Text / Segoe UI / system-ui (текст),
  Cascadia Mono / Consolas (числа, токены, коды) — `styles/tokens.css:45-46`.
- Сетка отступов 4px (`--space-1…--space-16`, §3.3 tokens.css); радиусы и тени
  сдержанные, «печатные».
- Токены: `src/styles/tokens.css` (v1.1); легаси `src/styles.css` переопределяется
  токенами и остаётся в репозитории.

### 3. Цветовые токены (v1.1, обе темы)

Светлая (`:root`):

| Токен | Значение | Роль |
|---|---|---|
| `--bg` | `#fafaf9` | фон приложения |
| `--surface` / `-raised` / `-sunken` | `#ffffff` / `#f4f4f3` / `#f5f4f2` | поверхности |
| `--border` / `-strong` | `#e8e8e8` / `#e3e3e3` | линии |
| `--text-primary/secondary/muted` | `#171717` / `#525252` / `#6e6e6e` | текст |
| `--accent` / `--accent-wash` | `#b42318` / `#f9eded` | действие |
| `--danger` / `--success` / `--warning` | `#dc2626` / `#15803d` / `#8a5a00` | статусы |

Тёмная (`[data-theme="dark"]`, src/styles/tokens.css:75):

| Токен | Значение |
|---|---|
| `--bg` / `--surface` / `-raised` / `-sunken` | `#141415` / `#19191b` / `#232325` / `#0f0f10` |
| `--border` / `-strong` | `#2e2e30` / `#323234` |
| `--text-primary/secondary/muted` | `#ededed` / `#a1a1a6` / `#8a8a90` |
| `--accent` / `--accent-wash` | `#f97066` / `#342324` |
| `--danger` / `--success` / `--warning` | `#f06568` / `#4cc38a` / `#d9a441` |

Доступность (измеренные контрасты):
светлая — основной текст 17.93:1 (AAA),
вторичный 7.81:1, акцент на фоне 6.57:1, статусные ≥4.83:1; тёмная — основной 15.00:1,
вторичный 6.82:1, акцент 6.30:1, статусные ≥5.12:1; `--on-accent` на акценте 6.61:1.
Декоративные бордеры — 1.23:1/1.28:1 (принципиально декоративные, не несут контента).

### 4. Каркас (реализован, `src/app/AppShell.tsx`)

Топбар 56px вместо сайдбара:

```
┌──────────────────────────────────────────────────────────────┐
│ GeneRaptor   Генерация  История  Настройки      RU|EN ◐ ☀ ☾ │
│                                            server: 127.0.0.1 │
└──────────────────────────────────────────────────────────────┘
```

- Ровно **3 вкладки** — `TABS [generation, history, settings]`, `nav[role=tablist]` +
  `button[role=tab]` (AppShell.tsx). Четвёртой вкладки нет и не планируется.
- Правые инструменты: RU|EN (radiogroup `topbar.language.label`), тема
  light/auto/dark (Sun/Monitor/Moon), строка сервера `topbar.server`.
- Переключение локали/темы — только перерисовка, без рефетчей (контракт в коде).
- Разблокировка: `src/components/TokenGate.tsx` — экран на всё окно (см. §6).

### 5. Вкладка «Генерация» — одна колонка, фазы (реализовано, `src/features/generation/`)

Фазы: `composer → clarify → running → result` (`GenerationView.tsx`).

**A. Composer** (`Composer.tsx`): тема (≤200 симв., сервер `TOPIC_MAX_LENGTH=200`),
объём — 3 пресета «короткая/средняя/длинная» = 50 000 / 65 000 / 80 000 симв. (сервер
допускает 7 значений 50–80 тыс. с шагом 5 тыс., `server/lib/article-volume.mjs`),
язык материала ru|en (не зависит от локали UI — фиксированный ввод),
галочка «обложка» (недоступна с честной причиной, если нет images-провайдера —
`deriveCoverCheckboxState`), кнопка «Начать генерацию» активна при готовом провайдере.
Спам-детектор тем (склейка поисковых фраз) предлагает замену; подтверждение
«Всё равно создать» = `confirmConcatenatedTopic` (сервер).

**B. Clarify** (`ClarifyStep.tsx`): тема только для чтения (кнопка правки), заметки
≤1000 симв. (`#clarify-notes`), «Начать генерацию» / «Назад».

**C. Run sheet** (`RunSheetView.tsx`): 11 строк по каталогу ролей
(`src/data/agentRoles.ts`); состояния выполнено/текущий/ожидает; строка
«Этап N из 11» с `aria-live=polite`, имя этапа и роль; кнопка остановки. Прогресс —
WS `/ws` + HTTP-поллинг 3 с как fallback (`useWebSocketProgress.ts`).

**D. Result** (`ResultView.tsx`): галлея (колонка чтения) + правый рельс обложки;
HTML статьи промывается DOMPurify перед вставкой; мета «{слова} · {этапы} · {язык}»,
слова = `characterCount/6`. API контента поддерживает правку результата
(`PUT /api/articles/:id/content`); UI-контролей правки текста нет — есть
контролы экспорта (§10).

### 6. Экран токен-гейта (`TokenGate.tsx`)

Четыре состояния, один инпут, одна кнопка «Открыть»; меняется только строка под
кнопкой: пусто → «Токен не принят — неверен, уже использован или окно приёма истёкло»
(401) → отсчёт при 429 → успех. 401 в середине сессии возвращает на гейт с состоянием
«неверно». Дизайн — на токенах обеих тем.

### 7. Вкладка «История» (`src/features/history/HistoryView.tsx`)

Строки-карточки; фильтры: поиск по тексту + select статуса. Меню строки ⋯:
«Открыть» (переход на вкладку Генерация в фазу result/running), «Копировать HTML/TXT/MD»
(буфер; форматы из `/api/articles/:id/content`), «Скачать обложку» (прямая ссылка
на бинарный маршрут), «Удалить» с диалогом подтверждения.

### 8. Вкладка «Настройки» — 3 секции (`SettingsView.tsx`)

Ровно **3 секции** (`data-section`): providers | models | roles. Четвёртой секции нет.

1. **Провайдеры и ключи** (`ProvidersSection.tsx`): 4 карточки-вида (routerai /
   openrouter / ollama / custom), замаскированный ключ (значение не возвращается),
   источник env/локально, пинг `POST /api/settings/api-keys/test` → ok|warning|error
   с кулдауном 30 с (клиент `PROBE_COOLDOWN_MS=30_000`, как на сервере; панель пинга —
   моно-шрифт, статус-цвет; ошибка без echo ответа провайдера). Внутри той же секции —
   свёрнутый по умолчанию блок «Поисковые источники»
   (`SearchSourcesBlock.tsx:163`): select бэкенда веб-поиска
   (авто / Tavily / Tavily без ключа / Serper.dev / Yandex / Википедия / Викиданные /
   DuckDuckGo), кнопка «Проверить ключ» для ключевых бэкендов, поле пробного запроса
   и кнопка «Проверить поиск». Восемь keyless-вертикалей (OpenAlex, Crossref,
   Europe PMC, GDELT, Nominatim, OpenLibrary, Stack Exchange, Hacker News) в селект
   основного движка **не входят** — показываются отдельным списком «Источники по теме»
   с подписями «без ключа» и «по теме»; состав селекта не меняется.
   Честная подсказка блока: ключ Serper (`GENERAPTOR_SERPER_API_KEY`) включает
   основной движок, без ключа работает бесплатная цепочка (Tavily без ключа →
   Википедия → Викиданные) (`src/features/settings/SearchSourcesBlock.tsx:172`);
   в результатах пробы отображается источник — per-item `provider`.
   Выбор сохраняется в браузере
   (`src/features/settings/helpers/searchSources.ts:14`); поля ввода поискового ключа
   нет — блок показывает имя переменной окружения выбранного бэкенда и его состояние
   (`src/features/settings/SearchSourcesBlock.tsx:196`).
2. **Модели** (`ModelsSection.tsx`): tier-таблица critical/generation/standard (+cover),
   ввод названий моделей; при env-конфигурации — только чтение.
3. **Роли** (`RolesSection.tsx`): 11 ролей; редактор промпта (maxLength 10 000 в UI;
   серверная валидация 200–10 000 символов — `server/routes/agent-roles.mjs:22-23`),
   сохранение `PUT /api/settings/agent-roles` (персистентность серверная), сброс к
   каталогу DELETE. Настройки обложек (`CoverSettings`) живут внутри секции «Модели»
   (модель обложки, compression-модель) — отдельной секции «Обложки» нет.

### 9. Панель обложки (`CoverPanel.tsx`, в правом рельсе результата)

| Состояние | Вид | Действие |
|---|---|---|
| не запрошена | кнопка «Сгенерировать обложку» | POST `{}` |
| генерация | спиннер, поллинг 5 с | — |
| готова | превью + подпись (модель, стоимость) | «Перегенерировать по уточнению» (поле ≤500 симв., POST `{refinement}`); «Сгенерировать заново» (POST `{fresh:true}`); «Скачать обложку» (anchor download) |
| ошибка | текст ошибки (код → человекочитаемое) | повтор |

Поток обложек не меняет статус статьи; недоступность images-провайдера —
честная причина в UI.

### 10. Экспорт

Копирование в буфер: HTML / TXT / MD (`src/features/shared/exportContent.ts`,
`useArticleExport.ts`, сброс «Скопировано» через 1,5 с). Скачивание файла — только
обложка. Скачивания файла статьи **нет** — только копирование в буфер и скачивание
обложки.

### 11. i18n и темы

- Локаль: localStorage `generaptor.locale`; тема: `generaptor.theme`
  (light/auto/dark; auto = атрибут `data-theme` снят, таблица следует
  `prefers-color-scheme`).
- Полный словарь (`src/i18n/dictionary.ts`), интерполяция `{param}`, неизвестные
  ключи выводятся как есть.
- Словарь RU/EN — одинаковый набор ключей в обеих
  таблицах (паритет и полноту проверяет `tests/unit/i18n-dictionary.test.mjs`;
  пространства: nav,
  topbar, composer, clarify, run, article, language, cover, export, history, settings,
  providers, models, roles, status, token, errors); плюрализация one/few/many/other
  через `Intl.PluralRules`; inline-bootstrap в `index.html` без FOUC; локаль зеркалится
  в `document.lang`.
- Темы: переключатель в топбаре; палитра v1.1 (см. §3).

### 12. Чего намеренно нет

Нет и не документируется: 4-я вкладка/секция, сбор статистики поисковых запросов /
обходы сайтов / публикации (удалены из кода), скачивание статьи файлом, аккаунты/роли пользователей, мобильный
лейаут, онбординг-тур, тёмные паттерны (автостарт, автопубликация).

---

## EN — UI design (mirror)

> Status: the v1 shell: 3 tabs, 3 settings sections, the token gate, theme tokens,
> the full RU/EN dictionary, the export controls, and the "Search sources" block in
> the "Providers & keys" section with the keyless verticals "used automatically by
> topic". The "3 tabs + 3 sections" contract is hard: a fourth tab or section does
> not exist and is never documented. All values are code-verified (`file:line` repo-relative).

### 1. Direction

"Editorial precision": a typesetting-room interface, not a dashboard. Whitespace is
part of the toolkit; accent color marks action only. Interface language is business-like,
no marketing; errors carry a diagnosis and a suggestion. UI strings live in a dictionary, never inline in code.

### 2. Design language

- Type: a system stack — Segoe UI Variable Text / Segoe UI / system-ui (text),
  Cascadia Mono / Consolas (numbers, tokens, codes) — `styles/tokens.css:45-46`.
- 4px spacing grid (`--space-1…--space-16`); restrained "print-like" radii and shadows.
- Tokens: `src/styles/tokens.css` (v1.1); legacy `src/styles.css` is overridden by the
  tokens and stays in the repository.

### 3. Color tokens (v1.1, both themes)

Light (`:root`):

| Token | Value | Role |
|---|---|---|
| `--bg` | `#fafaf9` | app background |
| `--surface` / `--surface-raised` / `--surface-sunken` | `#ffffff` / `#f4f4f3` / `#f5f4f2` | surfaces |
| `--border` / `--border-strong` | `#e8e8e8` / `#e3e3e3` | lines |
| `--text-primary` / `--text-secondary` / `--text-muted` | `#171717` / `#525252` / `#6e6e6e` | text |
| `--accent` / `--accent-wash` | `#b42318` / `#f9eded` | action |
| `--danger` / `--success` / `--warning` | `#dc2626` / `#15803d` / `#8a5a00` | statuses |

Dark (`[data-theme="dark"]`, src/styles/tokens.css:75):

| Token | Value |
|---|---|
| `--bg` / `--surface` / `--surface-raised` / `--surface-sunken` | `#141415` / `#19191b` / `#232325` / `#0f0f10` |
| `--border` / `--border-strong` | `#2e2e30` / `#323234` |
| `--text-primary` / `--text-secondary` / `--text-muted` | `#ededed` / `#a1a1a6` / `#8a8a90` |
| `--accent` / `--accent-wash` | `#f97066` / `#342324` |
| `--danger` / `--success` / `--warning` | `#f06568` / `#4cc38a` / `#d9a441` |

Accessibility (measured contrasts):
light — body text 17.93:1 (AAA),
secondary 7.81:1, accent on bg 6.57:1, status colors ≥4.83:1; dark — body 15.00:1,
secondary 6.82:1, accent 6.30:1, status ≥5.12:1; `--on-accent` on accent 6.61:1.
Decorative borders are 1.23:1/1.28:1 — deliberately decorative, carrying no content.

### 4. Shell (implemented, `src/app/AppShell.tsx`)

A 56px topbar instead of a sidebar:

```
┌──────────────────────────────────────────────────────────────┐
│ GeneRaptor   Generation  History  Settings         RU|EN ◐ ☀ ☾│
│                                            server: 127.0.0.1 │
└──────────────────────────────────────────────────────────────┘
```

- Exactly **3 tabs** — `TABS [generation, history, settings]`, `nav[role=tablist]` +
  `button[role=tab]` (AppShell.tsx). There is no fourth tab.
- Right tools: RU|EN (radiogroup), theme light/auto/dark (Sun/Monitor/Moon icons),
  the server line.
- Switching locale/theme re-renders only — no refetches (a code-level contract).
- Unlock: `src/components/TokenGate.tsx` — a full-window screen (see §6).

### 5. Generation tab — one column, phases (implemented, `src/features/generation/`)

Phases: `composer → clarify → running → result` (`GenerationView.tsx`).

**A. Composer** (`Composer.tsx`): topic (≤200 chars, server `TOPIC_MAX_LENGTH=200`);
volume — 3 presets short/medium/long = 50 000 / 65 000 / 80 000 chars (the server
accepts 7 values 50–80k with a 5k step, `server/lib/article-volume.mjs`); article
language ru|en (independent of the UI locale — fixed input); the cover
checkbox (disabled with an honest reason when no images-capable provider exists —
`deriveCoverCheckboxState`); the start button requires a configured provider. A
concatenated-search-phrases topic triggers a suggestion; confirming sends
`confirmConcatenatedTopic`.

**B. Clarify** (`ClarifyStep.tsx`): read-only topic line (edit button), notes
≤1000 chars (`#clarify-notes`), start / back buttons.

**C. Run sheet** (`RunSheetView.tsx`): 11 rows from `src/data/agentRoles.ts`;
done/current/pending states; the "Stage N of 11" line with `aria-live=polite`, stage
and role names; a stop button. Progress arrives over WS `/ws` with a 3-s HTTP polling
fallback (`useWebSocketProgress.ts`).

**D. Result** (`ResultView.tsx`): a reading-column galley plus the cover rail; article
HTML is sanitized with DOMPurify before insertion; the meta line "{words} · {stages} ·
{language}", words = `characterCount/6`. The content API supports editing the result
(`PUT /api/articles/:id/content`); there are no text-editing UI controls — only
the export controls (§10).

### 6. Token gate screen (`TokenGate.tsx`)

Four states, one input, one "Open" button; only the line under the button changes:
empty → "Token not accepted — invalid, already used, or the window has expired" (401) →
a countdown on 429 → success. A mid-session 401 returns to the gate in the "wrong"
state. The design uses tokens from both themes.

### 7. History tab (`src/features/history/HistoryView.tsx`)

Card rows; filters: text search + a status select. Row menu ⋯: "Open" (switches to the
Generation tab in the result/running phase), "Copy HTML/TXT/MD" (clipboard; formats
from `/api/articles/:id/content`), "Download cover" (a direct link to the binary route),
"Delete" with a confirmation dialog.

### 8. Settings tab — 3 sections (`SettingsView.tsx`)

Exactly **3 sections** (`data-section`): providers | models | roles. No fourth section.

1. **Providers & keys** (`ProvidersSection.tsx`): 4 kind cards (routerai / openrouter /
   ollama / custom), the masked key (the value is never returned), env/local source,
   ping `POST /api/settings/api-keys/test` → ok|warning|error with a 30-s cooldown
   (client `PROBE_COOLDOWN_MS=30_000`, matching the server; mono-font panel, status
   color; no provider response echo). Inside the same section sits the "Search sources"
   block, collapsed by default (`SearchSourcesBlock.tsx:163`): a
   web-search backend select (auto / Tavily / Tavily keyless / Serper.dev / Yandex /
   Wikipedia / Wikidata / DuckDuckGo), a "Check key" button for keyed backends, a test
   query field and a "Check search" button. The eight keyless verticals (OpenAlex,
   Crossref, Europe PMC, GDELT, Nominatim, OpenLibrary, Stack Exchange, Hacker News)
   are **not** part of the primary-engine select — they are shown as a separate
   "Topic sources" list with "keyless" and "by topic" badges; the select itself
   is unchanged. The block carries an honest hint: a Serper key
   (`GENERAPTOR_SERPER_API_KEY`) enables the primary engine, and without any key the
   free chain runs (keyless Tavily → Wikipedia → Wikidata)
   (`src/features/settings/SearchSourcesBlock.tsx:172`); the probe results show the
   source — the per-item `provider`.
   The choice is stored in the browser
   (`src/features/settings/helpers/searchSources.ts:14`); there is no search-key input —
   the block shows the environment variable name of the selected backend and its state
   (`src/features/settings/SearchSourcesBlock.tsx:196`).
2. **Models** (`ModelsSection.tsx`): the critical/generation/standard (+cover) tier
   table, model name inputs; read-only under env configuration.
3. **Roles** (`RolesSection.tsx`): 11 roles; the prompt editor (UI maxLength 10 000;
   server-side validation 200–10 000 chars — `server/routes/agent-roles.mjs:22-23`),
   saved via `PUT /api/settings/agent-roles` (server-side persistence), reset with
   DELETE. Cover settings (cover model, compression model) live inside the "Models"
   section — there is no separate "Covers" section.

### 9. Cover panel (`CoverPanel.tsx`, in the result's right rail)

| State | Look | Action |
|---|---|---|
| not requested | "Generate cover" button | POST `{}` |
| generating | spinner, 5-s polling | — |
| ready | preview + caption (model, cost) | "Regenerate with refinement" (field ≤500 chars, POST `{refinement}`); "Generate fresh" (POST `{fresh:true}`); "Download cover" (anchor download) |
| error | error text (code → human message) | retry |

The cover flow never touches the article status; a missing images-capable
provider is shown honestly in the UI.

### 10. Export

Clipboard copy: HTML / TXT / MD (`src/features/shared/exportContent.ts`,
`useArticleExport.ts`, "Copied" resets after 1.5 s). File download is cover-only.
There is **no** article file download — only the clipboard export controls and the
cover download.

### 11. i18n and themes

- Locale: localStorage `generaptor.locale`; theme: `generaptor.theme`
  (light/auto/dark; auto = the `data-theme` attribute is removed and the stylesheet
  follows `prefers-color-scheme`).
- The full dictionary (`src/i18n/dictionary.ts`), `{param}` interpolation,
  unknown keys pass through.
- The RU/EN dictionary — both tables expose the same
  key set (parity and completeness asserted by `tests/unit/i18n-dictionary.test.mjs`;
  namespaces: nav,
  topbar, composer, clarify, run, article, language, cover, export, history, settings,
  providers, models, roles, status, token, errors); one/few/many/other plurals via
  `Intl.PluralRules`; a no-FOUC inline bootstrap in `index.html`; the locale mirrors
  onto `document.lang`.
- Themes: the switch lives in the topbar; the v1.1 palette (§3).

### 12. Deliberately absent

Never present, never documented: a fourth tab/section, search-statistics collection /
site-crawling / publishing (removed from the code), article file download, accounts/user roles, a
mobile layout, onboarding tours, dark patterns (autostart, autopublishing).
