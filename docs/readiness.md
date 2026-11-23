# Готовность GeneRaptor

> **Статус:** документ описывает готовность текущей поставки: что работает и
> проверено, что не доказано, остаточные риски и гейты качества. Контракт
> идентификаторов `GENERAPTOR_*`, пустой реестр источников, гейты `lint:brand`
> и `lint:universal` — в поставке. Вход без ввода токена: лаунчер сам открывает
> браузер с одноразовым токеном во фрагменте адреса, клиент обменивает его на
> сессионную cookie без перезагрузки страницы, ручной экран остался фоллбэком
> (§1, §3, §4). Главная оговорка: качество генерации на живом платном ключе
> не измерялось (§3).
> Источники: проверка кода и прогон команд (§6); числа гейтов даёт прогон,
> а не этот документ.

---

## RU

### 1. Текущее состояние

| Компонент | Состояние | Что входит |
|---|---|---|
| Bootstrap / CLI | готово | `start.mjs`, логгер, конфиг, каталог данных |
| Данные + раннер | готово | `queue-shim.mjs`, `data-dir.mjs`, `stale-job-sweep.mjs`, SQLite |
| Движок генерации | готово | 11 ролей, 8 моделей данных, без внешних сервисов |
| Провайдеры | готово | `providers.mjs`, выбор источника ключа, пинг, capability-гейт |
| Аутентификация | готово | одноразовый токен, HMAC-cookie, rate limit, WS-гейт, вход без ввода |
| Обложки | готово | локальный стор, бинарный маршрут, без WordPress |
| Оболочка UI | готово | 3 вкладки, токен-гейт, темы, e2e-путь |
| Прогресс + SQLite-e2e | готово | таймлайн этапов, веса ролей, Playwright на SQLite-стеке |
| i18n + темы | готово | двуязычный словарь RU/EN, палитра light+dark, no-FOUC |
| Экспорт | готово | экспорт html/txt/md, скачивание обложки |
| Опенсорс-упаковка | готово | npm-пакет `generaptor`, bin `start.mjs`, Prisma-bootstrap на `postinstall`, CI (node 20/22), README/LICENSE, `.env.example` |
| Контракт идентификаторов + гейты | готово | cookie `generaptor_auth`, env `GENERAPTOR_*`, `urn:generaptor:*`, пустой реестр источников, `npm run lint:brand`, `npm run lint:universal`, единый UA-контракт поискового слоя без исключений |
| Безопасность | готово | гейт доступа без учёта регистра, политика адресов и привязка ключей, Host/Origin-защита API и WS-upgrade, loopback по умолчанию, шифрование ключей на покое, права 0700/0600, санитайзация WS-логов, аудит зависимостей в CI (`docs/security.md`) |
| Поисковый слой | готово | цепочка `serper → tavily → tavily-keyless → wikipedia → wikidata`, 8 keyless-вертикалей по совпадению темы, per-item `provider`, cooldown пробы, 402/429 → `quota_exhausted`; вертикали «по теме» вне селекта, подсказка `GENERAPTOR_SERPER_API_KEY` |
| Поверхность настроек | готово | поле endpoint у custom/ollama, уточнения к теме со счётчиком `{n}/1000`, панель «Генерация обложек» и единый источник модели обложки, удаление статьи с непрозрачным диалогом подтверждения, dev-Origin маркер топологии лаунчера, права covers 0700/0600 и предупреждение о неприватном каталоге, системный шрифт без внешних загрузок, единый разбор плоского и вложенного конвертов ошибки |

Собственные (own) сайты — доверенные источники — деплой регистрирует через env
`GENERAPTOR_SOURCE_REGISTRY`: это путь к JSON-файлу реестра
(`server/source-registry.mjs:127`), читается один раз при старте, поэтому изменения
подхватываются рестартом. Формат — массив записей (или объект с полем `sites`), у
записи обязательны `id` и `baseUrl`, необязательны `name`, `doctorsIndex`,
`servicesIndex`, `prices`, `llms`, `sitemap` (или готовый массив `core`). Без
`GENERAPTOR_SOURCE_REGISTRY` реестр пуст: слой заземления деградирует до общего
веб-поиска, а отсутствующий или битый файл конвейер не ломает. Подробности —
`docs/architecture.md` §6.

### 2. Тесты и команды

Команды существуют в `package.json`; запускаются как написаны:

| Команда | Состояние |
|---|---|
| `npm install` | работает; `postinstall` генерирует Prisma-клиент (`scripts/ensure-prisma-client.mjs`) |
| `npm start` | работает: один сервер UI+API (8787), создаёт БД, печатает токен |
| `npm run dev` / `npm run dev:api` | работают (vite 5173 + API 8787; БД уже создана `npm start`) |
| `npm run build` | работает (`tsc --noEmit && vite build`) |
| `npm run typecheck` | работает (`tsc --noEmit`) |
| `npm test` | работает (`vitest run`: юнит + интеграция + воркер) |
| `npm run test:e2e` | работает: Playwright против реального API на SQLite-стеке — **без Postgres и Redis** (`tests/e2e/server-stack.mjs`, `playwright.config.ts`); сьют зелёный, число даёт сам прогон |
| `npm run test:e2e:mock` | работает: сквозной путь UI на фейковом API (`tests/e2e/playwright.mock.config.ts`) |
| `npm run db:studio` | работает (Prisma Studio над локальной БД) |
| `npm run lint:brand` | бренд-гейт: фирменные константы не проходят в поставляемый набор |
| `npm run lint:universal` | гейт отраслевой нейтральности: отраслевые термины не проходят в поставляемый набор |
| `npm audit --omit=dev --audit-level=high` | работает: настоящая команда npm, не скрипт `package.json`; аудит production-дерева без dev-зависимостей, ненулевой код выхода при advisory уровня high или выше |

CI повторяет то же на матрице node 20/22 (`.github/workflows/ci.yml`): install →
prisma generate/validate → typecheck → test → build → e2e → бренд-гейт `lint:brand` →
гейт универсальности `lint:universal` → аудит production-дерева
`npm audit --omit=dev --audit-level=high` (`ci.yml:71-72`) → явный шаг линта, который
выполняется только если в
`package.json` есть скрипт `lint`
(сейчас такого скрипта нет — шаг печатает, что линтить нечего; молчаливый
`--if-present` запрещён, он вырождался в зелёный no-op).

