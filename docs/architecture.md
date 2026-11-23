# Архитектура GeneRaptor

> **Статус:** документ описывает текущую поставку GeneRaptor: одноузловую топологию,
> контракт идентификаторов (cookie `generaptor_auth`, env `GENERAPTOR_*`, пустой
> реестр источников), гейты `lint:brand` и `lint:universal` в CI, гейт доступа без
> учёта регистра, единую политику адресов и привязку ключей провайдеров, шифрование
> ключей на покое, проверку Host/Origin, loopback-биндинг по умолчанию, явные
> POSIX-права каталога данных и CI-гейт аудита зависимостей.
> Каждое утверждение проверено по коду; ссылки вида `файл:строка` — от корня репозитория.

---

## RU — Реализованная архитектура

### 1. Процессная схема

Один Node-процесс на приложение — одноузловая топология, без внешних сервисов:

```
npm start (start.mjs)
 ├─ resolveDataDir() → ~/.generaptor (или --data-dir / GENERAPTOR_DATA_DIR)
 ├─ ensureDatabaseSchema() → prisma db push (пустой файл БД пересоздаётся)
 ├─ флаги запуска: --token, --token-ttl, --no-auth, --host (server/lib/launcher-args.mjs),
 │    --port, --api-only, --no-browser (start.mjs)
 ├─ spawn: node server/index.mjs   — API-процесс:
 │    Express (express-app.mjs) + WebSocket /ws (websocket.mjs)
 │    + in-process воркер генерации (workers/article-generation.mjs)
 │    + boot-sweep зависших задач (lib/stale-job-sweep.mjs)
 ├─ spawn: vite dev (5173, dev) ИЛИ раздача dist/ тем же API-процессом (8787, prod)
 └─ баннер с токеном (ровно один раз) → poll готовности UI → автооткрытие
      браузера адресом <uiUrl>/#token=<одноразовый токен> (server/lib/open-browser.mjs;
      guards: --no-browser / NODE_ENV=test / CI / не-TTY / фиксированный токен / нет UI)
```

- `start.mjs` — единственная точка входа «opensource-CLI»: определяет каталог данных,
  поднимает БД, печатает токен и URL, раздаёт SPA. Явный `DATABASE_URL` из env никогда
  не перезаписывается.
- Флаги разбираются **до** бутстрапа: `--host` без значения (и `--host=`) — ошибка
  использования, процесс печатает `[ERROR] …` и выходит с кодом 1
  (`server/lib/launcher-args.mjs:48`, `:62-79`; `start.mjs:385-395`).
- Воркер генерации встраивается в API-процесс (`createArticleGenerationWorker()` в
  `server/express-app.mjs`); отдельного скрипта `npm run worker` в GeneRaptor нет —
  вторая копия сервера конкурировала бы за одну очередь.
- Плавное завершение: SIGTERM/SIGINT → `server.close → worker.close → closeQueues →
  disconnectDB`, принудительно через 15 с (`server/express-app.mjs`); launcher убивает
  дочерние процессы через 3 с после сигнала (`start.mjs`).
- Очередь — `server/lib/queue-shim.mjs`: in-process FIFO, concurrency 1, без
  персистентности и ретраев. Истина о состоянии статьи — `Article.status` в SQLite.

#### 1.1. Dev-топология и маркер доверенного Origin

```
лаунчер (start.mjs)
 ├─ resolveDevUiOrigin({useProdBuild, apiOnly, hostForUrl, uiPort})
 │    → маркер topology: http://<loopback>:<uiPort> ИЛИ null
 │    (server/lib/launcher-args.mjs:197; вызов — start.mjs:487)
 ├─ spawn Vite dev-UI на <uiPort> (браузер открывает localhost ИЛИ 127.0.0.1)
 └─ spawn API: node server/index.mjs --dev-ui-origin <origin>
      (devUiOriginArgs, launcher-args.mjs:218; start.mjs:507 —
       вне dev-топологии фрагмент ПУСТОЙ, флага в argv нет)
        └─ сервер читает маркер один раз (express-app.mjs:83)
             ├─ HTTP-guard изменяющих /api-запросов (express-app.mjs:119)
             └─ WS-handshake (express-app.mjs:255)
```

- Решение — **топология лаунчера**, а не `NODE_ENV`: даже если в `.env` задан
  `NODE_ENV=production`, лаунчер всё равно стартует Vite (нет `dist/`),
  поэтому правило по `NODE_ENV` давало ложный 403 «Запрещённый Origin».
- Приёмка маркера **fail-closed** (`devUiOrigins`, `server/lib/request-origin.mjs:180`):
  ровно один origin; схема `http`/`https`; loopback-хост (`127.0.0.1` / `localhost` /
  `::1`); **явный** порт (неявные 80/443 запрещены); только authority (путь, query,
  фрагмент, credentials → маркер игнорируется). Невалидный маркер → `[]`, набор
  разрешённых origin’ов не меняется.
- Добавляются только **два написания одного порта** (`localhost` ↔ `127.0.0.1`);
  `::1` принимается как есть, без алиаса. Чужой (не-loopback) маркер не добавляет
  ничего. Это не послабление для чужих origin’ов и не расширение ACAO — алиас живёт
  только в проверке Origin (`allowedOrigins`, `request-origin.mjs:231`;
  `checkUpgradeOrigin`, `:283`), CORS-заголовки не расширяются.
- Упакованный прогон (`dist/`) и `--api-only` маркер не несут — их набор origin’ов
  никогда не расширяется. Лаунчер экспортирует `GENERAPTOR_DATA_DIR` в серверный
  дочерний процесс, чтобы каталог данных совпадал у обоих процессов.

### 2. Модульная карта