**Изолированный режим e2e.** Тестовый стек поднимает API и Vite на портах по
умолчанию `8787` и `5173`. Если они заняты чем-то ещё, порты стенда задаются
переменными `GENERAPTOR_E2E_API_PORT` и `GENERAPTOR_E2E_UI_PORT`
(`playwright.config.ts:30-32`). Это параметры **тестового стека**, а не продуктовые
переменные: в `.env.example` их нет, приложение их не читает. С явно заданным
портом UI набор не переиспользует сервер, который уже слушает на нём, — это мог
быть чужой сервер (`playwright.config.ts:79-88`).

Контракт чекаута: в корне репозитория лежит `.gitattributes` (`* text=auto eol=lf` и
`tests/unit/db-bootstrap.test.mjs -text`), поэтому файлы должны чекаутиться с LF на
любом хосте, включая Windows с `core.autocrlf=true`. CRLF-чекаут ломает трансформ
Vite: её regexp для hashbang (`/^#!.*\n/`) совпадает только с LF-терминированной
shebang-строкой, импортируемый модуль не парсится, vitest собирает 0 тестов — прогон
выглядит зелёным (ложно-зелёный прогон). Контракт закреплён тестом
`tests/unit/gitattributes.test.mjs`.

Чего в поставке нет (намеренно):

- `db:seed` / `db:migrate` / `prisma/seed.mjs` — легаси исходного движка, адресовало удалённые
  модели; поддерживаемый путь инициализации БД — `npm start` (`prisma db push` через
  `db-bootstrap.mjs`).
- Отдельный `npm run worker` — воркер встроен в API-процесс; вторая копия сервера
  соревновалась бы за одну очередь.

### 3. Что НЕ доказано (главная оговорка релиза)

Полный конвейер прогонялся **только на фейковом/локальном провайдере с мок-LLM**.
Живого платного API-ключа в проекте не было ни на одном этапе. Сборка, очереди,
экспорт, обложки, UI — проверены тестами; **качество генерации реальной моделью —
не проверено end-to-end**. Первое, что стоит сделать после установки: одна настоящая
генерация со своим ключом (Settings → Провайдеры) и взгляд на результат глазами.

Покрытие поиска ограничено: отраслевых клиентов (eLIBRARY, PubMed и подобных) нет,
слой заземления использует общий веб-поиск
(`server/lib/web-search/*`). Основной движок — Serper.dev и требует бесплатный ключ
(без карты, стартовый пакет 2500 запросов); фоллбек — Tavily free (ключ, 1000
кредитов/мес). Без ключей работает резервная keyless-цепочка — Tavily без ключа →
Википедия → Викиданные, то есть по умолчанию факты берутся из Википедии и Викиданных.
Первый шаг настройки поиска — ключ Serper (`GENERAPTOR_SERPER_API_KEY`); Yandex —
платный, только по явному выбору.

Ограничения поискового слоя, которые прогон не снимает:

- качество генерации на живом платном ключе **не измерялось** — приёмка качества
  вне критериев готовности;
- лимиты подтверждены официально: Serper — стартовый пакет 2500 запросов (периодичность
  сгорания пакета сайтом не опубликована), Tavily free — 1000 кредитов/мес;
  числовой лимит keyless-Tavily не опубликован; у вертикалей собственные публичные
  лимиты (Nominatim и OpenLibrary — 1 запрос/с, Stack Exchange — без ключа
  300/сутки на IP по живому ответу, с зарегистрированным ключом 10 000/сутки
  официально, GDELT — окно ~3 мес); публичного SLA нет ни у одного из них;
- бесключевой Tavily с части хостов отдаёт 403 — цепочка честно деградирует на
  Википедию (`degraded: true`, `reason: keyless_unavailable`), а не падает;
- деградация вертикали не ломает основной ответ — вертикаль пропускается с пометкой
  в `attempts`;
- живой прогон Serper с ключом **выполнен** (2026-11-20): `/search` → 200,
  `organic[]` = `title`/`link`/`snippet`/`position`/`date`/`displayedLink`;
  34 проверенные ссылки — 0 redirect-обёрток; фактический потолок выдачи — **10**
  (при `num:25` провайдер вернул 10); `credits` в ответе — стоимость вызова,
  а не остаток баланса (остаток виден только в Dashboard serper.dev, через API он
  не отдаётся); бэкенд игнорирует `page` — пагинации у Serper нет, поэтому итерации
  расширения источников останавливаются, когда новых ссылок нет. Эндпоинт
  `/resolve` **не интегрирован**: ссылки и так настоящие, `/resolve` не разворачивает
  форму `goto?url=` (проверено синтетически), это лишний HTTP-вызов на каждый поиск и
  недокументированный контракт (на нарушение формы — 400). Форма запроса/ответа официально не документирована —
  риск зафиксирован в коде (`server/lib/web-search/serper.mjs:10-27`);
- Serper, Tavily (с ключом) и Yandex в реальной установке **не проверены** — у
  пользователей нет ключей; единственный живой прогон с ключом —
  2026-11-20 (4 успешных `/search`, фиктивный ключ → 403), а полная генерация
  статьи на живом Serper не измерялась (расход кредитов при ней выведен из кода,
  а не замерен);
- GDELT официально не описывает кириллицу (корпус — машинные английские переводы):
  RU-запрос может дать пустую выдачу, для RU-контента предпочтительны английские
  ключевые слова;
- проба ключа ограничена cooldown 30 с;
- ключи поисковых бэкендов задаются только через окружение: поля ввода ключа в UI нет,
  панель показывает имя переменной и состояние бэкенда
  (`src/features/settings/SearchSourcesBlock.tsx:196`).

Механизмы безопасности реализованы в коде, но их доказательства ограничены:

- Политика адреса провайдера проверена юнит-тестами с подставным резолвером
  (`tests/unit/provider-url.test.mjs:39`, `:99-102`) — живого DNS-спуфинга в этой среде
  не было.
- Host/Origin-защита и гейт без учёта регистра проверены локальными интеграционными
  тестами против настоящего Express (`tests/integration/host-origin-guard.test.mjs`,
  `tests/integration/access-gate-casing.test.mjs`); внешнего пентеста не
  проводилось.
- Шифрование на покое доказано чтением сырых байтов файла БД и его `-wal`
  (`tests/integration/provider-secret-at-rest.test.mjs`), но файл ключа лежит рядом с БД
  в том же каталоге данных (`server/lib/secret-store.mjs:64`): злоумышленник с правом
  читать каталог данных получит и ключ — шифрование защищает от случайной утечки и от
  бэкапа БД без каталога, а не от локального пользователя с доступом к файлам.
- Приватные адреса блокируются по умолчанию, но оператор может включить
  `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (`server/lib/provider-url.mjs:67`) — тогда
  политика доверяет оператору, и это осознанный компромисс, а не защита.

**Вход без ввода токена — что доказано и что осталось не доказанным.**

Доказано на живом сервере с включённым гейтом:

- вход без ввода токена: обмен ровно один, поля ввода нет, перезагрузки страницы
  нет, оболочка открывается;
- фрагмент убран из адреса и из записи истории после обмена; токен не оседает в
  клиентском хранилище; в последующих запросах заголовка `Authorization` нет;
- токен не попадает ни в `Referer`, ни в строки `[HTTP]` серверного лога: в выводе
  лаунчера значение встречается ровно один раз;
- повторный обмен тем же токеном → 401; лимит обмена 5 попыток / 15 с / IP с
  `Retry-After`, причём отклонённая попытка не сжигает токен — после окна
  правильный токен принимается;
- рестарт выдаёт новый токен: прежний токен и прежняя cookie больше не
  принимаются;
- cookie: httpOnly, `SameSite=Lax`, path `/`, TTL 24 ч; `Secure` — только за TLS;
- при `--no-auth` `GET /api/auth/status` отвечает `{authenticated:true}` без cookie,
  предупреждение печатается ровно один раз;
- в неинтерактивном окружении (нет TTY на stdout) автооткрытия нет; при
  фиксированном `--token` автооткрытие пропускается, а обмен проходит;
- выход очищает cookie в браузере, следующий защищённый запрос снова 401.

Не доказано:

- защита от CSRF проверялась только в Chromium; в чужих браузерах (Firefox,
  Safari) эмпирически не прогонялась;
- автооткрытие проверено только на Windows: ветки macOS (`open`) и Linux
  (`xdg-open`) живьём не запускались;
- поведение при заблокированном спавне (политика ОС, антивирус) на живой машине
  не воспроизводилось — код не падает и печатает fallback-URL, но это проверено
  по коду и юнит-тестом, а не вживую;
- потолок автоматических повторов при 429 проверен e2e-сценарием с подставным
  429; против настоящего лимитера проверен сам лимит (живой пробой), а не цикл
  повторов клиента;
- e2e-стек поднимается с `ACCESS_GATE_DISABLED=true`
  (`tests/e2e/server-stack.mjs:59`), поэтому зелёный e2e **не** доказывает
  серверный гейт: его доказывают интеграционные наборы (`token-exchange`,
  `host-origin-guard`, `access-gate-casing`) и живые пробы с включённым гейтом.

**Поверхность настроек — что доказано и что осталось не доказанным.**

Доказано тестами и локальной приёмкой (сьют зелёный, числа даёт прогон):

- удаление статьи end-to-end: меню действий строки → непрозрачный диалог
  подтверждения отдельным слоем → удаление из базы вместе с файлами обложек;
  отмена не меняет данные, ошибка удаления видна у действия
  (`tests/unit/history-delete-ux.test.mjs`, `tests/unit/history-row-menu.test.mjs`,
  `server/routes/articles.mjs:1162`);
- поле endpoint: видно только у custom и ollama, у фиксированных видов — подсказка;
  пустой адрес у custom отсекается до запроса; серверные коды валидации
  показываются у поля стандартным переводимым текстом
  (`tests/unit/providers-endpoint.test.mjs`);
- клиентский парсер понимает оба конверта ошибки (плоский и вложенный
  `{success:false,error:{code,message}}`), стандартный текст сервера доходит до
  поля, а не «Bad Request»; неизвестный код / пустое тело дают нейтральное
  локализованное сообщение (`tests/unit/use-api-error-envelope.test.mjs`);
- уточнения к теме на главной форме: счётчик `{n}/1000`, maxLength 1000,
  необязательны, уходят в `userNotes` и попадают в промпт автора и бриф-препаратора
  (`tests/unit/composer-notes.test.mjs`, `server/agent-role-execution.mjs:622`);
- панель «Генерация обложек» — единственный редактор модели/формата/разрешения/
  качества/файла/промпта/автогенерации/лимита; строка `cover` в «Моделях» —
  read-only производная, перечитывается после сохранения панели
  (`tests/unit/cover-settings.test.mjs`, `cover-model-source.test.mjs`,
  `settings-cover-section.test.mjs`, `model-rows.test.mjs`);
- dev-алиас Origin управляется маркером топологии
  лаунчера (`--dev-ui-origin`), а не `NODE_ENV`; приёмка fail-closed, оба loopback-
  написания одного порта, ACAO не расширяется
  (`tests/integration/launcher-dev-ui-origin.test.mjs`,
  `tests/integration/dev-loopback-origin.test.mjs`,
  `tests/unit/request-origin-loopback.test.mjs`);
- визуальная согласованность: единая типографика и кривая движения, один набор линейных иконок,
  панель обложек на токенах, непрозрачный диалог подтверждения
  (`tests/e2e/visual-smoke.spec.ts`);
- шрифт грузится: системный стек (`src/styles/tokens.css:45-46`), внешних шрифтовых
  запросов нет — текст рендерится заданным лицом без FOUT;
- приватность хранилища: каталог covers 0700, файлы 0600, предупреждение о
  неприватном каталоге данных (`tests/unit/data-dir-privacy.test.mjs`,
  `tests/unit/cover-store-modes.test.mjs`).

Не доказано (оговорки релиза сохраняются):

- **платная генерация с ключом на финальной вершине** не выполнялась: полный
  конвейер прогонялся только на фейковом/локальном провайдере с мок-LLM; качество
  реальной модели на живом платном ключе не измерялось и не принималось как
  критерий готовности;
- **поведение на других ОС**: автооткрытие и POSIX-права проверены на Windows;
  ветки macOS (`open`) и Linux (`xdg-open`) живьём не запускались, на Windows
  `chmod` — best effort (граница безопасности — NTFS ACL);
- **CSRF в чужих браузерах**: защита `Origin`/`Referer` + `SameSite=Lax` проверялась
  только в Chromium; в Firefox и Safari эмпирически не прогонялась.

### 4. Остаточные риски

- Локальная SQLite, один пользователь: одна параллельная генерация, очередь без
  ретраев.
- Вход автоматический, но одноразовый: токен живёт 15 минут и обменивается один
  раз. Если вкладка закрылась до обмена, нужен либо ручной ввод по ссылке «Ввести
  токен вручную», либо перезапуск студии (`docs/security.md` §1).
- Первый запуск `npx generaptor` тянет Prisma-клиент из сети (`postinstall` →
  `scripts/ensure-prisma-client.mjs`); без сети пакет не стартует.
- i18n и темы покрыты юнит-тестами; контраст WCAG измерен для палитры —
  но живой пары «тема × реальный контент» в тестах нет.
- `tests/e2e/fake-api.ts` — ручная модель контракта; может дрейфовать от реального API.
- Безопасность не рассчитана на злонамеренного локального пользователя
  (`docs/security.md` §6).
- Явные POSIX-права выставляются: каталог данных — 0700, файл БД и файл ключей — 0600
  (`server/lib/data-dir.mjs:133`, `:202`, `:211`; `server/lib/secret-store.mjs:82`).
  На Windows вызовы `chmod` — best effort и могут быть no-op
  (`server/lib/data-dir.mjs:182-184`): там защиту несут права учётной записи
  пользователя.

### 4.1. Известные особенности

- Промпты ролей отрасле-нейтральны; нейтральность держит гейт `npm run lint:universal`.
- `GENERAPTOR_SOURCE_REGISTRY` читается один раз при импорте, а разрешение пути
  зависит от текущего каталога — используйте абсолютный путь.
- Переименование cookie в `generaptor_auth` сбрасывает старые сессии (так задумано);
  бренд-гейт сканирует исходники, а не `dist` (так задумано).

### 4.2. Известные ограничения безопасности

Перечислены в `docs/security.md` §6 и осознанно не исправляются — это компромисс
локального однопользовательского инструмента: тихая деградация пустого реестра
источников; HTTP-статус ответа провайдера в тексте ошибки для разрешённого адреса
(слабый SSRF-оракул при включённом `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true`);
подавляемое переменной окружения предупреждение `--no-auth`; флаг `Secure` у cookie
не выставляется автоматически при сетевом bind; широковещательные кадры прогресса;
реестр источников как доверенный вход; placeholder-контакт в User-Agent research-слоя.

Переменная `GENERAPTOR_ALLOW_PRIVATE_NETWORK` описана в `.env.example` (значение
пустое) и читается кодом (`server/lib/provider-url.mjs:67`).

### 5. Публикация и ключи

В репозитории нет ни одного ключа проекта: каждый пользователь задаёт свои через
окружение или локальное шифрованное хранилище (`docs/security.md` §3).

Требования к публикации: (1) ключи, `.env` и внутренние рабочие материалы не
переносятся в публикуемое дерево; (2) `package.json` → `files` держится в актуальном
состоянии — в списке должны быть `scripts/brand-gate.mjs` и
`scripts/universal-gate.mjs`, иначе установленный пакет не сможет выполнить гейты;
(3) перед первым публичным пушем прогоняются гейты §6.

### 6. Гейты качества

Качество удерживается:

- `npm run typecheck` (типы);
- `npm test` (юнит/интеграция/воркер);
- `npm run test:e2e` (реальный API на SQLite, без PG/Redis);
- `npm run lint:brand` (бренд-гейт) и `npm run lint:universal` (отраслевая
  нейтральность);
- контрактные регрессы (идут тем же `npm test`):
  `tests/unit/research-user-agent.test.mjs` (UA-контракт research-слоя),
  `tests/unit/gitattributes.test.mjs` (LF-контракт чекаута),
  `tests/unit/role-count-drift.test.mjs` (счёт 11 ролей в комментариях),
  `tests/unit/ci-workflow.test.mjs` (явный lint-шаг CI),
  `tests/unit/dead-code-removal.test.mjs` (удаление мёртвого кода),
  `tests/integration/no-auth-warning.test.mjs` (предупреждение `--no-auth` один раз);
- регрессы безопасности (идут тем же `npm test`):
  `tests/integration/access-gate-casing.test.mjs` (гейт доступа без учёта регистра),
  `tests/integration/host-origin-guard.test.mjs` (Host/Origin-защита API и WS-upgrade),
  `tests/integration/provider-url-policy.test.mjs` (политика адреса провайдера и
  привязка ключа к адресу),
  `tests/integration/provider-secret-at-rest.test.mjs` (ключ на покое не лежит
  plaintext-байтами в файле БД),
  `tests/integration/network-bind-banner.test.mjs` (баннер показывает реально занятый
  адрес),
  `tests/unit/provider-url.test.mjs` (классификация адресов, opt-in приватной сети,
  привязка ключа), `tests/unit/secret-store.test.mjs` (шифрование/дешифрование, файл
  ключа), `tests/unit/websocket-log-sanitize.test.mjs` (клиентский payload не попадает
  в лог);
- регрессы входа без ввода (идут тем же `npm test` и `npm run test:e2e`):
  `tests/unit/open-browser.test.mjs` (решение об автооткрытии, сборка URL, spawn без
  shell, poll готовности UI), `tests/unit/session-helpers.test.mjs` (парсер
  `#token=`, `replaceState`, обмен, проба статуса), `tests/unit/startup-token.test.mjs`
  (окно приёма 15 мин и одноразовость), `tests/integration/launcher-auto-open.test.mjs`
  (реальный запуск лаунчера: баннер один раз, значение токена в выводе одно),
  `tests/integration/auth-status-noauth.test.mjs` (статус при выключенном гейте),
  `tests/e2e/auto-auth.spec.ts` (вход без ввода, чистый адрес, ручной фоллбэк,
  подсказка «перезапустите студию»), `tests/e2e/auto-auth-rate-limit.spec.ts`
  (потолок автоматических повторов при 429). Важно: e2e-стек поднимается с
  `ACCESS_GATE_DISABLED=true` (`tests/e2e/server-stack.mjs:59`), поэтому зелёный
  e2e не доказывает серверный гейт — гейт доказывают интеграционные наборы и
  живые пробы с включённым гейтом;