| Слой | Путь | Содержимое |
|---|---|---|
| Launcher | `start.mjs`, `server/lib/launcher-args.mjs`, `server/lib/data-dir.mjs`, `server/lib/db-bootstrap.mjs`, `server/lib/open-browser.mjs` | CLI, каталог данных, автосоздание схемы, автооткрытие браузера с токеном во фрагменте |
| HTTP | `server/express-app.mjs`, `server/routes/*` (11 монтирований: health, auth, articles, research-sources, cover-settings, api-keys, agent-roles, providers settings + catalog, yandex, web-search) | CORS, gate, Host/Origin, монтирование маршрутов, SPA-fallback |
| WS | `server/websocket.mjs` | `/ws`, проверка cookie на handshake, welcome `{type:'connected'}` |
| Воркер | `server/workers/article-generation.mjs` | конвейер 11 ролей, прогресс, бюджет попыток |
| Роли | `server/agent-role-data.mjs` (каталог), `agent-role-contracts.mjs`, `agent-role-execution.mjs` | контракты и исполнение ролей |
| Инфраструктура | `server/lib/*` (50+ модулей: queue-shim, auth, startup-token, providers, cover-store, cover-service, api-key-probe, article-*, web-search/*, research-*) | движок и обвязка |
| Поиск | `server/lib/web-search/*` (24 файла: 13 в корне слоя, включая `topic-match.mjs` и `redirect-unwrap.mjs`, + каталог `verticals/` из 11 модулей), `server/routes/web-search.mjs` | единый контракт веб-поиска, 7 бэкендов тира + 8 keyless-вертикалей, деградация вместо исключений |
| Безопасность | `server/lib/api-paths.mjs`, `server/lib/request-origin.mjs`, `server/lib/provider-url.mjs`, `server/lib/secret-store.mjs`, `server/lib/log-sanitize.mjs` | гейт доступа, Host/Origin, единая политика адресов и привязка ключей, шифрование ключей, санитизация логов |
| Гейты | `scripts/brand-gate.mjs`, `scripts/universal-gate.mjs` | бренд-гейт и гейт отраслевой нейтральности; оба — в CI и в `files` пакета |
| SPA | `src/` (React 18 + Vite 5): `app/AppShell.tsx`, `features/generation|history|settings|shared`, `components/` (`SessionGate.tsx` — автосессия, `TokenGate.tsx` — ручной фоллбэк, `CoverSettings.tsx` — панель «Генерация обложек», `ConfirmDialog.tsx` — непрозрачный диалог подтверждения), `lib/session.ts`, `hooks/` (`useApi.ts` — единый разбор плоского и вложенного конвертов ошибки), `i18n/`, `theme/`, `styles/` | оболочка UI: поле endpoint у custom/ollama, уточнения к теме на главной форме, 4 раздела настроек (Провайдеры → Модели → Генерация обложек → Роли), меню строки Истории с подтверждением удаления |
| Данные | `prisma/schema.prisma` (8 моделей), SQLite `generaptor.db` | миграций нет: схема развёртывается `prisma db push` при старте (`server/lib/db-bootstrap.mjs`) |

Требование к сборке пакета: `package.json` → `files` обязан перечислять
`scripts/brand-gate.mjs` и `scripts/universal-gate.mjs` — иначе установленный пакет
не сможет выполнить `npm run lint:universal` и `npm run lint:brand`.
Каталог `docs/` в поставку пакета не входит: документация публикуется вместе с
исходниками.

### 3. Поток генерации статьи

1. Composer (SPA) → `POST /api/articles` `{topic, targetLength, language?, userNotes?}`
   — валидация: тема 3–200 симв., объём из 7 значений 50–80 тыс. (шаг 5 тыс.),
   язык `ru|en`, заметки ≤1000 (`routes/articles.mjs:531`).
2. Clarify (SPA) → `POST /api/articles/:id/start` `{coverRequested?}` — допустимые
   статусы старта `draft|failed|stopped|needs_review`
   (`server/routes/articles.mjs:651`, `allowedStartStatuses`).
3. Воркер выполняет цепочку из 11 ролей; каждая роль пишет журнал `AgentRun`
   (status/progress/input/output/tokens/costRub/startedAt/finishedAt).
4. Прогресс доставляется двумя каналами: WS `/ws` и HTTP-поллинг
   `GET /api/articles/:id/progress` — SPA поллит с интервалом 3 с как fallback
   (`src/hooks/useWebSocketProgress.ts`, `POLL_INTERVAL_MS=3000`).
   В WS-кадре `status` — это статус **прогона**, а не статус роли: завершение роли
   приходит как `running` (`server/workers/article-generation.mjs:2076-2091`),
   терминальный кадр — `completed`/`needs_review` с `percent=100` и
   `currentStage=totalStages` (`server/lib/article-progress.mjs:1-27`). Клиент
   нормализует `needs_review` в `needs-review` (`src/hooks/progressStatus.ts`), так что
   «роль завершена» никогда не выглядит как конец прогона.
5. Postcheck (`lib/article-postcheck.mjs`) выносит вердикт (`ok|warn|fail`), и что
   с ним делать, задаёт env `POSTCHECK_MODE`: `report` (по умолчанию) — вердикт
   пишется в отчёт `AgentRun` и отдаётся в API как `postcheckVerdict`, а статус
   статьи постпроверкой не меняется (встречается `postcheckVerdict='fail'` при
   `status='ready'`); `enforce` — `verdict='fail'` переводит статью в
   `needs_review` с причиной «Качество: N проваленных правил (id, …)». Любое
   другое (в т.ч. пустое) значение env читается как `report`
   (`server/lib/article-postcheck.mjs:1889-1892`,
   `server/workers/article-generation.mjs:3162-3163`, `:3171-3172`).
6. Результат: `ArticleVersion` в трёх форматах (HTML/TXT/MD) + `characterCount`.
7. Обложка (опционально, отдельным потоком): `POST /api/articles/:id/cover`
   `{}` / `{refinement ≤500}` / `{fresh:true}` — поток НЕ меняет `Article.status`.

### 4. Хранилище

```
<data-dir>/                      (по умолчанию ~/.generaptor, режим 0700)
 ├─ generaptor.db                SQLite (Prisma), режим 0600
 ├─ provider-secrets.key         ключ шифрования ключей провайдеров, режим 0600
 └─ covers/
     └─ <articleId>-<n>.<ext>    png/jpg/webp/gif
```

- Каталог данных: `--data-dir` → `GENERAPTOR_DATA_DIR` → `~/.generaptor`
  (`server/lib/data-dir.mjs`). Явный `DATABASE_URL` из env имеет приоритет над
  авто-разрешением и не перезаписывается.
- Имена файлов обложек валидируются паттерном на каждом чтении — принадлежность
  статьи сверяется по UUID, выход из каталога невозможен (`server/lib/cover-store.mjs`).
- Права доступа: каталог данных — `0700`, файл БД — `0600`
  (`server/lib/data-dir.mjs:133`, `:197`, `:202`, `:211`; вызов при подключении —
  `server/db.mjs:38`). Это POSIX-семантика; на Windows вызовы `chmod` — best effort
  (`server/lib/data-dir.mjs:182-184`).
- `provider-secrets.key` — per-install ключ AES-256-GCM для шифрования ключей
  провайдеров; лежит рядом с файлом БД, создаётся атомарно, никогда не попадает в лог
  или в API (`server/lib/secret-store.mjs:42`, `:64`, `:124-133`).
- Обложки: каталог `covers/` создаётся с режимом `0700` (`COVERS_DIR_MODE`,
  `server/lib/cover-store.mjs:42`), каждый файл пишется с режимом `0600`
  (`COVER_FILE_MODE`, `:43`; запись — `:143`). После best-effort упрочнения
  расположение каталога данных перепроверяется, и если он остался неприватным,
  лаунчер печатает предупреждение (`dataDirPrivacyWarning`,
  `server/lib/data-dir.mjs:156`; вызов из `hardenDataPermissions`, `:217-218`).
- Удаление статьи каскадно удаляет версии, журнал `AgentRun` (SetNull) и файлы
  обложек (`removeArticleCovers`, `server/routes/articles.mjs:1162`; очистка не
  роняет маршрут — сбой логируется, `:1163-1165`).

### 5. Ролевой конвейер: 11 ролей

`server/agent-role-data.mjs` — ровно 11 ролей. Цепочка: `topic-selector → brief-preparer →
knowledge-base-curator → research-analyst → semantic-strategist → structure-architect →
article-author → factchecker → seo-reviewer → quality-controller → humanizer`.

Счёт ролей (11) зафиксирован и в комментариях серверного кода
(`server/routes/agent-roles.mjs:4`, `server/agent-role-execution.mjs:406`,
`server/lib/article-progress.mjs:17`, `server/lib/article-postcheck.mjs:60`,
`server/workers/article-generation.mjs:564`), и защищён от дрейфа регрессией
`tests/unit/role-count-drift.test.mjs`: рассинхрон комментария с числом ролей роняет
тесты, а не работу.

| Тир | Роли | |
|---|---|---|
| critical (4) | research-analyst, structure-architect, factchecker, quality-controller | строгие контракты |
| generation (5) | topic-selector, semantic-strategist, article-author, seo-reviewer, humanizer | синтез текста |
| standard (2) | brief-preparer, knowledge-base-curator | подготовка данных |

Промпты ролей отрасле-нейтральны: продукт пишет экспертные статьи для любого
бизнеса. Чистоту поставки от брендовых констант держит `npm run lint:brand`,
а отраслевую нейтральность —
постоянный гейт `npm run lint:universal` (`scripts/universal-gate.mjs:78`): он
сканирует поставляемый набор и падает на любом отраслевом токене вне объявленных
классов исключений (`scripts/universal-gate.mjs:144`); гейт встроен в CI
(`.github/workflows/ci.yml:66`). Редактирование промптов
пользователем — Settings → Роли →
`PUT /api/settings/agent-roles` (персистентность серверная).

### 6. Модель данных: 8 моделей

`prisma/schema.prisma` — 8 моделей:

| Модель | Назначение | Ключевые поля |
|---|---|---|
| `Article` | статья | topic, target_length, language (default `ru`), user_notes ≤1000, status, cover_* (9 полей), needs_review_reason |
| `ArticleVersion` | версии результата | contentHtml/contentText/contentMarkdown, characterCount, platform; cascade delete |
| `AgentRun` | журнал этапов | agentName, status, progress, input/output (JSON), tokens, costRub, startedAt/finishedAt; onDelete SetNull |
| `CoverSettings` | настройки обложек (одна строка) | model `qwen/qwen-image-2.1-pro`, compressionModel (NULL = тиры), promptTemplate, aspectRatio 16:9, resolution, quality, outputFormat |
| `AgentRoleSetting` | переопределения промптов ролей | roleId, systemPrompt |
| `ResearchSource` | источники для заземления фактов | url, заголовок, фрагменты |
| `CompanyProfile` | профиль автора | минимальный однострочный |
| `ProviderConfig` | провайдеры и ключи | kind, enabled, apiKey (шифротекст AES-256-GCM), baseUrl (у фиксированных видов всегда `null`), models |

Реестр сайтов-источников (`server/source-registry.mjs`) поставляется пустым: свой
набор сайтов настраивает пользователь; без записей слой заземления вырождается в
общий веб-поиск (§10). Отраслевых research-клиентов нет — слой
заземления работает в общем виде.

Свой набор сайтов регистрирует деплой — через env `GENERAPTOR_SOURCE_REGISTRY`
(`source-registry.mjs:38`): это путь к JSON-файлу (абсолютный или от текущего
каталога, `source-registry.mjs:96-100`). Файл читается один раз при старте, поэтому
изменения подхватываются рестартом (`source-registry.mjs:9`, `:127`). Формат —
массив записей (или объект с полем `sites`); у записи обязательны `id` и `baseUrl`,
необязательны `name`, `doctorsIndex`, `servicesIndex`, `prices`, `llms`, `sitemap`
(либо готовый массив `core`) — `server/source-registry.mjs:13-24`, `:66-85`; записи без
`id`/`baseUrl` отбрасываются (`:71-73`).

Домены зарегистрированных сайтов считаются «своими»: подходит только точное совпадение
host (после lower-case и снятия ведущего `www.`, без suffix-match —
`lib/source-domains.mjs:17-19`), и такие результаты поднимаются до
`evidenceLevel: 'canon'` с `metadata.isOwn` (`lib/source-domains.mjs:5-8`).
Отсутствующий или битый файл реестра не ломает конвейер: реестр остаётся пустым, всё
остаётся внешним свидетельством, research-слой деградирует до обычного веб-поиска
(`server/source-registry.mjs:101-119`, `server/lib/source-domains.mjs:12-15`).

### 7. Обложки (отвязка от WordPress)

- Генерация: `server/lib/cover-service.mjs` — провайдер с поддержкой изображений
  (capability-гейт, `resolveCoverProvider()`), семантика уточнения = регенерация
  с уточняющим промптом, `fresh` сильнее.
- Хранение: `server/lib/cover-store.mjs` — файловая система data-dir, без WordPress.
- Отдача: `GET /api/articles/:id/cover` — бинарный маршрут (`server/routes/articles.mjs:1185`),
  `Cache-Control: no-store`; 404 `cover_not_found` / 500 `cover_read_failed`.
- Коды ошибок (`cover-service.mjs:61`): `cover_invalid_article_id` 400,
  `cover_invalid_refinement` 400 (≤500 симв.), `cover_generation_failed` 502,
  `cover_not_configured` 503, `cover_provider_images_unsupported` 503.
- Поток обложек никогда не пишет `Article.status`.
- Автопубликация в WordPress/Telegram — вне скоупа GeneRaptor: публикующих
  модулей и их env-блока в поставке нет.

### 8. HTTP-поверхность

Public (до гейта): `GET /api/health` (`routes/health.mjs:46` — SELECT 1, `ok|degraded`,
конфиг-блок без секретов); `POST /api/auth/exchange`, `GET /api/auth/status`,
`POST /api/auth/logout` (`routes/auth.mjs`).

Гейт решает по **исходному пути запроса без учёта регистра**
(`server/lib/api-paths.mjs:41`, `:53`, `:71`; `server/lib/auth.mjs:181`), поэтому
`/API/articles` защищён так же, как `/api/articles`; публичными остаются ровно четыре
пути из `PUBLIC_API_PATHS` (`server/lib/api-paths.mjs:22-27`).

Перед гейтом стоит проверка Host/Origin (`express-app.mjs:110-130`): чужой Host →
`403 Запрещённый Host` (`:114`), изменяющий запрос под `/api` с чужим
Origin/Referer → `403 Запрещённый Origin` (`:124-125`); правила — в
`server/lib/request-origin.mjs:43`, `:83`, `:117`, `:231`, `:261`. WS-upgrade
проверяет Origin первым (`server/express-app.mjs:251`).

| Метод и путь | Файл:строка | Назначение |
|---|---|---|
| GET `/api/articles` | `routes/articles.mjs:404` | список (история) |
| POST `/api/articles` | `:531` | создание (валидация выше) |
| POST `/api/articles/:id/start` | `:630` | запуск генерации |
| POST `/api/articles/:id/stop` | `:735` | остановка |
| GET `/api/articles/:id` | `:790` | карточка |
| GET `/api/articles/:id/progress` | `:824` | прогресс (fallback WS) |
| GET `/api/articles/:id/content` | `:877` | три формата текста |
| PUT `/api/articles/:id/content` | `:981` | правка результата |
| GET `/api/articles/:id/details` | `:1057` | детали + журнал |
| DELETE `/api/articles/:id` | `:1145` | удаление (+обложки) |
| GET `/api/articles/:id/cover` | `:1185` | бинарная обложка |
| POST `/api/articles/:id/cover` | `:1233` | генерация/уточнение/fresh |
| GET/PUT `/api/settings/cover` | `routes/cover-settings.mjs:37,92` | настройки обложек |
| GET `/api/settings/api-keys`, POST `…/test` | `routes/api-keys.mjs:77,114` | статус ключей + пинг |
| GET/PUT/DELETE `/api/settings/agent-roles[/:roleId]` | `routes/agent-roles.mjs:54,82,141` | каталог/переопределения ролей |
| GET/PUT `/api/settings/providers/:kind`, POST `…/test` | `routes/providers.mjs:55,78,116` | настройки провайдеров |
| GET `/api/providers/:kind/models` | `routes/providers.mjs:217` | каталог моделей |
| GET `/api/search/backends` | `routes/web-search.mjs:86` | каталог бэкендов поиска и их состояние |
| POST `/api/search/search` | `routes/web-search.mjs:106` | веб-поиск (всегда 200, деградация в теле ответа) |
| POST `/api/search/probe` | `routes/web-search.mjs:145` | проверка бэкенда и его ключа |
| POST `/api/yandex/search` | `routes/yandex-search.mjs:23` | legacy-маршрут поиска |

Прочее: `/api/*` → JSON 404; статика `dist/` + SPA history-fallback (когда собрано).

### 9. Слой провайдеров

`server/lib/providers.mjs` — 4 OpenAI-совместимых вида:

| kind | адрес (baseUrl) | env-ключ | ключ обязателен | images |
|---|---|---|---|---|
| `routerai` | фиксированный `https://routerai.ru/api/v1` | `ROUTERAI_API_KEY` | да | yes |
| `openrouter` | фиксированный `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | да | unknown |
| `ollama` | `http://localhost:11434/v1` по умолчанию; свой адрес — только через policy (loopback разрешён для `ollama`) | `OLLAMA_API_KEY` | нет | no |
| `custom` | задаётся пользователем: только `http`/`https`, без учётных данных в URL и без приватных адресов | `CUSTOM_API_KEY` (игнорируется — env-ключ не привязан к `custom`) | нет | unknown |

- Активный провайдер: единственная включённая строка `ProviderConfig`; иначе env-routerai
  (`ROUTERAI_API_KEY` + `ROUTERAI_MODEL_CRITICAL/GENERATION/STANDARD`); движок получает
  дескриптор через `resolveActiveProviderForEngine()` — никогда не бросает исключение.
- Ключи: источник определяется адресом, к которому ключ привязан (ниже), — env
  **не** выигрывает над локальным хранилищем автоматически; наружу отдаётся только
  маска, `keyConfigured/keySource` и `imagesCapability` (`toPublicProvider()`).
- **Единая точка разрешения адреса.** Исходящий URL провайдера определяется и
  проверяется только в `server/lib/provider-url.mjs`: `resolveProviderTarget()` — `:271`,
  `resolveProbeEndpoint()` — `:336`. Схема — только `http`/`https`, учётные данные в
  URL запрещены (`parseProviderBaseUrl()`, `:127`), приватные/loopback/link-local/CGNAT
  и metadata-адреса блокируются, если оператор не выставил
  `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (`:67`, `:72`, `:101`, `:198`).
  Для `routerai`/`openrouter` адрес неизменен (`FIXED_PROVIDER_KINDS`, `:49`), а
  `baseUrl` в базе всегда `null` (`server/lib/providers.mjs:546`).
- **Ключ привязан к своему адресу.** `bindProviderKey()`
  (`server/lib/provider-url.mjs:239`) выбирает ключ по источнику адреса: env-ключ уходит
  только на адрес, заданный оператором (стандартный `:260` или env-переопределение
  `:256`), на пользовательский (`stored`) — только сохранённый ключ (`:250`), а kind
  `custom` никогда не получает env-ключ (`:245`).
- Отклонённый адрес не превращается в исходящий запрос: каталог моделей отвечает
  `502 provider_endpoint_rejected` без обращения к провайдеру
  (`server/routes/providers.mjs:237-242`), пинг провайдера помечается `warning` и
  проверку не выполняет (`:153-162`).
- Модели по тирам: `critical|generation|standard|cover` (`parseProviderModels`).
- Пинг: `POST /api/settings/api-keys/test` → уровень `ok|warning|error`
  (`lib/api-key-probe.mjs`; ключ никогда не попадает в ответ/лог).
- Обложки требуют images-capability: `resolveCoverProvider()` иначе
  `cover_provider_images_unsupported` — UI показывает честную недоступность.
- Исходящие запросы к поисковым бэкендам: User-Agent берётся из единственного
  источника `server/lib/research-user-agent.mjs` (`researchUserAgent(scope)`) —
  единый UA-контракт исполняется во всех бэкендах общего поискового слоя и во всех
  keyless-вертикалях
  (`server/lib/web-search/tavily.mjs:129`, `server/lib/web-search/serper.mjs:107`,
  `server/lib/web-search/verticals/http.mjs:38`).


### 10. Слой веб-поиска

Основной движок — Serper.dev, фоллбек — Tavily free; факты берутся из общего поискового слоя
`server/lib/web-search/*` (24 файла: 13 в корне слоя, включая `topic-match.mjs` и
`redirect-unwrap.mjs`, и каталог `verticals/` из 11 модулей). Единый контракт:

`searchWeb(options = {})` (`server/lib/web-search/index.mjs:255`) возвращает
`{results, backend, degraded, reason, lang, limit, attempts}` и **никогда не бросает
исключение**: отказ любого бэкенда даёт пустой результат с `degraded: true` и кодом
причины из закрытого списка (`server/lib/web-search/errors.mjs:9`) — `empty_query`,
`not_configured`, `keyless_unavailable`, `network_unavailable`, `timeout`, `blocked`,
`quota_exhausted`, `http_error`, `invalid_response`, `internal_error`. HTTP 402 и 429
маппятся в `quota_exhausted`, 401/403 — в `not_configured`, сеть/таймаут — в
`network_unavailable`/`timeout`. Каждый элемент `results` несёт необязательный
`provider` — id бэкенда-источника; `attempts` включает пробы вертикалей.

Поток выдачи: **цепочка бэкендов → нормализация (в т.ч. развёртка redirect-обёрток)
→ дедуп → БД**. Единая точка политики обёрток — нормализация
`normalizeSearchResults` (`server/lib/web-search/http.mjs:80-107`): каждый результат
проходит развёртку известных обёрток (`google/url?q=`, `google/goto?url=`,
`bing/ck/a?u=`, `ddg/l/?uddg=`; таблица правил —
`server/lib/web-search/redirect-unwrap.mjs:47-58`) через чистый модуль
`server/lib/web-search/redirect-unwrap.mjs` (без сети) — **до** дедупликации
(`mergeResults`, `server/lib/web-search/index.mjs:409-420`) и **до** записи в БД
(`server/workers/article-generation.mjs:1400-1406`); неразворачиваемая обёртка
отбрасывается. Это необходимо, потому что `canonicalSignature`
(`server/lib/url-normalize.mjs:42-66`) отбрасывает query: без развёртки все обёртки
одного вида схлопываются в одну ссылку (`https://google.com/goto`) и N источников
теряются молча. Фактическая ёмкость выдачи Serper — 10 результатов
(`SERPER_MAX_RESULTS`, `server/lib/web-search/serper.mjs:51`; тело запроса —
`:109-114`), публичный `limit` слоя и маршрута (25) не меняется. Итерация
консенсуса, не давшая ни одной новой ссылки, останавливает расширение
(`splitNewSources`, `server/workers/article-generation.mjs:109-119`; условие остановки
— `:1441-1448`), поэтому повторный запрос того же бэкенда больше не жжёт квоту и не
плодит дубли в консенсусе.

| Бэкенд | Ключ | В авто-цепочке | Адрес и примечание |
|---|---|---|---|
| `serper` | `GENERAPTOR_SERPER_API_KEY` | да — основной движок | `https://google.serper.dev/search` (`web-search/endpoints.mjs:14`); бесплатный ключ без карты, стартовый пакет 2500 запросов (периодичность сгорания пакета сайтом не опубликована); фактический потолок выдачи — 10 результатов, пагинация не поддерживается |
| `tavily` | `GENERAPTOR_TAVILY_API_KEY` | да — фоллбек | `https://api.tavily.com/search` (`web-search/endpoints.mjs:11`); бесплатный ключ — 1000 кредитов/мес (подтверждено docs.tavily.com) |
| `tavily-keyless` | не нужен | да | тот же адрес + заголовок `X-Tavily-Access-Mode: keyless`; с части хостов провайдер отдаёт 403, а отказ бесключевого режима распознаётся и по телу ответа (инструкция «зарегистрируйся / получи ключ») — цепочка честно деградирует дальше (`keyless_unavailable`) |
| `wikipedia` | не нужен | да | MediaWiki Action API по языку `ru|en` (`web-search/endpoints.mjs:28`) |
| `wikidata` | не нужен | да | `https://www.wikidata.org/w/api.php` (`web-search/endpoints.mjs:30`) |
| `yandex` | `GENERAPTOR_YANDEX_API_KEY` | нет | платный, только по явному выбору (`web-search/endpoints.mjs:17`) |
| `duckduckgo` | не нужен | нет | неофициальный скрейпинг, только opt-in (`web-search/endpoints.mjs:54`) |

Отдельно от тира — восемь keyless-вертикалей: OpenAlex (наука и публикации),
Crossref (DOI и издания), Europe PMC (биомедицина), GDELT (мировые новости, окно
~3 мес), Nominatim (геокодирование, 1 rps), OpenLibrary (книги, 1 rps), Stack Exchange
(QA; без ключа 300 запросов/сутки на IP — подтверждено живым ответом, с
зарегистрированным ключом 10 000/сутки — официально), Hacker News. Вертикали
подключаются по совпадению темы (`server/lib/web-search/topic-match.mjs`: маркерная
таблица RU/EN, скоринг «сильный +2 / слабый +1», порог ≥2 — `:35`, кап 2 вертикали на
запрос — `:38`, только первая страница — `web-search/index.mjs:447`); их
результаты **добавляются** к основным с дедупликацией по нормализованному URL
(`mergeResults`, `web-search/index.mjs:409`); каждый источник соблюдает
общий `limit` (вертикаль ≤ min(limit, 3), объединённый список ограничен
`web-search/index.mjs:108-113`); деградация вертикали — пропуск с пометкой
в `attempts`, основной ответ не ломается (`runVerticalStage`,
`web-search/index.mjs:433`). В каталоге бэкендов вертикали помечены
`official: true, requiresKey: false` (`server/lib/web-search/verticals/index.mjs:53-74`)
и не предлагаются селектом как основной движок; новых env-переменных нет.

- Авто-цепочка: `serper → tavily → tavily-keyless → wikipedia → wikidata`
  (`AUTO_SEARCH_CHAIN`, `web-search/index.mjs:79-83`) — работает первый
  бэкенд массива, у которого есть ключ (`getAutoSearchChain`, `:192`); при пустом
  окружении остаётся keyless-хвост (Tavily без ключа → Википедия → Викиданные,
  `KEYLESS_SEARCH_CHAIN`, `:62`); бэкенд по умолчанию без ключа — по-прежнему
  `tavily-keyless` (`DEFAULT_SEARCH_BACKEND`, `:86`).
- Явно выбранный бэкенд: в `auto` подставляется первый ключевой по порядку цепочки;
  при явном выборе бэкенд пробуется первым и другой ключевой провайдер молча не
  подставляется — keyless-хвост остаётся запасным путём
  (`server/lib/web-search/index.mjs:284-290`).
- HTTP-поверхность: `GET /api/search/backends`, `POST /api/search/search`,
  `POST /api/search/probe` (`server/routes/web-search.mjs:86`, `:106`, `:145`).
  Проба ограничена cooldown 30 с (`PROBE_COOLDOWN_MS`, `server/routes/web-search.mjs:40`)
  и выполняется только для ключевых бэкендов — вертикали не пробируются
  (`PROBEABLE_BACKENDS`, `:30`). `POST /api/search/search` отвечает 200 всегда —
  деградация закодирована в теле ответа (`degraded`, `reason`, `attempts`).
- Адреса зафиксированы в коде: пользовательский адрес провайдера в поисковый слой не
  передаётся (`server/lib/web-search/index.mjs:331-332`); ключ Serper уходит только на
  `https://google.serper.dev/search`; правило привязки ключа к адресу продолжает действовать — ключ
  бэкенда уходит только на стандартный адрес этого бэкенда.
- Выбор бэкенда хранится в браузере (`src/features/settings/helpers/searchSources.ts:14`)
  и применяется к запросам поиска; ключи бэкендов в UI не вводятся — только env.
  Вертикали в селект основного движка не входят — блок настроек показывает их как
  «используется автоматически по совпадению темы».
- Воркер генерации оборачивает вызов поиска в try/catch: сбой поиска не роняет
  генерацию, а превращается в предупреждение воркера; без источников блок
  «Внешние источники» не выводится. Провайдер источника берётся из per-item
  `provider` результата (`researchProviderFor`,
  `server/workers/article-generation.mjs:294-301`; применение — `:1322`, `:1382`),
  а не приписывается бэкенду тира.

### 11. Аутентификация и сеть

- Токен запуска: `server/lib/startup-token.mjs` — CSPRNG 32 байта, base64url 43 симв.,
  окно 15 мин, single-use; `--token` = фиксированный многоразовый; `--no-auth` = гейт
  выключен (громкое предупреждение). Обмен: `POST /api/auth/exchange` → HMAC-cookie
  `generaptor_auth` (httpOnly, SameSite=Lax, secure в production), rate limit 5/15 с на IP.
- WS: cookie проверяется на handshake (`verifyWsConnection` → 401), Origin проверяется
  первым (`server/express-app.mjs:255-260`).
- Биндинг: по умолчанию `127.0.0.1` (`GENERAPTOR_HOST`,
  `server/lib/launcher-args.mjs:424`); `--host` **без значения** — ошибка
  использования (`:48`, `:62-79`), наружу попадают только явным `--host 0.0.0.0`.
  Trust proxy удалён — спуф `X-Forwarded-For` ломал бы per-IP лимит.
- Баннер печатает **фактически занятый** адрес из `server.address()`
  (`server/index.mjs:29-34`) и для сетевого bind — предупреждение
  `NETWORK-REACHABLE` (`server/index.mjs:75-82`,
  `server/lib/launcher-args.mjs:475`).
- Host/Origin: см. §8 — чужой Host и Origin/Referer на изменяющих запросах
  отклоняются с `403` (`server/lib/request-origin.mjs:117`, `:231`, `:261`).
- Dev-алиас Origin: в dev-топологии лаунчер передаёт серверу маркер
  `--dev-ui-origin`, и проверка Origin принимает оба loopback-написания одного
  порта Vite. Решение — топология лаунчера, не `NODE_ENV`; приёмка fail-closed,
  ACAO не расширяется. Полный поток — §1.1.
- CORS: `CORS_ORIGIN` (default `http://localhost:5173`), credentials, ограниченные
  заголовки. `trust proxy` см. выше. В dev-режиме лаунчер задаёт
  `CORS_ORIGIN` под фактический UI-origin (`http://<bindHost>:<uiPort>`), **только**
  если оператор не задал его явно, и только когда UI действительно отдельный
  origin (не `--api-only`, не собранный prod). Иначе обмен через Vite-прокси
  получил бы 403: браузер шлёт `Origin: http://127.0.0.1:5173`, а дефолтный
  whitelist знает только `localhost` (`start.mjs`, зона после `devUiUrl`).
- Порядок монтирования: cookieParser → health → auth → requireGate → остальные `/api`.
- Автосессия без ввода токена: лаунчер определяет, где реально живёт UI
  (`resolveUiAvailability`), ждёт готовности UI (poll 2xx, до 60 с) и сам открывает
  браузер адресом `<uiUrl>/#token=<одноразовый токен>`
  (`server/lib/open-browser.mjs`: `shouldAutoOpenBrowser` — чистое решение,
  `buildAutoOpenUrl`, `openBrowser` — spawn без shell, `waitForUiReady`).
  Guards: `--no-browser`, `NODE_ENV=test`, `CI`, не-TTY stdout, фиксированный
  токен (`--token`), недоступный UI. Сбой → печать чистого URL, лаунчер не падает.
  Клиент: `src/lib/session.ts` (строгий парсинг `#token=`, `replaceState`,
  exchange, проба статуса по телу) + `src/components/SessionGate.tsx` (фазы
  `exchanging`/`hint`/`manual`; ручной `TokenGate` — только вторичный фоллбэк).
  `GET /api/auth/status` при выключенном гейте отвечает `{authenticated:true}`.
  Последовательность: свежий старт → токен во фрагменте → проба статуса →
  ровно один обмен → cookie → адрес очищен → оболочка приложения.

**Поток «лаунчер → браузер → обмен → сессия → приложение» и его ветки ошибок.**

| Шаг | Что происходит | Ветка ошибки | Код |
|---|---|---|---|
| 1. Токен | лаунчер генерирует одноразовый токен (CSPRNG, 32 байта → base64url, 43 символа) и передаёт его серверному процессу через `GENERAPTOR_STARTUP_TOKEN` | — | `server/lib/startup-token.mjs:31-33`, `start.mjs:435-437` |
| 2. Баннер | токен печатается в терминал ровно один раз: `[Auth] token: …` + «ONE-TIME: single use, valid for 15 min» | — | `server/lib/launcher-args.mjs:239-260`, `start.mjs:559-567` |
| 3. Решение | `shouldAutoOpenBrowser` решает, открывать ли браузер: `--no-browser` → `NODE_ENV=test` → `CI` → не-TTY stdout → фиксированный `--token` → UI не раздаётся | решение просто «нет»: лаунчер продолжает работу, автооткрытие не происходит | `server/lib/open-browser.mjs:28-45`, `start.mjs:575-582` |
| 4. Готовность UI | poll `GET <uiUrl>` до 2xx, максимум 60 с | UI не поднялся → печатается чистый URL, лаунчер не падает | `server/lib/open-browser.mjs:98-115`, `start.mjs:589-597` |
| 5. Открытие | `cmd.exe /c start "" <url>` (Windows), `open` (macOS), `xdg-open` (Linux), `shell:false`, `detached` | spawn не удался → печатается чистый URL **без токена** | `server/lib/open-browser.mjs:68-87` |
| 6. Разбор фрагмента | клиент принимает только строгий `#token=<base64url>` из собственного адреса | нет фрагмента → подсказка «перезапустите студию» | `src/lib/session.ts:14-20`, `src/components/SessionGate.tsx:99-104` |
| 7. Проба статуса | `GET /api/auth/status`: сессия уже есть (другая вкладка успела) → токен **не тратится**, фрагмент убирается | сервер недоступен → идём к обмену | `src/lib/session.ts:44-49`, `src/components/SessionGate.tsx:108-120` |
| 8. Обмен | ровно один `POST /api/auth/exchange` с `Authorization: Bearer <token>` | 401 → фрагмент убирается, повторная проба статуса, иначе подсказка «стартовая ссылка устарела»; 429 → фрагмент остаётся, отсчёт по `Retry-After`, не более двух автоповторов; 5xx/сеть → подсказка «сервер недоступен», фрагмент остаётся | `src/lib/session.ts:32-37`, `src/components/SessionGate.tsx:121-157` |
| 9. Гейт на сервере | лимит 5 попыток / 15 с / IP проверяется **до** гейта → 429 + `Retry-After` (попытка не тратится); гейт одноразовый → второй обмен 401 | 401 → `Токен не принят` | `server/routes/auth.mjs:103-128`, `server/lib/startup-token.mjs:75-83` |
| 10. Сессия | cookie `generaptor_auth` (httpOnly, `SameSite=Lax`, path `/`), фрагмент убран из адреса и из записи истории, монтируется оболочка приложения | — | `server/routes/auth.mjs:88-97`, `src/lib/session.ts:27-29` |

- Честные границы: per-request CSRF-токена нет — защита = `SameSite=Lax` +
  сторож `Origin`/`Referer` + CORS. Дефолт `CORS_ORIGIN=http://localhost:5173`
  доверяет локальному origin во всех режимах (pre-existing принятый риск:
  страница на `localhost:5173` может сжигать лимит обмена и, будучи same-site с
  `localhost:8787`, слать credentialed state-changing запросы; follow-up —
  «same-origin only в prod»). Оболочка ≠ сессия: авторизацию доказывает только
  серверный ответ на защищённый запрос. Автообмен — ровно один запрос на mount
  (отмена локальна для эффекта, StrictMode не удваивает обмен); автоповторы
  при 429 ограничены двумя, после потолка — статичная подсказка и ручной
  «Обновить». Токен виден во фрагменте адреса только до обмена. Cookie
  сессии stateless (`exp` + HMAC, `server/lib/auth.mjs:107-121`): выход
  (`POST /api/auth/logout`) очищает cookie в браузере, но серверного списка
  отзыва нет — скопированное до выхода значение остаётся действующим до
  истечения срока.

### 12. Поверхность конфигурации

Env (`.env` / переменные): `DATABASE_URL`, `GENERAPTOR_DATA_DIR`, `GENERAPTOR_API_PORT`
(8787), `CORS_ORIGIN`, `COOKIE_SECURE`, `GENERAPTOR_UTM_ENABLED` (UTM-разметка внешних
ссылок, по умолчанию выкл.), `GENERAPTOR_TOKEN`, `GENERAPTOR_TOKEN_TTL`,
`GENERAPTOR_STARTUP_TOKEN`, `ACCESS_GATE_DISABLED`, `GENERAPTOR_HOST`, ключи провайдеров
(`ROUTERAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`, `CUSTOM_API_KEY`, baseUrl и
tier-модели), поисковые переменные (`GENERAPTOR_SEARCH_BACKEND` — `auto|tavily|
tavily-keyless|serper|yandex|wikipedia|wikidata|duckduckgo`, `GENERAPTOR_SEARCH_LANG` —
`ru|en`, `GENERAPTOR_SEARCH_TIMEOUT_MS`, `GENERAPTOR_TAVILY_API_KEY`,
`GENERAPTOR_SERPER_API_KEY`, `GENERAPTOR_YANDEX_API_KEY`; подробно — §10),
`GENERAPTOR_SOURCE_REGISTRY` (путь к JSON-файлу реестра собственных сайтов — см. §6),
`GENERAPTOR_ALLOW_PRIVATE_NETWORK` (`true` — разрешить приватные/loopback-адреса
провайдеров; по умолчанию выключено, `server/lib/provider-url.mjs:67`),
`POSTCHECK_MODE` (режим постпроверки качества: `report` — по умолчанию, вердикт
только записывается, а статус статьи постпроверкой не меняется; `enforce` —
`verdict='fail'` переводит статью в `needs_review`; см. §3,
`server/lib/article-postcheck.mjs:1889-1892`).
Префикс `GENERAPTOR_*` обязателен; legacy-алиасов нет.

Локальные настройки (SQLite, редактируются UI): `ProviderConfig` (провайдеры, ключи,
модели, адрес custom/ollama), `CoverSettings` (обложки), `AgentRoleSetting` (промпты
ролей). Env **не** выигрывает над локальным хранилищем автоматически: ключ выбирается
по адресу, к которому он привязан — см. §9. `CoverSettings.model` — единственный
источник правды для модели обложки: строка уровня `cover` в «Моделях» — read-only
производная, перечитывается после сохранения панели «Генерация обложек».
Лаунчер экспортирует `GENERAPTOR_DATA_DIR` в серверный дочерний процесс,
чтобы оба процесса разрешали один каталог данных.

`.env.example` содержит только переменные, которые читает поставляемый код,
все значения пустые.

### 13. i18n и темы

- Каркас: `src/i18n/`, `src/theme/`
  (light/auto/dark, `data-theme` на `<html>`, auto = без атрибута),
  токены `src/styles/tokens.css` (4px-сетка).
- Словарь RU/EN, палитра
  light+dark с измеренным WCAG-контрастом, inline-bootstrap в `index.html` без FOUC,
  grep-gate «без кириллицы вне словаря».
- Шрифт — **системный стек** без внешних загрузок
  (`--font-sans`: Segoe UI Variable Text / Segoe UI / system-ui; `--font-mono`:
  Cascadia Mono / Consolas — `src/styles/tokens.css:45-46`), единая типографическая
  шкала и кривая движения (`--ease`, `--duration-hover|menu|enter` — `:66-69`),
  один набор линейных иконок (lucide-react), панель обложек на дизайн-токенах,
  непрозрачный диалог подтверждения отдельным слоем (`src/components/ConfirmDialog.tsx`).
  Внешних шрифтовых запросов нет — текст рендерится заданным лицом без FOUT.

---

## EN — Implemented architecture (mirror)

> Status: this document describes the current GeneRaptor release — the single-node
> topology, the identifier contract (cookie `generaptor_auth`, env `GENERAPTOR_*`,
> empty source registry), the `lint:brand` and `lint:universal` gates in CI, a
> case-insensitive access gate, one provider-endpoint policy with key-to-endpoint
> binding, at-rest encryption of provider keys, Host/Origin validation, a loopback
> default bind, explicit POSIX modes for the data dir and a CI dependency-audit gate.
> All claims verified against code; `file:line` paths are repo-relative.

### 1. Process layout

One Node process per app — a single-node topology with no external services:

```
npm start (start.mjs)
 ├─ resolveDataDir() → ~/.generaptor (or --data-dir / GENERAPTOR_DATA_DIR)
 ├─ ensureDatabaseSchema() → prisma db push (zero-byte DB file recreated)
 ├─ launch flags: --token, --token-ttl, --no-auth, --host (server/lib/launcher-args.mjs),
 │    --port, --api-only, --no-browser (start.mjs)
 ├─ spawn: node server/index.mjs   — API process:
 │    Express (express-app.mjs) + WebSocket /ws (websocket.mjs)
 │    + in-process generation worker (workers/article-generation.mjs)
 │    + boot-sweep of stale jobs (lib/stale-job-sweep.mjs)
 ├─ spawn: vite dev (5173) OR serving dist/ from the same API process (8787, prod)
 └─ token banner (exactly once) → UI readiness poll → auto-open the browser
      at <uiUrl>/#token=<one-time token> (server/lib/open-browser.mjs; guards:
      --no-browser / NODE_ENV=test / CI / non-TTY / fixed token / no UI)
```

- `start.mjs` is the single opensource-CLI entry: resolves the data dir, prepares the
  DB, prints the token and URLs, serves the SPA. An explicit `DATABASE_URL` from env is
  never rewritten.
- Flags are parsed **before** bootstrap: `--host` without a value (and `--host=`) is a
  usage error — the process prints `[ERROR] …` and exits with code 1
  (`server/lib/launcher-args.mjs:48`, `:62-79`; `start.mjs:385-395`).
- The generation worker is embedded in the API process (`createArticleGenerationWorker()`
  in `server/express-app.mjs`); there is no separate `npm run worker` script in
  GeneRaptor — a second server copy would race on the one queue.
- Graceful shutdown: SIGTERM/SIGINT → `server.close → worker.close → closeQueues →
  disconnectDB`, forced after 15 s (`server/express-app.mjs`); the launcher kills
  children 3 s after the signal (`start.mjs`).
- Queue is `server/lib/queue-shim.mjs`: in-process FIFO, concurrency 1, no persistence,
  no retries. `Article.status` in SQLite is the source of truth.

#### 1.1. Dev topology and the trusted-Origin marker

```
launcher (start.mjs)
 ├─ resolveDevUiOrigin({useProdBuild, apiOnly, hostForUrl, uiPort})
 │    → topology marker: http://<loopback>:<uiPort> OR null
 │    (server/lib/launcher-args.mjs:197; call site — start.mjs:487)
 ├─ spawn Vite dev-UI on <uiPort> (the browser opens localhost OR 127.0.0.1)
 └─ spawn API: node server/index.mjs --dev-ui-origin <origin>
      (devUiOriginArgs, launcher-args.mjs:218; start.mjs:507 —
       outside the dev topology the fragment is EMPTY, no flag in argv)
        └─ the server reads the marker once (express-app.mjs:83)
             ├─ HTTP guard of state-changing /api requests (express-app.mjs:119)
             └─ WS handshake (express-app.mjs:255)
```

- The decision is the **launcher topology**, never `NODE_ENV`: even with
  `NODE_ENV=production` in `.env` the launcher still starts Vite (no `dist/`),
  so a `NODE_ENV`-based rule produced a false 403 «Запрещённый Origin».
- Marker acceptance is **fail-closed** (`devUiOrigins`, `server/lib/request-origin.mjs:180`):
  exactly one origin; `http`/`https` scheme; a loopback host (`127.0.0.1` / `localhost` /
  `::1`); an **explicit** port (implicit 80/443 refused); authority only (a path, query,
  fragment or credentials → the marker is ignored). An invalid marker → `[]`, the
  allowed origin set stays unchanged.
- Only the **two spellings of the same port** are added (`localhost` ↔ `127.0.0.1`);
  `::1` is accepted as itself, no alias. A foreign (non-loopback) marker adds nothing.
  This is not a relaxation for foreign origins and does not widen ACAO — the alias
  lives only in the Origin check (`allowedOrigins`, `request-origin.mjs:231`;
  `checkUpgradeOrigin`, `:283`); CORS headers are not widened.
- A packaged run (`dist/`) and `--api-only` carry no marker — their origin set is
  never widened. The launcher exports `GENERAPTOR_DATA_DIR` to the server child
  so both processes resolve the same data directory.

### 2. Module map

| Layer | Path | Contents |
|---|---|---|
| Launcher | `start.mjs`, `server/lib/launcher-args.mjs`, `server/lib/data-dir.mjs`, `server/lib/db-bootstrap.mjs`, `server/lib/open-browser.mjs` | CLI, data dir, auto schema, browser auto-open with the token in the fragment |
| HTTP | `server/express-app.mjs`, `server/routes/*` (11 mounts: health, auth, articles, research-sources, cover-settings, api-keys, agent-roles, providers settings + catalog, yandex, web-search) | CORS, gate, Host/Origin, route mounting, SPA fallback |
| WS | `server/websocket.mjs` | `/ws`, cookie check on handshake, welcome `{type:'connected'}` |
| Worker | `server/workers/article-generation.mjs` | 11-role pipeline, progress, attempt budget |
| Roles | `server/agent-role-data.mjs` (catalog), `agent-role-contracts.mjs`, `agent-role-execution.mjs` | role contracts and execution |
| Infrastructure | `server/lib/*` (50+ modules: queue-shim, auth, startup-token, providers, cover-store, cover-service, api-key-probe, article-*, web-search/*, research-*) | engine and glue |
| Search | `server/lib/web-search/*` (24 files: 13 at the layer root, including `topic-match.mjs` and `redirect-unwrap.mjs`, plus the `verticals/` directory of 11 modules), `server/routes/web-search.mjs` | one web-search contract, 7 tier backends + 8 keyless verticals, degradation instead of exceptions |
| Security | `server/lib/api-paths.mjs`, `server/lib/request-origin.mjs`, `server/lib/provider-url.mjs`, `server/lib/secret-store.mjs`, `server/lib/log-sanitize.mjs` | access gate, Host/Origin, one endpoint policy with key binding, key encryption, log sanitisation |
| Gates | `scripts/brand-gate.mjs`, `scripts/universal-gate.mjs` | brand gate and domain-neutrality gate; both in CI and in the package `files` |
| SPA | `src/` (React 18 + Vite 5): `app/AppShell.tsx`, `features/generation\|history\|settings\|shared`, `components/` (`SessionGate.tsx` — the auto-session, `TokenGate.tsx` — the manual fallback, `CoverSettings.tsx` — the "Cover generation" panel, `ConfirmDialog.tsx` — the opaque confirmation dialog), `lib/session.ts`, `hooks/` (`useApi.ts` — one parser for the flat and the nested error envelope), `i18n/`, `theme/`, `styles/` | UI shell: the endpoint field for custom/ollama, topic clarifications on the main form, 4 settings sections (Providers → Models → Cover generation → Roles), the History row menu with delete confirmation |
| Data | `prisma/schema.prisma` (8 models), SQLite `generaptor.db` | no migrations: the schema is deployed by `prisma db push` at startup (`server/lib/db-bootstrap.mjs`) |

Packaging requirement: `package.json` → `files` must list
`scripts/brand-gate.mjs` and `scripts/universal-gate.mjs` — otherwise an installed
package cannot run `npm run lint:universal` and `npm run lint:brand`.
The `docs/` directory is not part of the package payload: the documentation ships
together with the sources.

### 3. Generation data flow

1. Composer (SPA) → `POST /api/articles` `{topic, targetLength, language?, userNotes?}` —
   validation: topic 3–200 chars, volume one of 7 values 50–80k (step 5k), language
   `ru|en`, notes ≤1000 (`server/routes/articles.mjs:531`).
2. Clarify (SPA) → `POST /api/articles/:id/start` `{coverRequested?}` — allowed start
   statuses `draft|failed|stopped|needs_review`
   (`server/routes/articles.mjs:651`, `allowedStartStatuses`).
3. The worker runs the 11-role chain; each role writes an `AgentRun` ledger row
   (status/progress/input/output/tokens/costRub/startedAt/finishedAt).
4. Progress travels over two channels: WS `/ws` and HTTP polling
   `GET /api/articles/:id/progress` — the SPA polls every 3 s as fallback
   (`src/hooks/useWebSocketProgress.ts`, `POLL_INTERVAL_MS=3000`).
   In a WS frame `status` is the **run** status, not the role status: a finished role
   arrives as `running` (`server/workers/article-generation.mjs:2076-2091`), the terminal
   frame is `completed`/`needs_review` with `percent=100` and
   `currentStage=totalStages` (`server/lib/article-progress.mjs:1-27`). The client
   normalises `needs_review` to `needs-review` (`src/hooks/progressStatus.ts`), so a
   finished role never looks like the end of the run.
5. Postcheck (`lib/article-postcheck.mjs`) issues the verdict (`ok|warn|fail`),
   and the `POSTCHECK_MODE` env variable decides what happens to it: `report`
   (the default) — the verdict is recorded in the `AgentRun` report and exposed
   by the API as `postcheckVerdict`, and the postcheck does not change the
   article status (you can see `postcheckVerdict='fail'` with `status='ready'`);
   `enforce` — `verdict='fail'` demotes the article to `needs_review` with the
   reason «Качество: N проваленных правил (id, …)». Any other (including empty)
   env value is read as `report` (`server/lib/article-postcheck.mjs:1889-1892`,
   `server/workers/article-generation.mjs:3162-3163`, `:3171-3172`).
6. Result: an `ArticleVersion` in three formats (HTML/TXT/MD) + `characterCount`.
7. Cover (optional, separate flow): `POST /api/articles/:id/cover` with `{} /
   {refinement ≤500} / {fresh:true}` — the flow never writes `Article.status`.

### 4. Storage layout

```
<data-dir>/                      (default ~/.generaptor, mode 0700)
 ├─ generaptor.db                SQLite (Prisma), mode 0600
 ├─ provider-secrets.key         provider-key encryption key, mode 0600
 └─ covers/
     └─ <articleId>-<n>.<ext>    png/jpg/webp/gif
```

- Data dir precedence: `--data-dir` → `GENERAPTOR_DATA_DIR` → `~/.generaptor`
  (`server/lib/data-dir.mjs`). An explicit env `DATABASE_URL` wins and is never rewritten.
- Cover filenames are pattern-validated on every read — the article UUID is checked,
  directory escape impossible (`server/lib/cover-store.mjs`).
- Permissions: data dir `0700`, DB file `0600` (`server/lib/data-dir.mjs:133`, `:197`,
  `:202`, `:211`; called on connect — `server/db.mjs:38`). POSIX semantics; on Windows
  the `chmod` calls are best effort (`server/lib/data-dir.mjs:182-184`).
- `provider-secrets.key` — the per-install AES-256-GCM key for provider keys; it sits
  next to the DB file, is created atomically, and never reaches a log or the API
  (`server/lib/secret-store.mjs:42`, `:64`, `:124-133`).
- Covers: the `covers/` directory is created with mode `0700` (`COVERS_DIR_MODE`,
  `server/lib/cover-store.mjs:42`), every file is written with mode `0600`
  (`COVER_FILE_MODE`, `:43`; the write — `:143`). After the best-effort
  hardening the data-dir location is re-checked, and when it is still not private
  the launcher prints a warning (`dataDirPrivacyWarning`,
  `server/lib/data-dir.mjs:156`; called from `hardenDataPermissions`, `:217-218`).
- Deleting an article cascades versions, `AgentRun` rows (SetNull) and cover files
  (`removeArticleCovers`, `server/routes/articles.mjs:1162`; the cleanup never takes
  the route down — a failure is logged, `:1163-1165`).

### 5. Role pipeline: 11 roles

`server/agent-role-data.mjs` — exactly 11 roles. Chain: `topic-selector → brief-preparer →
knowledge-base-curator → research-analyst → semantic-strategist → structure-architect →
article-author → factchecker → seo-reviewer → quality-controller → humanizer`.

The role count (11) is pinned in the server-code comments
(`server/routes/agent-roles.mjs:4`, `server/agent-role-execution.mjs:406`,
`server/lib/article-progress.mjs:17`, `server/lib/article-postcheck.mjs:60`,
`server/workers/article-generation.mjs:564`) and guarded against drift by
`tests/unit/role-count-drift.test.mjs`: a comment that drifts from the real count
breaks the tests, not the runtime.

| Tier | Roles | |
|---|---|---|
| critical (4) | research-analyst, structure-architect, factchecker, quality-controller | strict contracts |
| generation (5) | topic-selector, semantic-strategist, article-author, seo-reviewer, humanizer | text synthesis |
| standard (2) | brief-preparer, knowledge-base-curator | data preparation |

Role prompts are domain-neutral: the product writes expert articles for any
business. Shipped-set cleanliness is held by `npm run lint:brand`, and domain
neutrality by the
permanent `npm run lint:universal` gate (`scripts/universal-gate.mjs:78`): it scans
the shipped set and fails on any domain token outside the declared exception classes
(`scripts/universal-gate.mjs:144`); the gate is part of CI
(`.github/workflows/ci.yml:66`). User prompt editing —
Settings → Roles → `PUT /api/settings/agent-roles` (server-side persistence).

### 6. Data model: 8 models

`prisma/schema.prisma` — 8 models:

| Model | Purpose | Key fields |
|---|---|---|
| `Article` | article | topic, target_length, language (default `ru`), user_notes ≤1000, status, cover_* (9 fields), needs_review_reason |
| `ArticleVersion` | result versions | contentHtml/contentText/contentMarkdown, characterCount, platform; cascade delete |
| `AgentRun` | stage ledger | agentName, status, progress, input/output (JSON), tokens, costRub, startedAt/finishedAt; onDelete SetNull |
| `CoverSettings` | cover settings (single row) | model `qwen/qwen-image-2.1-pro`, compressionModel (NULL = inherit tier), promptTemplate, aspectRatio 16:9, resolution, quality, outputFormat |
| `AgentRoleSetting` | role prompt overrides | roleId, systemPrompt |
| `ResearchSource` | sources for fact grounding | url, title, fragments |
| `CompanyProfile` | author profile | minimal single row |
| `ProviderConfig` | providers and keys | kind, enabled, apiKey (AES-256-GCM ciphertext), baseUrl (always `null` for fixed kinds), models |

The site-source registry (`server/source-registry.mjs`) ships empty: the user
configures their own site set; with no entries the grounding layer degrades to the
generic web search (§10). The grounding layer works in its generic form, with no domain-specific research
clients.

A deployment registers its own site set through the `GENERAPTOR_SOURCE_REGISTRY`
environment variable (`source-registry.mjs:38`) — a path to a JSON file (absolute
or relative to the current directory, `source-registry.mjs:96-100`). The file is read
once at startup, so a restart picks up changes (`source-registry.mjs:9`, `:127`).
The shape is an array of entries (or an object with a `sites` array); an entry requires
`id` and `baseUrl`, and may add `name`, `doctorsIndex`, `servicesIndex`, `prices`, `llms`,
`sitemap` (or a ready-made `core` array) — `server/source-registry.mjs:13-24`, `:66-85`;
entries without `id`/`baseUrl` are dropped (`:71-73`).

The hosts of registered sites count as "own": only an exact host match counts (after
lower-casing and stripping the leading `www.`, no suffix matching —
`server/lib/source-domains.mjs:17-19`), and such results are promoted to
`evidenceLevel: 'canon'` with `metadata.isOwn` (`server/lib/source-domains.mjs:5-8`). A
missing or broken registry file never breaks the pipeline: the registry stays empty,
everything stays external evidence, and the research layer degrades to plain web search
(`server/source-registry.mjs:101-119`, `server/lib/source-domains.mjs:12-15`).

### 7. Covers (unhooked from WordPress)

- Generation: `server/lib/cover-service.mjs` — an images-capable provider (capability gate,
  `resolveCoverProvider()`); refinement semantics = regeneration with a refining prompt,
  `fresh` is stronger.
- Storage: `server/lib/cover-store.mjs` — data-dir filesystem, no WordPress.
- Serving: `GET /api/articles/:id/cover` — a binary route (`server/routes/articles.mjs:1185`),
  `Cache-Control: no-store`; 404 `cover_not_found` / 500 `cover_read_failed`.
- Error codes (`cover-service.mjs:61`): `cover_invalid_article_id` 400,
  `cover_invalid_refinement` 400 (≤500 chars), `cover_generation_failed` 502,
  `cover_not_configured` 503, `cover_provider_images_unsupported` 503.
- The cover flow never writes `Article.status`.
- WordPress/Telegram auto-publishing is out of GeneRaptor's scope: the release
  ships no publishing modules or their env block.

### 8. HTTP surface

Public (before the gate): `GET /api/health` (`routes/health.mjs:46` — SELECT 1,
`ok|degraded`, config block without secrets); `POST /api/auth/exchange`,
`GET /api/auth/status`, `POST /api/auth/logout` (`routes/auth.mjs`).

The gate decides on the **original request path, case-insensitively**
(`server/lib/api-paths.mjs:41`, `:53`, `:71`; `server/lib/auth.mjs:181`), so
`/API/articles` is protected exactly like `/api/articles`; only the four paths in
`PUBLIC_API_PATHS` stay public (`server/lib/api-paths.mjs:22-27`).

Host/Origin validation runs before the gate (`server/express-app.mjs:110-130`): a foreign
Host → `403 Запрещённый Host` (`:114`), a state-changing `/api` request with a foreign
Origin/Referer → `403 Запрещённый Origin` (`:124-125`); the rules live in
`server/lib/request-origin.mjs:43`, `:83`, `:117`, `:231`, `:261`. The WS upgrade
checks Origin first (`server/express-app.mjs:251`).

| Method & path | File:line | Purpose |
|---|---|---|
| GET `/api/articles` | `routes/articles.mjs:404` | list (history) |
| POST `/api/articles` | `:531` | create (validation above) |
| POST `/api/articles/:id/start` | `:630` | start generation |
| POST `/api/articles/:id/stop` | `:735` | stop |
| GET `/api/articles/:id` | `:790` | article card |
| GET `/api/articles/:id/progress` | `:824` | progress (WS fallback) |
| GET `/api/articles/:id/content` | `:877` | three text formats |
| PUT `/api/articles/:id/content` | `:981` | edit result |
| GET `/api/articles/:id/details` | `:1057` | details + ledger |
| DELETE `/api/articles/:id` | `:1145` | delete (+covers) |
| GET `/api/articles/:id/cover` | `:1185` | binary cover |
| POST `/api/articles/:id/cover` | `:1233` | generate/refine/fresh |
| GET/PUT `/api/settings/cover` | `routes/cover-settings.mjs:37,92` | cover settings |
| GET `/api/settings/api-keys`, POST `…/test` | `routes/api-keys.mjs:77,114` | key status + ping |
| GET/PUT/DELETE `/api/settings/agent-roles[/:roleId]` | `routes/agent-roles.mjs:54,82,141` | role catalog/overrides |
| GET/PUT `/api/settings/providers/:kind`, POST `…/test` | `routes/providers.mjs:55,78,116` | provider settings |
| GET `/api/providers/:kind/models` | `routes/providers.mjs:217` | model catalog |
| GET `/api/search/backends` | `routes/web-search.mjs:86` | backend catalog and their state |
| POST `/api/search/search` | `routes/web-search.mjs:106` | web search (always 200, degradation in the body) |
| POST `/api/search/probe` | `routes/web-search.mjs:145` | backend/key probe |
| POST `/api/yandex/search` | `routes/yandex-search.mjs:23` | legacy search route |

Also: `/api/*` → JSON 404; `dist/` static + SPA history fallback (when built).

### 9. Provider layer

`server/lib/providers.mjs` — 4 OpenAI-compatible kinds:

| kind | endpoint (baseUrl) | env key | key required | images |
|---|---|---|---|---|
| `routerai` | fixed `https://routerai.ru/api/v1` | `ROUTERAI_API_KEY` | yes | yes |
| `openrouter` | fixed `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | yes | unknown |
| `ollama` | `http://localhost:11434/v1` by default; a user endpoint only through the policy (loopback allowed for `ollama`) | `OLLAMA_API_KEY` | no | no |
| `custom` | set by the user: only `http`/`https`, no credentials in the URL, no private addresses | `CUSTOM_API_KEY` (ignored — an env key is never bound to `custom`) | no | unknown |

- Active provider: the single enabled `ProviderConfig` row; otherwise env-routerai
  (`ROUTERAI_API_KEY` + `ROUTERAI_MODEL_CRITICAL/GENERATION/STANDARD`); the engine gets
  its descriptor via `resolveActiveProviderForEngine()` which never throws.
- Keys: the source follows the endpoint the key is bound to (below) — env does
  **not** automatically win over the local store; only a mask, `keyConfigured/keySource`
  and `imagesCapability` ever leave the server (`toPublicProvider()`).
- **One place resolves the endpoint.** The outbound provider URL is determined and
  validated only in `server/lib/provider-url.mjs`: `resolveProviderTarget()` — `:271`,
  `resolveProbeEndpoint()` — `:336`. The scheme is `http`/`https` only, credentials in
  the URL are rejected (`parseProviderBaseUrl()`, `:127`), and private/loopback/
  link-local/CGNAT and metadata addresses are blocked unless the operator sets
  `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (`:67`, `:72`, `:101`, `:198`). For
  `routerai`/`openrouter` the endpoint is immutable (`FIXED_PROVIDER_KINDS`, `:49`) and
  the stored `baseUrl` is always `null` (`server/lib/providers.mjs:546`).
- **A key is bound to its endpoint.** `bindProviderKey()`
  (`server/lib/provider-url.mjs:239`) picks the key by the endpoint source: an env key
  goes only to an operator-controlled endpoint (canonical `:260` or env override
  `:256`), a user endpoint (`stored`) gets only the stored key (`:250`), and the kind
  `custom` never receives an env key (`:245`).
- A rejected endpoint never becomes an outbound request: the model catalog answers
  `502 provider_endpoint_rejected` without calling the provider
  (`server/routes/providers.mjs:237-242`), and the provider probe is reported as
  `warning` without a request (`:153-162`).
- Tier models: `critical|generation|standard|cover` (`parseProviderModels`).
- Ping: `POST /api/settings/api-keys/test` → level `ok|warning|error`
  (`lib/api-key-probe.mjs`; the key never appears in a response or log).
- Covers require images capability: otherwise `resolveCoverProvider()` returns
  `cover_provider_images_unsupported` — the UI shows honest unavailability.
- Outbound requests to the search backends: the User-Agent comes from the single
  source `server/lib/research-user-agent.mjs` (`researchUserAgent(scope)`) — the
  single UA contract holds in every backend of the generic search layer and in every
  keyless vertical
  (`server/lib/web-search/tavily.mjs:129`, `server/lib/web-search/serper.mjs:107`,
  `server/lib/web-search/verticals/http.mjs:38`).


### 10. Web-search layer

Serper.dev is the primary engine, Tavily free the fallback — facts come from the generic search layer
`server/lib/web-search/*` (24 files: 13 at the layer root, including `topic-match.mjs`
and `redirect-unwrap.mjs`, plus the `verticals/` directory of 11 modules). One contract:

`searchWeb(options = {})` (`server/lib/web-search/index.mjs:255`) returns
`{results, backend, degraded, reason, lang, limit, attempts}` and **never throws**:
every backend failure yields an empty result with `degraded: true` and a reason code
from the closed list (`server/lib/web-search/errors.mjs:9`) — `empty_query`,
`not_configured`, `keyless_unavailable`, `network_unavailable`, `timeout`, `blocked`,
`quota_exhausted`, `http_error`, `invalid_response`, `internal_error`. HTTP 402 and 429
map to `quota_exhausted`, 401/403 map to `not_configured`, network/timeout map to
`network_unavailable`/`timeout`. Every `results` item carries an optional
`provider` — the id of the source backend; `attempts` includes the vertical
probes.

The answer flow: **the backend chain → normalization (including the unwrapping of
redirect wrappers) → dedup → the DB**. The single application point of the wrapper
policy is the normalization `normalizeSearchResults`
(`server/lib/web-search/http.mjs:80-107`): every result passes the unwrapping of
the known wrapper forms (`google/url?q=`, `google/goto?url=`, `bing/ck/a?u=`,
`ddg/l/?uddg=`; the rule table — `server/lib/web-search/redirect-unwrap.mjs:47-58`)
through the pure module `server/lib/web-search/redirect-unwrap.mjs` (no network) —
**before** deduplication (`mergeResults`,
`server/lib/web-search/index.mjs:409-420`) and **before** the DB write
(`server/workers/article-generation.mjs:1400-1406`); an unwrappable wrapper is
dropped. This is required because `canonicalSignature`
(`server/lib/url-normalize.mjs:42-66`) drops the query string: without
unwrapping, all wrappers of one form collapse into a single link
(`https://google.com/goto`) and N sources are lost silently. The real Serper
answer capacity is 10 results (`SERPER_MAX_RESULTS`,
`server/lib/web-search/serper.mjs:51`; the request body — `:109-114`), the public
`limit` of the layer and the route (25) is unchanged. A consensus pass that adds
no new link stops the expansion (`splitNewSources`,
`server/workers/article-generation.mjs:109-119`; the stop condition —
`:1441-1448`), so a repeated request to the same backend no longer burns quota
and no longer duplicates the consensus input.

| Backend | Key | In the auto chain | Endpoint and notes |
|---|---|---|---|
| `serper` | `GENERAPTOR_SERPER_API_KEY` | yes — the primary engine | `https://google.serper.dev/search` (`web-search/endpoints.mjs:14`); a free key without a card, a 2,500-query starter pack (the expiry period of the pack is not published by the site); the real answer ceiling is 10 results, pagination is not supported |
| `tavily` | `GENERAPTOR_TAVILY_API_KEY` | yes — the fallback | `https://api.tavily.com/search` (`web-search/endpoints.mjs:11`); a free key gives 1,000 credits/month (confirmed by docs.tavily.com) |
| `tavily-keyless` | not needed | yes | the same endpoint plus the `X-Tavily-Access-Mode: keyless` header; some hosts get a 403 from the provider, and a keyless refusal is also detected from the response body (a "sign up / get a key" instruction) — the chain degrades honestly and moves on (`keyless_unavailable`) |
| `wikipedia` | not needed | yes | MediaWiki Action API per language `ru|en` (`web-search/endpoints.mjs:28`) |
| `wikidata` | not needed | yes | `https://www.wikidata.org/w/api.php` (`web-search/endpoints.mjs:30`) |
| `yandex` | `GENERAPTOR_YANDEX_API_KEY` | no | paid, only on an explicit choice (`web-search/endpoints.mjs:17`) |
| `duckduckgo` | not needed | no | unofficial scraping, opt-in only (`web-search/endpoints.mjs:54`) |

Separate from the tier — eight keyless verticals: OpenAlex (science and
publications), Crossref (DOIs and publishing metadata), Europe PMC (biomedicine),
GDELT (world news, a ~3-month window), Nominatim (geocoding, 1 rps), OpenLibrary
(books, 1 rps), Stack Exchange (Q&A; without a key 300 requests/day per IP — confirmed
by a live response, 10,000 requests/day with a registered key — official), Hacker News.
The verticals are consulted on a topic match (`server/lib/web-search/topic-match.mjs`:
an RU/EN marker table, "strong +2 / weak +1" scoring, threshold ≥2 — `:35`, a cap of 2
verticals per request — `:38`, the first page only — `web-search/index.mjs:447`);
their results are **added** to the primary ones with deduplication by canonical URL
(`mergeResults`, `web-search/index.mjs:409`); every source obeys the shared
`limit` (a vertical returns ≤ min(limit, 3), the merged list is bounded by
`web-search/index.mjs:108-113`); a vertical's degradation is a skip noted in
`attempts` and never breaks the primary answer (`runVerticalStage`,
`web-search/index.mjs:433`). In the backend catalogue the verticals are
marked `official: true, requiresKey: false`
(`server/lib/web-search/verticals/index.mjs:53-74`) and are never offered by the select
as the primary engine; no new env variables.

- Auto chain: `serper → tavily → tavily-keyless → wikipedia → wikidata`
  (`AUTO_SEARCH_CHAIN`, `web-search/index.mjs:79-83`) — the first backend
  of the array that has a key runs (`getAutoSearchChain`, `:192`); with an empty
  environment the keyless tail remains (keyless Tavily → Wikipedia → Wikidata,
  `KEYLESS_SEARCH_CHAIN`, `:62`); the default backend without a key is still
  `tavily-keyless` (`DEFAULT_SEARCH_BACKEND`, `:86`).
- An explicitly selected backend: in `auto` the first keyed backend of the chain is
  used; with an explicit choice the selected backend is tried first and another keyed
  provider is never silently substituted — the keyless tail stays the fallback
  (`server/lib/web-search/index.mjs:284-290`).
- HTTP surface: `GET /api/search/backends`, `POST /api/search/search`,
  `POST /api/search/probe` (`server/routes/web-search.mjs:86`, `:106`, `:145`).
  The probe is rate-limited by a 30-s cooldown (`PROBE_COOLDOWN_MS`,
  `server/routes/web-search.mjs:40`) and exists for keyed backends only — verticals
  are never probed (`PROBEABLE_BACKENDS`, `:30`). `POST /api/search/search` always
  answers 200 — the degradation is encoded in the body (`degraded`, `reason`,
  `attempts`).
- The endpoints are fixed in code: a user-supplied provider URL is not forwarded into
  the search layer (`server/lib/web-search/index.mjs:331-332`); the Serper key goes only
  to `https://google.serper.dev/search`; the key-to-endpoint binding still applies — a backend key only ever
  reaches the canonical endpoint of that backend.
- The backend choice is stored in the browser
  (`src/features/settings/helpers/searchSources.ts:14`) and applied to search
  requests; backend keys are never entered in the UI — environment only. The verticals
  are not part of the primary-engine select — the settings block shows them as "used
  automatically on a topic match".
- The generation worker wraps the search call in try/catch: a search failure does not
  kill the run, it becomes a worker warning; with no sources the «Внешние источники»
  block is not rendered. The source provider is taken from the per-item `provider`
  field of the result (`researchProviderFor`,
  `server/workers/article-generation.mjs:294-301`; applied at `:1322`, `:1382`)
  instead of being attributed to the tier backend.

### 11. Authentication and network

- Startup token: `server/lib/startup-token.mjs` — 32-byte CSPRNG, base64url 43 chars,
  15-min window, single-use; `--token` = fixed reusable; `--no-auth` disables the gate
  (loud warning). Exchange: `POST /api/auth/exchange` → HMAC cookie `generaptor_auth`
  (httpOnly, SameSite=Lax, secure in production), rate limit 5/15 s per IP.
- WS: the cookie is checked on handshake (`verifyWsConnection` → 401) and Origin is
  checked first (`server/express-app.mjs:255-260`).
- Binding: `127.0.0.1` by default (`GENERAPTOR_HOST`,
  `server/lib/launcher-args.mjs:424`); `--host` **without a value** is a usage
  error (`:48`, `:62-79`), and only an explicit `--host 0.0.0.0` leaves the loopback.
  Trust proxy removed — `X-Forwarded-For` spoofing would defeat the per-IP limit.
- The banner prints the **actually bound** address taken from `server.address()`
  (`server/index.mjs:29-34`) and, for a network bind, a `NETWORK-REACHABLE`
  warning (`server/index.mjs:75-82`, `server/lib/launcher-args.mjs:475`).
- Host/Origin: see §8 — a foreign Host and a foreign Origin/Referer on state-changing
  requests are rejected with `403` (`server/lib/request-origin.mjs:117`, `:231`,
  `:261`).
- Dev Origin alias: in the dev topology the launcher hands the server the
  `--dev-ui-origin` marker, and the Origin check accepts both loopback spellings of
  the one Vite port. The decision is the launcher topology, never `NODE_ENV`;
  acceptance is fail-closed and ACAO is not widened. The full flow is in §1.1.
- CORS: `CORS_ORIGIN` (default `http://localhost:5173`), credentials, restricted headers.
  In dev mode the launcher sets `CORS_ORIGIN` to the real UI origin
  (`http://<bindHost>:<uiPort>`) **only** when the operator has not chosen one, and
  only when the UI really is a separate origin (not `--api-only`, not a packaged
  prod build). Otherwise the exchange through the Vite proxy would get a 403: the
  browser sends `Origin: http://127.0.0.1:5173` while the default allow-list knows
  only `localhost` (`start.mjs`, the zone right after `devUiUrl`).
- Mount order: cookieParser → health → auth → requireGate → the rest of `/api`.
- Passwordless auto-session: the launcher resolves where the UI really lives
  (`resolveUiAvailability`), waits for UI readiness (2xx poll, up to 60 s) and opens
  the browser itself at `<uiUrl>/#token=<one-time token>`
  (`server/lib/open-browser.mjs`: `shouldAutoOpenBrowser` — a pure decision,
  `buildAutoOpenUrl`, `openBrowser` — spawn without a shell, `waitForUiReady`).
  Guards: `--no-browser`, `NODE_ENV=test`, `CI`, non-TTY stdout, a fixed token
  (`--token`), an unavailable UI. A failure prints the clean URL; the launcher
  survives. Client side: `src/lib/session.ts` (strict `#token=` parsing,
  `replaceState`, exchange, a status probe that reads the body) plus
  `src/components/SessionGate.tsx` (phases `exchanging`/`hint`/`manual`; the manual
  `TokenGate` is a secondary fallback only). `GET /api/auth/status` answers
  `{authenticated:true}` when the gate is disabled. Sequence: fresh start → token
  in the fragment → status probe → exactly one exchange → cookie → clean address →
  the app shell.

**The flow “launcher → browser → exchange → session → app” and its error branches.**

| Step | What happens | Error branch | Code |
|---|---|---|---|
| 1. Token | the launcher generates a one-time token (CSPRNG, 32 bytes → base64url, 43 chars) and hands it to the server process through `GENERAPTOR_STARTUP_TOKEN` | — | `server/lib/startup-token.mjs:31-33`, `start.mjs:435-437` |
| 2. Banner | the token is printed to the terminal exactly once: `[Auth] token: …` + “ONE-TIME: single use, valid for 15 min” | — | `server/lib/launcher-args.mjs:239-260`, `start.mjs:559-567` |
| 3. Decision | `shouldAutoOpenBrowser` decides whether to open a browser: `--no-browser` → `NODE_ENV=test` → `CI` → non-TTY stdout → a fixed `--token` → the UI is not served | the decision is simply “no”: the launcher continues, no auto-open happens | `server/lib/open-browser.mjs:28-45`, `start.mjs:575-582` |
| 4. UI readiness | poll `GET <uiUrl>` until 2xx, at most 60 s | the UI never came up → the clean URL is printed, the launcher does not crash | `server/lib/open-browser.mjs:98-115`, `start.mjs:589-597` |
| 5. Open | `cmd.exe /c start "" <url>` (Windows), `open` (macOS), `xdg-open` (Linux), `shell:false`, `detached` | the spawn failed → the clean URL **without the token** is printed | `server/lib/open-browser.mjs:68-87` |
| 6. Fragment parsing | the client accepts only a strict `#token=<base64url>` from its own address | no fragment → the “restart the studio” hint | `src/lib/session.ts:14-20`, `src/components/SessionGate.tsx:99-104` |
| 7. Status probe | `GET /api/auth/status`: a session already exists (another tab won the race) → the token is **not spent**, the fragment is dropped | the server is unreachable → proceed to the exchange | `src/lib/session.ts:44-49`, `src/components/SessionGate.tsx:108-120` |
| 8. Exchange | exactly one `POST /api/auth/exchange` with `Authorization: Bearer <token>` | 401 → the fragment is dropped, the status is probed again, otherwise the “the startup link is stale” hint; 429 → the fragment stays, a countdown follows `Retry-After`, at most two automatic retries; 5xx/network → the “server unavailable” hint, the fragment stays | `src/lib/session.ts:32-37`, `src/components/SessionGate.tsx:121-157` |
| 9. Gate on the server | the limit of 5 attempts / 15 s / IP is checked **before** the gate → 429 + `Retry-After` (the attempt spends nothing); the gate is single-use → a second exchange is 401 | 401 → `Токен не принят` | `server/routes/auth.mjs:103-128`, `server/lib/startup-token.mjs:75-83` |
| 10. Session | the `generaptor_auth` cookie (httpOnly, `SameSite=Lax`, path `/`), the fragment is dropped from the address and from the history entry, the app shell mounts | — | `server/routes/auth.mjs:88-97`, `src/lib/session.ts:27-29` |

- Honest boundaries: there is no per-request CSRF token — protection =
  `SameSite=Lax` + the `Origin`/`Referer` guard + CORS. The default
  `CORS_ORIGIN=http://localhost:5173` trusts a local origin in every mode
  (a pre-existing accepted risk: a page on `localhost:5173` can burn the
  exchange limit and, being same-site with `localhost:8787`, send credentialed
  state-changing requests; follow-up — "same-origin only in prod"). The shell
  is not the session: only the server's answer on a protected request proves
  authorization. The auto-exchange is exactly one request per mount (the
  cancellation is local to the effect, StrictMode does not double it);
  automatic retries on 429 are capped at two, after the cap the hint is static
  and only Refresh retries. The token is visible in the address fragment only
  until the exchange. The session cookie is stateless (`exp` + HMAC,
  `server/lib/auth.mjs:107-121`): the logout (`POST /api/auth/logout`) clears
  the cookie in the browser, but there is no server-side revocation list — a
  value copied before the logout stays valid until it expires.

### 12. Configuration surface

Env (`.env` / variables): `DATABASE_URL`, `GENERAPTOR_DATA_DIR`, `GENERAPTOR_API_PORT`
(8787), `CORS_ORIGIN`, `COOKIE_SECURE`, `GENERAPTOR_UTM_ENABLED` (external-link UTM
tagging, off by default), `GENERAPTOR_TOKEN`, `GENERAPTOR_TOKEN_TTL`,
`GENERAPTOR_STARTUP_TOKEN`, `ACCESS_GATE_DISABLED`, `GENERAPTOR_HOST`, provider keys
(`ROUTERAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`, `CUSTOM_API_KEY`, base
URLs and tier models), search variables (`GENERAPTOR_SEARCH_BACKEND` — `auto|tavily|
tavily-keyless|serper|yandex|wikipedia|wikidata|duckduckgo`, `GENERAPTOR_SEARCH_LANG` —
`ru|en`, `GENERAPTOR_SEARCH_TIMEOUT_MS`, `GENERAPTOR_TAVILY_API_KEY`,
`GENERAPTOR_SERPER_API_KEY`, `GENERAPTOR_YANDEX_API_KEY`; details in §10),
`GENERAPTOR_SOURCE_REGISTRY` (path to the JSON file with the deployment's own site
registry — see §6), `GENERAPTOR_ALLOW_PRIVATE_NETWORK` (`true` — allow
private/loopback provider addresses; off by default,
`server/lib/provider-url.mjs:67`), `POSTCHECK_MODE` (quality-postcheck mode:
`report` — the default, the verdict is only recorded and the postcheck does not
change the article status; `enforce` — `verdict='fail'` demotes the article to
`needs_review`; see §3, `server/lib/article-postcheck.mjs:1889-1892`).
The `GENERAPTOR_*` prefix is mandatory; there
are no legacy aliases.

Local settings (SQLite, edited from the UI): `ProviderConfig` (providers, keys, models,
the custom/ollama endpoint), `CoverSettings` (covers), `AgentRoleSetting` (role prompts).
Env does **not** win over the local store automatically: the key is chosen by the endpoint
it is bound to — see §9. `CoverSettings.model` is the single source of truth for the
cover model: the `cover` tier row under "Models" is a read-only derivative that re-reads
after the "Cover generation" panel saves. The launcher exports
`GENERAPTOR_DATA_DIR` to the server child process so both processes
resolve the same data directory.

`.env.example` lists only the variables the shipped code reads, every value empty.

### 13. i18n and themes

- The skeleton: `src/i18n/`, `src/theme/`
  (light/auto/dark, `data-theme` on `<html>`, auto = no attribute), design tokens in
  `src/styles/tokens.css` (4px grid).
- An RU/EN dictionary, a light+dark
  palette with measured WCAG contrast, no-FOUC inline bootstrap in `index.html`, a
  no-Cyrillic-outside-dictionary grep gate.
- The font is a **system stack** with no external loads
  (`--font-sans`: Segoe UI Variable Text / Segoe UI / system-ui; `--font-mono`:
  Cascadia Mono / Consolas — `src/styles/tokens.css:45-46`), one type scale and motion
  curve (`--ease`, `--duration-hover|menu|enter` — `:66-69`), one line-icon set
  (lucide-react), the cover panel on design tokens, an opaque confirmation dialog on
  its own layer (`src/components/ConfirmDialog.tsx`). There are no external font
  requests — text renders in the intended face without FOUT.