- grep-гейты (пример — «нет кириллицы вне словаря»);
- паритет-проверки (RU/EN словарь 1:1; этот документ — RU/EN зеркален).

Числа гейтов намеренно не приводятся текстом: источник чисел — прогон. Проверяемая
последовательность: `npm test` → 0 падений; `npm run typecheck` → 0 ошибок;
`npm run build` → успех; `npm run test:e2e` → сценарии SQLite-стека;
`npm run lint:brand` → 0 запрещённых токенов в поставляемом наборе;
`npm run lint:universal` → 0 отраслевых токенов вне объявленных классов исключений;
`npm audit --omit=dev --audit-level=high` → 0 уязвимостей в production-дереве. Живой
прогон сервера: `/api/health` → `{"status":"ok","db":"connected"}`, `/API/articles` → 401,
чужой `Host` → 403.

### 7. Вердикт

Поставка готова и зелёная на гейтах §6; идентификаторы приведены к контракту
`GENERAPTOR_*` без legacy-алиасов. Вход без ввода токена работает: лаунчер сам
открывает браузер одноразовым токеном во фрагменте адреса, обмен на сессионную
cookie происходит без поля ввода и без перезагрузки страницы, ручной экран сохранён
фоллбэком (§1, §3). Качество генерации на живом платном ключе не измерялось (§3):
первое, что стоит сделать после установки, — одна реальная генерация со своим
ключом, чтобы посмотреть на текст глазами.

---

## EN — Readiness report (mirror)

> **Status:** this document describes the readiness of the current release: what
> works and is verified, what is not proven, the remaining risks and the quality
> gates. The `GENERAPTOR_*` identifier contract, the empty source registry and the
> `lint:brand` / `lint:universal` gates are in the release. Passwordless entry: the
> launcher opens the browser itself with a one-time token in the address fragment,
> the client exchanges it for a session cookie without a page reload, and the manual
> screen stays as a fallback (§1, §3, §4). The main caveat: generation quality on a
> live paid key was not measured (§3).
> Sources: code inspection and running the commands (§6); gate numbers come from
> the run, not from this document.

### 1. Current state

| Component | State | What ships |
|---|---|---|
| Bootstrap / CLI | done | `start.mjs`, logger, config, data dir |
| Data + runner | done | `queue-shim.mjs`, `data-dir.mjs`, `stale-job-sweep.mjs`, SQLite |
| Generation engine | done | 11 roles, 8 data models, no external services |
| Providers | done | `providers.mjs`, key source selection, ping, capability gate |
| Authentication | done | one-time token, HMAC cookie, rate limit, WS gate, passwordless entry |
| Covers | done | local store, binary route, no WordPress |
| UI shell | done | 3 tabs, token gate, themes, e2e path |
| Progress + SQLite e2e | done | per-stage timeline, role weights, Playwright on SQLite |
| i18n + themes | done | RU/EN dictionary, light+dark palette, no-FOUC |
| Export | done | html/txt/md export, cover download |
| Open-source packaging | done | npm package `generaptor`, bin `start.mjs`, Prisma bootstrap on `postinstall`, CI (node 20/22), READMEs/LICENSE, `.env.example` |
| Identifier contract + gates | done | cookie `generaptor_auth`, env `GENERAPTOR_*`, `urn:generaptor:*`, empty source registry, `npm run lint:brand`, `npm run lint:universal`, exception-free search-layer UA contract |
| Security | done | case-insensitive access gate, endpoint policy and key binding, Host/Origin guard for the API and the WS upgrade, loopback by default, keys encrypted at rest, 0700/0600 modes, WS log sanitisation, dependency audit in CI (`docs/security.md`) |
| Search layer | done | the `serper → tavily → tavily-keyless → wikipedia → wikidata` chain, 8 keyless topic verticals, per-item `provider`, probe cooldown, 402/429 → `quota_exhausted`; topic verticals outside the select, the `GENERAPTOR_SERPER_API_KEY` hint |
| Settings surface | done | the endpoint field for custom/ollama, topic clarifications with an `{n}/1000` counter, the "Cover generation" panel and the single cover-model source, article deletion with an opaque confirmation dialog, the dev-Origin marker driven by the launcher topology, covers modes 0700/0600 and the non-private data-dir warning, a system font with no external loads, one parser for the flat and the nested error envelope |

A deployment registers its own sites — the trusted sources — through the
`GENERAPTOR_SOURCE_REGISTRY` environment variable: a path to the registry JSON file
(`server/source-registry.mjs:127`), read once at startup, so a restart picks up changes.
The shape is an array of entries (or an object with a `sites` array); an entry requires
`id` and `baseUrl`, and may add `name`, `doctorsIndex`, `servicesIndex`, `prices`,
`llms`, `sitemap` (or a ready-made `core` array). Without `GENERAPTOR_SOURCE_REGISTRY`
the registry is empty: the grounding layer degrades to the generic web search,
and a missing or broken file never breaks the pipeline. Details —
`docs/architecture.md` §6.

### 2. Tests and commands

The commands exist in `package.json` and run as written:

| Command | State |
|---|---|
| `npm install` | works; `postinstall` generates the Prisma client (`scripts/ensure-prisma-client.mjs`) |
| `npm start` | works: single UI+API server (8787), creates the DB, prints the token |
| `npm run dev` / `npm run dev:api` | work (vite 5173 + API 8787; DB already created by `npm start`) |
| `npm run build` | works (`tsc --noEmit && vite build`) |
| `npm run typecheck` | works (`tsc --noEmit`) |
| `npm test` | works (`vitest run`: unit + integration + worker) |
| `npm run test:e2e` | works: Playwright against the real API on a SQLite stack — **no Postgres, no Redis** (`tests/e2e/server-stack.mjs`, `playwright.config.ts`); green; the run itself is the source of numbers |
| `npm run test:e2e:mock` | works: the UI end-to-end path on a fake API (`tests/e2e/playwright.mock.config.ts`) |
| `npm run db:studio` | works (Prisma Studio over the local DB) |
| `npm run lint:brand` | brand gate: brand constants cannot enter the shipped set |
| `npm run lint:universal` | domain-neutrality gate: domain terms cannot enter the shipped set |
| `npm audit --omit=dev --audit-level=high` | works: a real npm command, not a `package.json` script; audits the production tree without dev dependencies and exits non-zero on a high-or-higher advisory |

CI repeats the same on a node 20/22 matrix (`.github/workflows/ci.yml`): install →
prisma generate/validate → typecheck → test → build → e2e → the `lint:brand` brand gate
→ the `lint:universal` universality gate → the production-tree audit
`npm audit --omit=dev --audit-level=high` (`ci.yml:71-72`) → an explicit lint step that
runs only when
`package.json` defines a `lint` script (there
is none today — the step prints that there is nothing to lint; the silent `--if-present`
form is forbidden because it degraded into a green no-op).

**Isolated e2e mode.** The test stack starts the API and Vite on the default ports
`8787` and `5173`. If something else holds them, the stack ports are set with
`GENERAPTOR_E2E_API_PORT` and `GENERAPTOR_E2E_UI_PORT`
(`playwright.config.ts:30-32`). These are **test stack** parameters, not product
variables: they are absent from `.env.example` and the app never reads them. With
an explicit UI port the suite does not reuse a server that is already listening
there — it could be somebody else's server (`playwright.config.ts:79-88`).

Checkout contract: the repository root carries `.gitattributes` (`* text=auto eol=lf`
and `tests/unit/db-bootstrap.test.mjs -text`), so files must be checked out with LF on
every host, including Windows with `core.autocrlf=true`. A CRLF checkout breaks Vite's
transform: its hashbang regexp (`/^#!.*\n/`) only matches an LF-terminated shebang, the
imported module fails to parse and vitest collects 0 tests — the run looks green
(a false-green run). The contract is pinned by `tests/unit/gitattributes.test.mjs`.

Not in the release (by design):

- `db:seed` / `db:migrate` / `prisma/seed.mjs` — legacy scripts of the origin engine targeting deleted
  models; the supported DB init path is `npm start` (`prisma db push` via
  `db-bootstrap.mjs`).
- The separate `npm run worker` — the worker is embedded in the API process; a second
  server copy would race on the single queue.

### 3. What is NOT proven (the release caveat)

The full pipeline has been exercised **only on a fake/local provider with a mock LLM**.
No live paid API key was ever used in this project. Build, queues, export, covers,
UI — covered by tests; **real-model generation quality is not proven end-to-end**.
The first thing to do after install: one real generation with your own key
(Settings → Providers) and a human look at the result.

Search coverage is limited: the domain-specific clients (eLIBRARY, PubMed and similar)
are not part of the release; the grounding layer uses the generic web
search (`server/lib/web-search/*`). The primary engine — Serper.dev — requires a free
key (no card, a 2,500-query starter pack); the fallback is Tavily free (a key, 1,000
credits/month). Without any keys the reserve keyless chain runs — keyless Tavily →
Wikipedia → Wikidata, so by default the facts come from Wikipedia and Wikidata.
The first setup step for search is the Serper key (`GENERAPTOR_SERPER_API_KEY`);
Yandex is paid and only used on an explicit choice.

Search-layer limits that a test run does not lift:

- generation quality on a live paid key was **not measured** — quality acceptance is
  outside the readiness criteria;
- the limits are officially confirmed: Serper — a 2,500-query starter pack (the expiry
  period of the pack is not published by the site), Tavily free — 1,000 credits/month;
  the numeric keyless-Tavily limit is not published; the verticals carry their own
  public limits (Nominatim and OpenLibrary — 1 request/s, Stack Exchange — 300/day per
  IP without a key per a live response, 10,000/day with a registered key officially,
  GDELT — a ~3-month window); none of them has a public SLA;
- keyless Tavily answers 403 from some hosts — the chain degrades honestly to Wikipedia
  (`degraded: true`, `reason: keyless_unavailable`) instead of failing;
- a vertical's degradation never breaks the primary answer — the vertical is skipped
  with a note in `attempts`;
- a **live keyed Serper run has been performed** (2026-11-20): `/search` → 200,
  `organic[]` = `title`/`link`/`snippet`/`position`/`date`/`displayedLink`; of 34
  checked links, 0 were redirect wrappers; the real answer ceiling is **10**
  (`num:25` returned 10 records); `credits` in the response is the cost of the
  call, not the remaining balance (the balance is visible only in the serper.dev
  Dashboard and is not exposed by the API); the backend ignores `page` — there is
  no pagination in Serper, so source-expansion passes stop when a pass adds no new
  links. The `/resolve` endpoint is **not integrated**: the links are real
  anyway, `/resolve` does not unwrap the `goto?url=` form (checked on a synthetic
  sample), it would add one HTTP call per search and an undocumented contract (a
  malformed body answers 400). The
  request/response shape is not officially documented — the risk is recorded in the
  code (`server/lib/web-search/serper.mjs:10-27`);
- Serper, Tavily (with a key) and Yandex are **not verified** in a real install —
  the users have no keys; the only live keyed run is the one of 2026-11-20
  (4 successful `/search` calls, a fake key → 403), and a full article generation on
  a live Serper was not measured (the credit spend is derived from the code, not
  measured);
- GDELT does not officially describe Cyrillic (the corpus is machine English
  translations): an RU query may return an empty result; English keywords are
  preferred for RU content;
- the key probe is rate-limited by a 30-s cooldown;
- search backend keys are set through the environment only: there is no key input in
  the UI, the panel shows the variable name and the backend state
  (`src/features/settings/SearchSourcesBlock.tsx:196`).

The security mechanisms are implemented in code, but their proofs are bounded too:

- The provider endpoint policy is verified by unit tests with a stubbed resolver
  (`tests/unit/provider-url.test.mjs:39`, `:99-102`) — there was no live DNS spoofing
  in this environment.
- The Host/Origin guard and the case-insensitive gate are covered by local integration
  tests against a real Express (`tests/integration/host-origin-guard.test.mjs`,
  `tests/integration/access-gate-casing.test.mjs`); no external penetration test was run.
- Encryption at rest is proven by reading the raw bytes of the DB file and its `-wal`
  (`tests/integration/provider-secret-at-rest.test.mjs`), but the key file sits next to
  the DB in the same data directory (`server/lib/secret-store.mjs:64`): an attacker who
  can read the data directory gets the key too — encryption protects against an accidental
  leak and against a DB backup without the directory, not against a local user with file
  access.
- Private addresses are blocked by default, but an operator can set
  `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (`server/lib/provider-url.mjs:67`) — then the
  policy trusts the operator, which is a deliberate trade-off, not a protection.

**Passwordless entry — what is proven and what is still not proven.**

Proven on a live server with the gate enabled:

- passwordless entry: exactly one exchange, no input field, no page reload, the app
  shell opens;
- the fragment is removed from the address and from the history entry after the
  exchange; the token does not settle in client storage; the follow-up requests
  carry no `Authorization` header;
- the token reaches neither `Referer` nor the `[HTTP]` server log lines: in the
  launcher's output the value appears exactly once;
- a repeated exchange with the same token answers 401; the exchange limit is 5
  attempts / 15 s / IP with `Retry-After`, and a rejected attempt does not burn the
  token — after the window the correct token is accepted;
- a restart issues a new token: the previous token and the previous cookie are no
  longer accepted;
- the cookie: httpOnly, `SameSite=Lax`, path `/`, TTL 24 h; `Secure` only behind TLS;
- under `--no-auth` `GET /api/auth/status` answers `{authenticated:true}` without a
  cookie, and the warning is printed exactly once;
- in a non-interactive environment (no TTY on stdout) there is no auto-open; with a
  fixed `--token` the auto-open is skipped while the exchange still works;
- the logout clears the cookie in the browser and the next protected request answers
  401 again.

Not proven:

- the CSRF protection was exercised in Chromium only; it was not empirically run in
  foreign browsers (Firefox, Safari);
- the auto-open was verified on Windows only: the macOS (`open`) and Linux
  (`xdg-open`) branches were never run live;
- the behaviour when the spawn is blocked (OS policy, antivirus) was not reproduced
  on a live machine — the code does not crash and prints a fallback URL, but that is
  verified by code and a unit test, not live;
- the cap on the automatic retries after a 429 is verified by an e2e scenario with a
  stubbed 429; against the real limiter it is the limit itself that was verified
  (by a live probe), not the client's retry loop;
- the e2e stack starts with `ACCESS_GATE_DISABLED=true`
  (`tests/e2e/server-stack.mjs:59`), so a green e2e run does **not** prove the
  server gate: the integration suites (`token-exchange`, `host-origin-guard`,
  `access-gate-casing`) and the live probes with the gate enabled prove it.

**The settings surface — what is proven and what is still not proven.**

Proven by tests and local acceptance (the suite is green; the run is the source of numbers):

- end-to-end article deletion: the row action menu → an opaque confirmation dialog
  on its own layer → removal from the database together with the cover files;
  cancel changes nothing, a deletion error is surfaced at the action
  (`tests/unit/history-delete-ux.test.mjs`, `tests/unit/history-row-menu.test.mjs`,
  `server/routes/articles.mjs:1162`);
- the endpoint field: visible for custom and ollama only, a hint for the fixed
  kinds; an empty custom address is rejected before the request; server validation
  codes are shown at the field with the canonical translated text
  (`tests/unit/providers-endpoint.test.mjs`);
- the client parser understands both error envelopes (flat and nested
  `{success:false,error:{code,message}}`), the canonical server text reaches the
  field instead of "Bad Request"; an unknown code / empty body gives a neutral
  localized message (`tests/unit/use-api-error-envelope.test.mjs`);
- topic clarifications on the main form: an `{n}/1000` counter, maxLength 1000,
  optional, stored as `userNotes` and injected into the author's and the brief
  preparer's prompts (`tests/unit/composer-notes.test.mjs`,
  `server/agent-role-execution.mjs:622`);
- the "Cover generation" panel is the only editor of model/format/resolution/
  quality/file/prompt/auto-generation/limit; the `cover` row under "Models" is a
  read-only derivative that re-reads after the panel saves
  (`tests/unit/cover-settings.test.mjs`, `cover-model-source.test.mjs`,
  `settings-cover-section.test.mjs`, `model-rows.test.mjs`);
- the dev Origin alias is driven by the
  launcher topology marker (`--dev-ui-origin`), never `NODE_ENV`; acceptance is
  fail-closed, both loopback spellings of the one port, ACAO is not widened
  (`tests/integration/launcher-dev-ui-origin.test.mjs`,
  `tests/integration/dev-loopback-origin.test.mjs`,
  `tests/unit/request-origin-loopback.test.mjs`);
- visual consistency: one type scale and motion curve, one line-icon set, the cover
  panel on tokens, an opaque confirmation dialog
  (`tests/e2e/visual-smoke.spec.ts`);
- the font loads: a system stack (`src/styles/tokens.css:45-46`), no external font
  requests — text renders in the intended face without FOUT;
- storage privacy: the covers directory 0700, files 0600, a warning for a
  non-private data directory (`tests/unit/data-dir-privacy.test.mjs`,
  `tests/unit/cover-store-modes.test.mjs`).

Still not proven (the release caveats stand):

- **paid generation with a key on the final vertex** was never run: the full
  pipeline ran only against a fake/local provider with a mock LLM; real-model
  quality on a live paid key was not measured and was not accepted as a readiness
  criterion;
- **behavior on other operating systems**: auto-open and POSIX modes were verified
  on Windows; the macOS (`open`) and Linux (`xdg-open`) branches were never run
  live, and on Windows `chmod` is best effort (the security boundary is the NTFS
  ACL);
- **CSRF in foreign browsers**: the `Origin`/`Referer` + `SameSite=Lax` protection
  was verified in Chromium only; it was never run empirically in Firefox or Safari.

### 4. Remaining risks

- Local SQLite, single user: one parallel generation, no queue retries.
- The entry is automatic, but the token is one-time: it lives 15 minutes and is
  exchanged once. If the tab was closed before the exchange, either enter the token
  manually through the "Enter a token manually" link or restart the studio
  (`docs/security.md` §1).
- The first `npx generaptor` run pulls the Prisma client from the network
  (`postinstall` → `scripts/ensure-prisma-client.mjs`); without network the package
  will not start.
- i18n and themes are unit-tested; WCAG contrast is measured for the palette —
  but no test pairs a theme with real generated content.
- `tests/e2e/fake-api.ts` is a hand-written model of the contract; it can drift from
  the real API.
- Security is not designed against a malicious local user (`docs/security.md` §6).
- Explicit POSIX permissions are set: the data directory is 0700, the DB file and the
  key file are 0600 (`server/lib/data-dir.mjs:133`, `:202`, `:211`;
  `server/lib/secret-store.mjs:82`). On Windows the `chmod` calls are best effort and
  may be a no-op (`server/lib/data-dir.mjs:182-184`): there the user account rights carry
  the protection.

### 4.1. Known quirks

- The role prompts are domain-neutral; the `npm run lint:universal` gate keeps them so.
- `GENERAPTOR_SOURCE_REGISTRY` is read once at import and the path resolution depends
  on the current directory — use an absolute path.
- Renaming the cookie to `generaptor_auth` invalidates the old sessions (intended);
  the brand gate scans the sources, not `dist` (intended).

### 4.2. Known security limitations

Listed in `docs/security.md` §6 and deliberately left as they are — a trade-off of a
local single-user tool: silent degradation of an empty source registry; the
provider's HTTP status in the error text for an allowed endpoint (a weak SSRF oracle
with `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true`); the `--no-auth` warning suppressible
by an environment variable; the cookie's `Secure` flag not implied automatically on
a network bind; broadcast progress frames; the source registry as a trusted input;
a placeholder contact in the research-layer User-Agent.

`GENERAPTOR_ALLOW_PRIVATE_NETWORK` is listed in `.env.example` (empty by default) and
read by the code (`server/lib/provider-url.mjs:67`).

### 5. Publication and keys

The repository holds no project key at all: every user sets their own through the
environment or the local encrypted store (`docs/security.md` §3).

Publication requirements: (1) keys, `.env` and internal working materials are not
carried into the published tree; (2) `package.json` → `files` stays current — it must
list `scripts/brand-gate.mjs` and `scripts/universal-gate.mjs`, otherwise an
installed package cannot run the gates; (3) the §6 gates are run before the first
public push.

### 6. Quality gates

Quality is held by:

- `npm run typecheck` (types);
- `npm test` (unit/integration/worker);
- `npm run test:e2e` (real API on SQLite, no PG/Redis);
- `npm run lint:brand` (brand gate) and `npm run lint:universal` (domain
  neutrality);
- contract regressions (same `npm test` run):
  `tests/unit/research-user-agent.test.mjs` (the research-layer UA contract),
  `tests/unit/gitattributes.test.mjs` (the LF checkout contract),
  `tests/unit/role-count-drift.test.mjs` (the 11-role count in comments),
  `tests/unit/ci-workflow.test.mjs` (the explicit CI lint step),
  `tests/unit/dead-code-removal.test.mjs` (the dead-code removal),
  `tests/integration/no-auth-warning.test.mjs` (the `--no-auth` warning printed once);
- security regressions (same `npm test` run):
  `tests/integration/access-gate-casing.test.mjs` (case-insensitive access gate),
  `tests/integration/host-origin-guard.test.mjs` (Host/Origin guard for the API and the
  WS upgrade),
  `tests/integration/provider-url-policy.test.mjs` (provider endpoint policy and
  key-to-endpoint binding),
  `tests/integration/provider-secret-at-rest.test.mjs` (the key does not lie in the DB
  file as plaintext bytes),
  `tests/integration/network-bind-banner.test.mjs` (the banner shows the really bound
  address),
  `tests/unit/provider-url.test.mjs` (address classification, private-network opt-in,
  key binding), `tests/unit/secret-store.test.mjs` (encrypt/decrypt, key file),
  `tests/unit/websocket-log-sanitize.test.mjs` (the client payload never reaches the
  log);
- passwordless-entry regressions (run by the same `npm test` and
  `npm run test:e2e`):
  `tests/unit/open-browser.test.mjs` (the auto-open decision, the URL builder, the
  spawn without a shell, the UI readiness poll), `tests/unit/session-helpers.test.mjs`
  (the `#token=` parser, `replaceState`, the exchange, the status probe),
  `tests/unit/startup-token.test.mjs` (the 15-minute window and the single use),
  `tests/integration/launcher-auto-open.test.mjs` (a real launcher run: the banner
  once, the token value printed once),
  `tests/integration/auth-status-noauth.test.mjs` (the status under a disabled gate),
  `tests/e2e/auto-auth.spec.ts` (passwordless entry, the clean address, the manual
  fallback, the "restart the studio" hint), `tests/e2e/auto-auth-rate-limit.spec.ts`
  (the cap on the automatic retries after a 429). Important: the e2e stack starts
  with `ACCESS_GATE_DISABLED=true` (`tests/e2e/server-stack.mjs:59`), so a green e2e
  run does not prove the server gate — the integration suites and the live probes
  with the gate enabled do;
- grep-gates (example — "no Cyrillic outside the dictionary");
- parity checks (RU/EN dictionary 1:1; this document is RU/EN mirrored).

The gate numbers are deliberately not quoted in prose: the run is the source of numbers.
The verifiable sequence: `npm test` → 0 failures; `npm run typecheck` → 0 errors;
`npm run build` → success; `npm run test:e2e` → the SQLite-stack scenarios;
`npm run lint:brand` → 0 forbidden tokens in the shipped set; `npm run lint:universal` →
0 domain tokens outside the declared exception classes; `npm audit --omit=dev
--audit-level=high` → 0 vulnerabilities in the production tree. A live server run:
`/api/health` → `{"status":"ok","db":"connected"}`, `/API/articles` → 401, a foreign
`Host` → 403.

### 7. Verdict

The release is ready and green on the §6 gates; the identifiers follow the
`GENERAPTOR_*` contract with no legacy aliases. Passwordless entry works: the
launcher opens the browser with a one-time token in the address fragment, the
exchange for the session cookie happens with no input field and no page reload, and
the manual screen stays as a fallback (§1, §3). Generation quality on a live paid
key was not measured (§3): the first thing to do after install is one real
generation with your own key, to look at the text with your own eyes.
