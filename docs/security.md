# Безопасность GeneRaptor

> **Статус:** документ описывает механизмы безопасности текущей поставки: гейт
> доступа без учёта регистра, единую политику адресов и привязку ключей провайдеров,
> шифрование ключей на покое, проверку Host/Origin, loopback-биндинг по умолчанию,
> явные POSIX-права каталога данных и CI-гейт аудита зависимостей. Правила для
> поисковых ключей — §3.4; честные границы и известные ограничения — §6.
> Механизмы описаны по коду (`файл:строка`).

---

## RU

### 0. Модель угроз: локальный сервер

GeneRaptor — инструмент, запускаемый пользователем на своей машине (`npm start`).
Угрожающая сторона — сеть (другие устройства, скрипты на чужих страницах в браузере
пользователя) и локальные процессы того же пользователя. Инструмент **не рассчитан**
на защиту от злонамеренного локального пользователя, имеющего доступ к файловой
системе (см. §6 «Честные границы»). Активы: API-ключи провайдеров (деньги), тексты
статей, генерируемый контент. Атаки в модели: (а) чужая веб-страница стучится в
localhost-API из браузера; (б) подбор токена запуска по сети; (в) кража сессии;
(г) DNS-rebinding через подменённый `Host`; (д) CSRF-подмена изменяющего запроса;
(е) SSRF и кража ключа через подставной `baseUrl` провайдера; (ж) обход гейта
доступа через регистр пути. Механизмы (г), (д), (е), (ж) реализованы — §1, §2, §3.

### 1. Одноразовый токен запуска и гейт доступа

| Механизм | Реализация |
|---|---|
| Генерация | `server/lib/startup-token.mjs:31-33` — `crypto.randomBytes(32)` → base64url (43 символа, ~256 бит энтропии) |
| Окно приёма | 15 минут (`TOKEN_ACCEPTANCE_WINDOW_MS`, `server/lib/startup-token.mjs:26`); single-use — повторный обмен отвергается (`:79`, `:81`) |
| Сравнение | SHA-256 digest + `timingSafeEqual` — защита от timing-атаки (`server/lib/startup-token.mjs:39-43`) |
| Выдача | launcher печатает токен в терминал один раз (`formatTokenBanner`, `launcher-args.mjs:239-260`; блок печати — `start.mjs:549-567`) |
| Обмен | `POST /api/auth/exchange` с `Authorization: Bearer <token>` → HMAC-cookie `generaptor_auth` (`routes/auth.mjs:103`, имя cookie — `lib/auth.mjs:27`) |
| Cookie | httpOnly, SameSite=Lax, path `/`, `secure` в production (`COOKIE_SECURE`), TTL из `--token-ttl` (`routes/auth.mjs:88-96`) |
| Rate limit | 5 попыток / 15 с на IP, in-memory скользящее окно (`lib/auth.mjs:56`, `:58`); 429 + `Retry-After` отдаётся ДО обмена — лимит не тратит попытку сравнения (`server/routes/auth.mjs:106-108`) |
| Constant-work | `createGateToken()` вызывается на обеих ветках ответа (успех/отказ) — время ответа не выдаёт валидность токена (`routes/auth.mjs:115`, `server/lib/auth.mjs:115`) |
| WS | cookie проверяется на handshake (`verifyWsConnection` → 401, `lib/auth.mjs:216`, `server/express-app.mjs:253-267`); Express-гейт WS не покрывает |
| Выход | `POST /api/auth/logout` очищает cookie теми же атрибутами (`server/routes/auth.mjs:146-154`) |
| Оверрайды | `--token` = фиксированный многоразовый токен (`server/lib/startup-token.mjs:88-90`); `--no-auth` = гейт выключен (`lib/auth.mjs:180`), громкое предупреждение печатается **ровно один раз** за запуск (`formatNoAuthWarning`, `launcher-args.mjs:365`; маркер `GENERAPTOR_NO_AUTH_WARNING_SHOWN`, :383, `announceNoAuth()` :393, `shouldPrintNoAuthWarning()` :409) |
| TTL сессий | `session\|24h\|7d\|30d`; недопустимое значение останавливает процесс при старте (fail-closed, `server/lib/auth.mjs:44-52`) |
| Перезапуск | **без env-ключа** ключ сессии генерируется заново при старте, поэтому перезапуск обесценивает все выданные cookie (`server/lib/auth.mjs:15`, `lib/auth.mjs:101-104`). С явным `ACCESS_GATE_HMAC_KEY`/`JWT_SECRET` cookie переживает перезапуск — это осознанный операторский выбор. Стартовый токен после перезапуска **всегда новый**, прежний не принимается |
| Автообмен | лаунчер сам открывает браузер адресом `<uiUrl>/#token=<value>`; клиент (`src/components/SessionGate.tsx`) сначала проверяет `GET /api/auth/status` (сессия могла уже появиться в другой вкладке — тогда токен **не тратится**), затем делает ровно один `POST /api/auth/exchange`. Ни одного поля ввода, ни одной перезагрузки страницы на основном пути |
| Доставка токена | только во фрагменте `#token=`: фрагмент не сериализуется ни в строку запроса, ни в `Referer`, поэтому логгер `[HTTP]` (`server/express-app.mjs:98`) его не видит. После 200/401 `history.replaceState` убирает фрагмент из адреса **и из записи истории** (`src/lib/session.ts`); при 429/сетевом сбое фрагмент сохраняется — токен жив, нужна повторяемость |
| Referrer-Policy | `<meta name="referrer" content="no-referrer">` в `index.html` — defense-in-depth: ни один последующий запрос не несёт `Referer` |
| Автооткрытие | `server/lib/open-browser.mjs`: `cmd.exe /c start "" <url>` (Windows), `open` (macOS), `xdg-open` (Linux), spawn без shell. Guards: `--no-browser` → `NODE_ENV=test` → `CI` → не-TTY stdout → фиксированный токен → недоступный UI. Перед открытием — poll готовности UI (2xx, до 60 с). Сбой открытия/неготовность → лаунчер **не падает**, печатает чистый URL без токена |
| Статус при `--no-auth` | `GET /api/auth/status` отвечает `{authenticated:true}` и без cookie: гейт выключен = авторизованы все (`server/routes/auth.mjs:134-141`). Форма ответа `{authenticated:boolean}` не меняется; клиент ветвится по **телу**, а не по HTTP-коду |
| Ручной фоллбэк | экран `TokenGate` сохранён как **вторичный** — за ссылкой «Ввести токен вручную» на экране-подсказке. Нужен для `--token` (фиксированный многоразовый токен не кладётся в адрес/историю браузера), для удалённого bind и для восстановления без перезапуска. На основном пути инпута нет |

Приоритет источников токена: env `GENERAPTOR_TOKEN` (фиксированный) >
`GENERAPTOR_STARTUP_TOKEN` (одноразовый) > самогенерированный.

**Что значит «токен привязан к сессии».** Отдельного server-side session store
нет: привязка — это одноразовый обмен «токен → HMAC-cookie». Токен потребляется
первым успешным обменом и дальше не участвует; все последующие запросы
авторизует cookie (httpOnly, JS её не читает и токен нигде не хранит —
`localStorage`/`sessionStorage` не используются). Запрос с cookie и **без**
заголовка `Authorization` проходит гейт; повторный обмен тем же токеном → 401.

**Перезапуск при открытой вкладке.** Лаунчер открывает новую вкладку с новым
токеном — она сразу в приложении. Уже открытая старая вкладка на первом же
API-запросе получает 401 и показывает подсказку «Сессия закрыта: сервер
перезапущен»; кнопка «Обновить» перепроверяет статус и открывает приложение,
потому что cookie общая на браузер и уже обновлена новой вкладкой. Явного
редиректа нет: `replaceState` использует только `pathname + search` текущего
same-origin адреса, никаких redirect-параметров.

**Где токен не появляется:** в URL после обмена, в логах сервера (включая
строки `[HTTP] … <url>`), в телах API-ответов, в БД, в `Referer`, в клиентском
хранилище. Единственное место печати — строка баннера `[Auth] token:` ровно
один раз за запуск; строка автооткрытия и fallback-печать содержат URL **без**
токена.

**Честные границы автосессии.**

- Отдельного per-request CSRF-токена **НЕТ**. Защита изменяющих запросов =
  cookie `SameSite=Lax` + сторож `Origin`/`Referer` (чужой origin → 403) +
  CORS-whitelist. Принятая граница локального инструмента; эмпирически
  проверена только в Chromium.
- Граница CORS (принятый риск локального инструмента):
  дефолт `CORS_ORIGIN=http://localhost:5173` доверяет локальному origin во
  **всех** режимах. Страница на `localhost:5173` может (а) сжигать лимит обмена
  5/15 с — DoS входа в студию; (б) будучи same-site с
  `localhost:8787`, выполнить credentialed state-changing запрос с cookie
  жертвы. Follow-up: «same-origin only в prod».
- Окно видимости токена: до обмена токен виден во фрагменте адресной строки
  (плечо/скриншот). Жизнь окна — секунды до автообмена; токен одноразовый и
  принимается 15 минут; после 200/401 фрагмент удалён из адреса и из истории.
  При 429 или сетевом сбое фрагмент **остаётся**: токен ещё жив, а попытка
  должна оставаться повторяемой.
- Cookie сессии **stateless**: её значение — это `exp` + HMAC
  (`server/lib/auth.mjs:107-121`), серверного хранилища сессий и списка отзыва
  нет. `POST /api/auth/logout` очищает cookie в браузере, но значение cookie,
  скопированное до выхода, остаётся действующим до истечения срока (24 ч по
  умолчанию, меняется `--token-ttl`; `session` — до закрытия браузера).
- **Оболочка ≠ сессия.** Видимость шелла не доказывает авторизацию: при
  сетевом сбое бут-пробы клиент остаётся оптимистичным. Авторизацию доказывает
  только серверный ответ на защищённый запрос (401 без cookie, 200 с валидной
  cookie).
- `GET /api/auth/status` при `--no-auth` отвечает `{authenticated:true}` без
  cookie: гейт выключен = авторизованы все. Это публичный факт конфигурации,
  не секрет.
- Рестарт: без env-ключа ключ подписи эфемерный → сессия обнуляется; с явным
  `ACCESS_GATE_HMAC_KEY`/`JWT_SECRET` сессия переживает рестарт (осознанный
  операторский выбор). Стартовый токен после рестарта всегда новый.
- Автоповторы при 429 ограничены **двумя**: после потолка подсказка
  статична, повтор только кнопкой «Обновить» — клиент не держит лимитер
  горячим бесконечным циклом.

#### 1.1. Регистр пути не имеет значения

- Гейт решает по **исходному** пути запроса: `requestPathname()` берёт `req.originalUrl`
  и отбрасывает query (`server/lib/api-paths.mjs:41`) — `req.path` монтируется
  относительно роутера и для ответа «свой/чужой» не годится.
- `isApiPath()` сравнивает путь в нижнем регистре: `/api` либо `/api/...`
  (`lib/api-paths.mjs:53`); `isProtectedApiPath()` — это API-путь минус
  публичный список (`:71`).
- Публичные исключения — ровно четыре полных пути (`server/lib/api-paths.mjs:22-27`):
  `/api/health`, `/api/auth/exchange`, `/api/auth/status`, `/api/auth/logout`.
  Сравнение точное и тоже без учёта регистра; префиксы публичными не считаются.
- Гейт вызывается на `requestPathname(req)` (`server/lib/auth.mjs:181`); тот же
  признак использует SPA-fallback, чтобы `/API/...` не отдавался HTML-оболочкой
  (`server/express-app.mjs:177-182`).
- Причина: Express монтирует роутеры регистронезависимо, поэтому сравнение с `/api/`
  по умолчанию давало обход гейта.
- Регрессия закреплена тестом `tests/integration/access-gate-casing.test.mjs`:
  `/API/articles`, `/Api/articles`, `/api/ARTICLES`, `/API/settings/providers` → 401;
  `/api/health` и `/API/health` → 200.

### 2. Привязка к localhost, защита Host/Origin и сетевая обвязка

- По умолчанию API слушает `127.0.0.1` (`DEFAULT_BIND_HOST`,
  `server/lib/launcher-args.mjs:424`; применение — `launcher-args.mjs:432`,
  `express-app.mjs:212`). Порт — `GENERAPTOR_API_PORT` || 8787.
- **`--host` без значения больше не включает выход наружу** — это ошибка
  использования: launcher печатает `[ERROR] …` и выходит с кодом 1 до старта
  сервера (`server/lib/launcher-args.mjs:48`, :62-70, :71-79; разбор флагов
  до бутстрапа — `start.mjs:385-395`). Наружу выйти можно явным
  `--host 0.0.0.0` (или конкретным адресом).
- При выходе наружу баннер показывает **реально занятый** адрес и порт
  (`server/index.mjs:29-34`) и печатает предупреждение
  `[Net] !!  WARNING: NETWORK-REACHABLE BIND — …` с напоминанием, что доступный
  токен — единственная оставшаяся защита (`launcher-args.mjs:475-486`;
  вызов — `server/index.mjs:75-82`; маркер `GENERAPTOR_NETWORK_WARNING_SHOWN`,
  `launcher-args.mjs:491`).
- **Проверка Host:** заголовок `Host` должен указывать на собственный хост сервера
  и на реальный порт (`server/lib/request-origin.mjs:117`, `:83`), иначе — 403
  `Запрещённый Host` (`server/express-app.mjs:112-114`). Это закрывает DNS-rebinding.
- **Проверка Origin:** для изменяющих методов (`POST`, `PUT`, `PATCH`, `DELETE`;
  `lib/request-origin.mjs:43`) под `/api` проверяется `Origin`, а при его
  отсутствии — `Referer` (`server/express-app.mjs:116-128`); чужой origin → 403
  `Запрещённый Origin` (`request-origin.mjs:231`, `:261`). Отсутствующий
  заголовок разрешён — CLI-клиентам он не нужен; origin `null` запрещён.
- **Dev-алиас loopback-Origin.** В dev-топологии UI живёт на порту Vite,
  и браузер может открыть **любое** из двух написаний одного и того же адреса
  (`http://localhost:<uiPort>` или `http://127.0.0.1:<uiPort>`). Guard принимает
  оба — но **только** по маркеру топологии от лаунчера: флаг
  `--dev-ui-origin <origin>` в argv дочернего API-процесса (`start.mjs:487-492`,
  `:507`; решение — `server/lib/launcher-args.mjs:197`, `:218`; разбор флага —
  `server/lib/data-dir.mjs:103`). Маркер ставится **только** когда лаунчер сам
  поднимает Vite (`!useProdBuild && !apiOnly`); в packaged-режиме и в `--api-only`
  флаг не передаётся вовсе, поэтому набор Origin не расширяется **никогда** —
  независимо от `NODE_ENV`. Это существенно: даже если в `.env` стоит
  `NODE_ENV=production`, лаунчер может поднимать Vite, и признак режима по
  `NODE_ENV` давал ложные 403 на изменяющих запросах (например, на `DELETE`). Приём маркера
  **fail-closed** (`devUiOrigins`, `server/lib/request-origin.mjs:180`): ровно
  один origin, схема `http`/`https` сохраняется, хост — loopback, **порт
  обязателен**, алиас **ровно один** (`127.0.0.1 ↔ localhost`); `::1` принимается
  как есть, но алиас для него не добавляется. Не-loopback / без порта / список /
  `null` / путь или credentials в значении → маркер игнорируется, набор не
  меняется. Набор строится в **одной** точке (`allowedOrigins`, `:231`) и
  одинаков для HTTP-guard и WS-handshake.
- **CORS ACAO не расширяется.** Алиас — это разрешение **guard'а** («можно ли
  этому Origin менять состояние»), а не право читать ответы с cookie:
  `cors({ origin: corsOrigin })` остаётся одной строкой — настроенный
  `CORS_ORIGIN` (default `http://localhost:5173`), credentials on, методы и
  заголовки ограничены списком (`server/express-app.mjs:69-77`). В dev запрос
  браузера same-origin (относительные URL + Vite-proxy), поэтому CORS браузером
  вообще не задействован.
- **Логирование отказов и доверенного набора (CWE-778/CWE-117).** При старте
  печатается эффективный набор `[Origin] allowed origins: …` и отдельная строка
  об активном алиасе `[Origin] dev UI origin: … (loopback alias enabled: …)`;
  если при этом `NODE_ENV=production`, добавляется предупреждение о расхождении
  топологии и `NODE_ENV` (`server/express-app.mjs:225-247`). **Каждый** отказ по
  Origin логируется: `[Origin] rejected origin: <значение>` — и для HTTP
  (`:124`), и для WS-handshake (`:260`). Значение — недоверенный ввод, оно
  проходит через `sanitizeLogText` (`server/lib/log-sanitize.mjs:24`): CR/LF и
  прочие управляющие символы схлопываются в пробел, длина ограничена 120
  символами — строку лога нельзя ни разорвать, ни подделать.
- **WS-handshake** проверяет origin **первым** и отвечает 403 до проверки cookie
  (`checkUpgradeOrigin`, `server/lib/request-origin.mjs:283`; порядок —
  `express-app.mjs:251-266`).
- Trust proxy **удалён** из приложения (`express-app.mjs:55-57`): заголовок
  `X-Forwarded-For` спуфится клиентом, и per-IP rate limit обнулся бы.
- Порядок middleware: cookieParser (`express-app.mjs:90`) → **guard Host/Origin**
  (`:111-129`; проверка Host — `:113-115`, Origin/Referer на изменяющих
  `/api`-запросах — `:116-128`) → `/api/health` и `/api/auth` (public,
  `:135`, `:139`) → `requireGate` (`:145`) → остальные `/api`.
  Health не отдаёт секретов (только конфиг-блок с tier-моделями и статус БД).
- Гейт решает по **исходному пути запроса без учёта регистра** (§1.1,
  `server/lib/api-paths.mjs:41`, `:53`, `:71`), поэтому `/API/articles` защищён так
  же, как `/api/articles`, а `/API/health` остаётся публичным.
- Не-/api GET-ы гейт не проверяет (SPA-оболочка), но все мутирующие и данные-несущие
  маршруты — за гейтом.

### 3. Хранение API-ключей и политика адресов провайдеров

#### 3.1. Шифрование на покое

- Ключи провайдеров шифруются **AES-256-GCM**; формат значения —
  `genr:v1:<iv>:<tag>:<ct>` (`server/lib/secret-store.mjs:43`, `:45`, `:46`,
  `encryptSecret` `:167`, `decryptSecret` `:188`). Ключ 32 байта, IV 12 байт.
- Ключ шифрования — **файл на установку** `provider-secrets.key` рядом с файлом
  БД (`server/lib/secret-store.mjs:42`, путь — `:64`); при `DATABASE_URL` вида
  `file:` он кладётся рядом с SQLite-файлом, иначе — в каталог данных.
- Файл ключа создаётся атомарно (временный файл + `rename` + чтение обратно, при
  гонке параллельного создания побеждает уже лежащий на диске ключ —
  `server/lib/secret-store.mjs:124-133`), права — 0600 на POSIX (`:80`, best effort),
  каталог ключа — 0700 (`:128`).
- Запись ключа в БД всегда шифрует (`server/lib/providers.mjs:558`). Если файл
  ключа недоступен, запись **отклоняется** с ошибкой `secret_key_unavailable`
  (`:562-566`) — plaintext-режима нет.
- Чтение: значение расшифровывается (`server/lib/providers.mjs:144-149`); если
  расшифровка не удалась, ключ считается недоступным — пустое значение и
  предупреждение в лог (`:209-210`), то есть отказ «fail closed».
- **Миграция со старого формата:** строка со plaintext читается как есть, но при
  первом же чтении шифруется, записывается обратно и БД уплотняется `VACUUM`,
  чтобы старые байты покинули файл (`:201-207`). Миграция идемпотентна.
  `PRAGMA secure_delete = ON` включён на соединении (`server/db.mjs:44`).

#### 3.2. Приоритет и публичная форма

- Env **не выигрывает** над локальным хранилищем — источник определяется адресом,
  к которому привязывается ключ (детали в §3.3): env-ключ применяется только к
  адресу оператора (стандартному или заданному через env), сохранённый — только к
  сохранённому пользовательскому адресу, а kind `custom` env-ключ не получает вовсе
  (`server/lib/provider-url.mjs:239-262`).
- Локальное значение при этом **можно** записать: сохранённый ключ шифруется и
  лежит в БД (`server/lib/providers.mjs:558`); env-ключ имеет приоритет только на
  своём endpoint'е (`server/lib/provider-url.mjs:239`). UI показывает источник
  фактически используемого ключа — `env`/`local`/`none`
  (`server/lib/providers.mjs:140`; подпись источника в UI —
  `ProvidersSection.tsx:56`).
- Наружу ключ **никогда** не возвращается: `toPublicProvider()`
  (`server/lib/providers.mjs:417-432`) отдаёт только `keyConfigured`/`keySource`,
  имя env-переменной, признак `endpointSource`/`endpointRejected` и capability.
- Пинг ключа (`POST /api/settings/api-keys/test`, `server/routes/api-keys.mjs:114`)
  не пишет ключ в лог и не эхом ответа провайдера: запрос уходит через
  `GET /models` с таймаутом через AbortController
  (`server/lib/api-key-probe.mjs:67-69`, `:242`), а уровни ответа
  `ok|warning|error` заданы на `:185`, `:192`, `:199`. Ретраев нет.

#### 3.3. Политика адресов провайдеров и привязка ключа к адресу

- Исходящий адрес провайдера **разрешается и валидируется в одном месте** —
  `server/lib/provider-url.mjs`. Пользовательский `baseUrl` принимается только для
  kinds `custom` и `ollama`; у `routerai` и `openrouter` адрес фиксирован
  (`FIXED_PROVIDER_KINDS`, `server/lib/provider-url.mjs:49`), и попытка задать его
  отклоняется с `provider_url_not_allowed` (`server/lib/providers.mjs:526-529`),
  а в БД для этих kinds `baseUrl` всегда `null` (`:546`).
- Правила адреса (`parseProviderBaseUrl`, `server/lib/provider-url.mjs:127`):
  только `http`/`https` (`provider_url_scheme`), без логина и пароля в URL
  (`provider_url_credentials`), без пустого значения (`provider_url_required`).
- Сетевой класс адреса считается по IP-адресам (`classifyIp`,
  `server/lib/provider-url.mjs:72`) и по именам (`classifyHostname`, `:101`):
  loopback, приватные сети, link-local, CGNAT и известные metadata-хосты
  (`:52`) — не публичные.
- Приватные адреса запрещены, пока оператор явно не включил
  `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (`isPrivateNetworkAllowed`,
  `server/lib/provider-url.mjs:67`); loopback дополнительно допускается для kind
  `ollama` (`:198`). Отклонение — `provider_url_private`; нерезолвящийся хост —
  `provider_url_unresolved` (`:157`). DNS-ответы кешируются на 60 с (`:60`).
- **Ключ привязан к своему адресу** (`bindProviderKey`,
  `server/lib/provider-url.mjs:239`): env-ключ уходит только на адрес, заданный
  оператором (стандартный `:260` или env-переопределение `:256`), сохранённый ключ —
  только на сохранённый пользовательский адрес (`:250`), а kind `custom` **никогда**
  не использует env-ключ (`:245`). Это закрывает кейс «env-ключ ушёл на подставной
  URL».
- Проба ключа и каталог моделей идут через тот же политический слой
  (`resolveProbeEndpoint`, `server/lib/provider-url.mjs:336`; вызов —
  `server/lib/api-key-probe.mjs:183`).
- Поведение при отклонении: исходящий запрос **не выполняется вовсе** — проба
  возвращает `warning` без обращения к сети (`server/routes/providers.mjs:153-162`),
  а каталог моделей отвечает 502 `provider_endpoint_rejected`
  (`routes/providers.mjs:237-242`).
- `GENERAPTOR_ALLOW_PRIVATE_NETWORK` перечислена в `.env.example` (значение
  пустое) и читается кодом (`server/lib/provider-url.mjs:67`).

#### 3.4. Поисковые ключи и правила бэкендов

- Ключи поисковых бэкендов живут **только в окружении**:
  `GENERAPTOR_TAVILY_API_KEY`, `GENERAPTOR_SERPER_API_KEY`,
  `GENERAPTOR_YANDEX_API_KEY`. Они не пишутся в БД, не возвращаются в ответах API и
  не вводятся в UI — панель поисковых источников показывает состояние бэкенда и имя
  переменной окружения (`src/features/settings/SearchSourcesBlock.tsx:196`), а проба
  честно отвечает «Ключ не настроен на сервере»
  (`web-search.mjs:145`).
- **Ключ бэкенда не уходит на чужой endpoint.** Адреса зафиксированы в коде
  (`server/lib/web-search/endpoints.mjs:11`), пользовательский адрес провайдера в
  поисковый слой не передаётся (`server/lib/web-search/index.mjs:331-332`) — правило
  привязки ключа к адресу действует и для поисковых бэкендов. Ключ Serper уходит
  **только** на стандартный endpoint `https://google.serper.dev/search`
  (`server/lib/web-search/endpoints.mjs:14`) — других endpoint'ов у Serper нет,
  пользовательский адрес не принимается.
- **Политика redirect-обёрток.** Ссылки, приходящие от провайдера,
  разворачиваются в целевой адрес **без сетевых запросов** — чистый разбор URL в
  общем модуле `server/lib/web-search/redirect-unwrap.mjs`, применяемый в единой
  точке нормализации (`normalizeSearchResults`,
  `server/lib/web-search/http.mjs:80-107`) до дедупликации и до записи в БД.
  Правило: разворачиваемая обёртка → целевой адрес; неразворачиваемая — элемент
  отбрасывается. Отбрасывать, а не оставлять как есть, потому что подпись дедупа
  отбрасывает query (`canonicalSignature`, `server/lib/url-normalize.mjs:42-66`):
  все обёртки одного вида схлопнулись бы в одну подпись, и в выдаче остался бы
  один мусорный источник вместо N. Допустимы только `http(s)`-цели без встроенных
  учётных данных, длина ≤ 2048, глубина развёртки ≤ 2. Развёрнутый URL —
  **недоверенный текст провайдера**: он попадает в `sourceUrl`/`normalizedUrl`
  (`server/lib/research-source.mjs:93`, `:98`), в блок «📚 Внешние источники» в
  промпте ролей (`server/lib/research-source.mjs:192-193`,
  `server/agent-role-execution.mjs:538`, `:727`) и в UI как ссылка
  (`src/components/ArticleDetailsModal.tsx:471-479`) — и **никогда** не
  используется как цель исходящего запроса. В лог уходит только счётчик и id
  правил — без полных URL и без ключей. Ключ Serper по-прежнему уходит только на
  стандартный endpoint; новых сетевых хостов и
  env-переменных нет; эндпоинт `/resolve` в коде не вызывается.
- Единственное исключение — операторский адрес Yandex
  (`YANDEX_SEARCH_ENDPOINT`): его задаёт сам оператор, и он применяется только к
  бэкенду Yandex (`server/lib/web-search/endpoints.mjs:17`).
- Бесключевой режим (`tavily-keyless`, `wikipedia`, `wikidata`) секретов не
  требует; восемь keyless-вертикалей секретов не требуют и ключей не получают
  вовсе — пробирование для них не выполняется
  (`PROBEABLE_BACKENDS`, `server/routes/web-search.mjs:30`); `duckduckgo` —
  неофициальный скрейпинг, вне авто-цепочки и только по явному opt-in (см.
  `docs/architecture.md` §10).
- Значения ключей никогда не печатаются в лог и не уходят в браузер: UI показывает
  только имя env-переменной выбранного бэкенда и признак «настроен / не настроен».
  Публичная проба ключа `POST /api/search/probe` ограничена cooldown 30 с
  (`PROBE_COOLDOWN_MS`, `server/routes/web-search.mjs:40`); значение ключа в ответ
  пробы не попадает.

#### 3.5. Граница ошибок провайдера

- Сервер отвергает невалидный адрес **типизированной ошибкой со стандартным
  текстом причины** (русскоязычным): вложенный конверт
  `{success:false, error:{code, message}}` (`fail()`,
  `server/routes/providers.mjs:42-48`). Коды: `provider_url_private`
  (`server/lib/provider-url.mjs:205`), `provider_url_not_allowed`
  (`server/lib/providers.mjs:526`), `provider_url_unresolved`
  (`server/lib/provider-url.mjs:166`), `custom_base_url_required`
  (`server/lib/providers.mjs:549`) и другие из политики адресов.
- Клиент понимает **оба** конверта ошибки — плоский и вложенный — и доносит текст
  причины до поля (`src/hooks/useApi.ts:107`); известные коды дополнительно
  переводятся RU/EN по таблице `ENDPOINT_ERROR_KEYS`
  (`src/features/settings/ProvidersSection.tsx:31`). Неизвестный код / пустое тело
  дают нейтральное локализованное сообщение со статусом (`src/hooks/useApi.ts:136`),
  а **не** `res.statusText` («Bad Request») и не сырой стек.
- **Честная оценка: это раскрытие конфигурации.** Текст отказа сообщает причину
  политики: «адрес внутренней сети запрещён», «адрес фиксированного вида задаётся
  только окружением», «не удалось определить адрес». Для локального
  однопользовательского инструмента за гейтом доступа это приемлемо: оператор
  управляет конфигурацией, сообщения раскрывают **факты политики, а не секреты**.
  Значения ключей, внутренние пути и стек-трейсы в текст ошибки не попадают —
  наружу уходит только причина отказа.
- **Граница раскрытия.** Сообщения не содержат ключей; URL с учётными
  данными отсекается до валидации (`parseProviderBaseUrl`,
  `server/lib/provider-url.mjs:127`), поэтому credentials не всплывают в тексте;
  DNS-ошибка раскрывает лишь факт неразрешимости имени, а не внутренний резолвер
  или топологию. Политика приватных адресов публично документирована — её
  знание не является утечкой.
- **Остаточный риск.** Субъект с доступом к API (гейт выключен `--no-auth` или
  украденная cookie) может прощупать политику адресов по текстам отказов. Но в
  этом сценарии у него уже полный доступ к API — тексты ошибок не добавляют
  секретов. Это осознанный компромисс локального инструмента, в одном ряду с
  принятыми ограничениями (§6); отдельного CSRF-токена нет (§6), защита опирается на
  `Origin`/`Referer` + `SameSite=Lax`.

### 4. Аудит и логирование

Специализированного audit-лога **нет**. Что есть:

- HTTP request log в консоль (метод, путь, статус, длительность —
  `server/express-app.mjs:75-91`);
- журнал `AgentRun` в БД — какие роли, когда, с каким результатом и стоимостью
  выполнялись для каждой статьи;
- воркер пишет прогресс и ошибки этапов в лог процесса.

Секреты в логи не пишутся (см. §3); токен запуска печатается в терминал один раз.

**WebSocket-логи очищаются от клиентского ввода.** Сырое
сообщение клиента в логе позволяло бы подделать строку журнала (log forging),
поэтому используется санитайзер
(`server/lib/log-sanitize.mjs`): `sanitizeLogText` (`:24`) заменяет управляющие
символы и ограничивает длину, `sanitizeLogToken` (`:40`) оставляет только
`[A-Za-z0-9._:-]`. Сервер пишет только форму и размер кадра
(`describeClientMessage`, `:54`; вызов — `server/websocket.mjs:34`), а при ошибке
разбора — размер кадра и вид ошибки (`:39`). IP клиента тоже санитайзится
(`server/websocket.mjs:23`).

### 5. Каталог данных и права доступа

- По умолчанию каталог данных — `~/.generaptor` (`server/lib/data-dir.mjs:21-22`).
- **Один каталог для лаунчера и сервера.** Лаунчер разрешает путь и
  экспортирует его **абсолютным** значением `GENERAPTOR_DATA_DIR` до спавна
  любого ребёнка (`start.mjs:453`); относительный `--data-dir` разрешается один
  раз (`server/lib/data-dir.mjs:116`) — иначе cwd лаунчера и cwd ребёнка
  разошлись бы. Без этого экспорта обложки и файл ключа могли писаться в
  `~/.generaptor`, а каскад удаления чистил бы не тот каталог.
- Каталог создаётся с правами `0700` (`server/lib/data-dir.mjs:133`), файл БД
  `generaptor.db` — с правами `0600` (`:211`); оба выставляются одной функцией
  `hardenDataPermissions()` (`:197`), которая вызывается при подключении к БД
  (`server/db.mjs:38`) и после создания БД лаунчером (`start.mjs:217`).
- **Обложки создаются приватно.** Каталог `covers/` — `0700`
  (`server/lib/cover-store.mjs:42`, `:67`), файлы обложек — `0600` (`:43`,
  `:143`). Явный режим важен при `--data-dir` в общем месте: родительский каталог
  может оказаться доступным другим пользователям.
- **Предупреждение о неприватном каталоге.** После best-effort ужесточения прав
  `dataDirPrivacyWarning()` (`server/lib/data-dir.mjs:156`) проверяет место:
  POSIX — `mode & 0o077`; Windows — путь вне профиля пользователя (POSIX-биты
  там не граница). Предупреждение `[Data] WARNING: …` печатается из
  `hardenDataPermissions()` (`:217-218`) и содержит **только путь**, без
  значений ключа.
- Семантика POSIX: на Windows эти вызовы — no-op, права определяются ACL
  пользователя (комментарий `server/lib/data-dir.mjs:182-184`).
- `PRAGMA secure_delete = ON` включён на соединении (`server/db.mjs:44`) — при
  перезаписи страниц старые байты не остаются в файле БД.
- Файл ключа провайдеров лежит в том же защищённом каталоге
  (`server/lib/secret-store.mjs:64`) — см. §3.1.
- Имена файлов обложек валидируются паттерном на каждом чтении; UUID статьи
  сверяется — каталог-escape через имя файла невозможен
  (`server/lib/cover-store.mjs:56`, :100, :111, :163).
- Бинарный маршрут обложки отдаёт `Cache-Control: no-store` — браузер не кэширует
  приватный контент (`server/routes/articles.mjs:1207`).

### 6. Честные границы и известные ограничения

Инструмент **не защищает** от:

- злонамеренного локального пользователя: ключи провайдеров шифрованы
  на покое, но файл ключа лежит рядом с БД в каталоге пользователя, поэтому
  пользователь с доступом к каталогу данных может их расшифровать (шифрование
  защищает от утечки копии одного файла БД, а не от локального пользователя
  с доступом к файловой системе);
- чтения терминала/печати токена другими процессами пользователя;
- XSS в самих статьях — контент промывается DOMPurify на клиенте
  (`src/features/generation/ResultView.tsx:67`) и на сервере при рендере
  (`server/lib/markdown-renderer.mjs:56`), но сервер не санитайзит произвольный
  HTML повторно перед отдачей;
- CSRF в форме отдельного токена: защита опирается на проверку `Origin`/`Referer`
  для изменяющих `/api`-запросов — чужой origin отклоняется с 403
  `Запрещённый Origin` (`server/express-app.mjs:116-128`,
  `server/lib/request-origin.mjs:43`, `:261`), — плюс SameSite=Lax cookie
  (`routes/auth.mjs:92`) и CORS-whitelist (`server/express-app.mjs:69-77`);
  запрос без заголовков origin (CLI) остаётся допустимым, а origin `null`
  запрещён (`server/lib/request-origin.mjs:261`). Автообмен — same-origin
  fetch из шелла, поэтому он проходит ту же проверку Origin; отдельного
  CSRF-токена по-прежнему нет, и эмпирически защита в чужих браузерах не
  проверялась (только Chromium);
- **чужого локального приложения на UI-порту** (остаточный риск dev-алиаса). Алиас доверяет обоим написаниям **того порта, который лаунчер отдал
  Vite**. Если этот порт заняло другое локальное приложение (коллизия портов),
  его страницы становятся доверенным Origin для мутирующих запросов. Коллизия
  не детектируется ни лаунчером, ни сервером. Выигрыш атакующего ограничен:
  cookie host-only, а `localhost` и `127.0.0.1` — разные сайты, поэтому cookie,
  выданная на одном написании, на другое не уйдёт; поверхность чтения (ACAO)
  алиасом не расширяется (§2). Полное устранение — вынос UI на отдельный
  порт/сокет или проверка принадлежности порта нашему процессу.
  В packaged-режиме и в `--api-only` алиаса нет вовсе;
- brute-force по сети за пределами rate limit 5/15 с на обмен (окно 15 мин
  одноразового токена дополнительно сокращает выгоду).

Известные ограничения — честный список: перечисленные ниже пункты **не исправлены**
и приняты как осознанный компромисс локального инструмента.
Ограничивающий фактор — локальное однопользовательское развёртывание: сервер по
умолчанию слушает только loopback (§2), доступ закрыт одноразовым стартовым токеном
(§1), адреса и ключи провайдеров валидируются (§3.3), ключи шифруются на покое (§3.1).

| Ограничение | Уровень | Где смотреть | Что это значит для оператора |
|---|---|---|---|
| Тихая деградация пустого реестра | LOW | `server/source-registry.mjs:100-101`, `:113-114` | Пустой реестр источников деградирует тихо: в лог уходит предупреждение, но в UI/health поле о деградации нет — качество research-контента может падать без явного сигнала |
| HTTP-статус в ошибке провайдера | LOW | `server/routes/providers.mjs:257` | Для **разрешённого** внешнего провайдера текст ошибки всё ещё содержит `HTTP <status>` — это слабый oracle для сканера портов. Для **отклонённого** адреса ответ не раскрывает деталей (`provider_endpoint_rejected`, `:237-242`) и исходящего запроса не происходит |
| Подавление предупреждения `--no-auth` | LOW | `server/lib/launcher-args.mjs:383`, :409 | Предупреждение `--no-auth` можно подавить переменной окружения `GENERAPTOR_NO_AUTH_WARNING_SHOWN`; через launcher флаг подавить нельзя, но при прямом старте процесса — можно |
| Флаг `Secure` при сетевом bind | LOW | `server/routes/auth.mjs:81-96` | Флаг `Secure` у cookie не выставляется автоматически при выходе в сеть: по умолчанию он следует `NODE_ENV=production`/`COOKIE_SECURE`. При `--host 0.0.0.0` по HTTP cookie уйдёт без `Secure`; предупреждение о сетевом доступе печатается (§2) |
| Широковещательные кадры прогресса | LOW | `server/websocket.mjs:67`, `:81` | Кадры прогресса рассылаются всем подключённым клиентам, без подписки по статье. Сами кадры не содержат промптов, ключей и абсолютных путей, но один клиент видит прогресс чужих статей |
| Реестр источников — доверенный вход | LOW | `server/lib/source-domains.mjs:46`, `:79-95` | Содержимое реестра источников определяет, какие хосты считаются «своими». Реестр — доверенный вход: его содержимое определяет границу доверия |
| Placeholder-контакт в User-Agent | LOW | `research-user-agent.mjs:15` | Contact-DOM в User-Agent research-слоя — placeholder `+https://generaptor.local`. для публичного развёртывания рекомендуется заменить на реальный контакт |

### 7. Опенсорс-гигиена, зависимости и CI-гейты

- `.env.example` содержит только переменные поставляемого кода, все значения
  пустые. Переменная `GENERAPTOR_ALLOW_PRIVATE_NETWORK` в него внесена —
  значение по умолчанию пустое, то есть приватные адреса запрещены (см. §3.3).
- LICENSE — MIT.
- Поставка отрасле-нейтральна. Чистоту держит постоянный гейт `npm run lint:brand`
  (скан по `src`, `server`, `scripts`, `prisma` — `scripts/brand-gate.mjs:38`),
  а отраслевую нейтральность — гейт `npm run lint:universal`
  (`scripts/universal-gate.mjs:78`). Оба гейта выполняются в CI.
- Публикующих модулей (WP-интеграция) и их env-блока в поставке нет.
- **Зависимости.** В production-дереве закрыты известные advisory: `dompurify`
  3.4.17 (было 3.4.11 — advisory включали critical по XSS), `undici` 7.30.2,
  `body-parser` 1.20.9, `proxy-addr` 2.0.8, `qs` 6.17.1 (через `overrides`,
  `package.json:49-55`), `source-map-js` 1.2.2 — версии зафиксированы в
  `package-lock.json`. `npm audit --omit=dev` — 0 уязвимостей.
  Dev-дерево всё ещё содержит advisory в `vite`/`esbuild`/`vitest` — они не
  попадают в production-поставку и не роняют CI-гейт.
- **CI.** Прод-дерево проверяется отдельным шагом
  `npm audit --omit=dev --audit-level=high` («Dependency audit (no high/critical
  advisory in the production tree)», `ci.yml:71-72`); установка
  остаётся с `--no-audit`, чтобы не дублировать работу (`:36`). В CI также
  `npx prisma generate` (`:39`), `npm test` (`:50`), `npm run build` (`:53`),
  e2e (`:59`), бренд-гейт (`:63`) и гейт универсальности (`:66`).
- **Формат строк.** Контракт LF закреплён в `.gitattributes:13`
  (`* text=auto eol=lf`).
- **Секреты в репозитории.** В репозитории нет ключей проекта. Каждый пользователь
  задаёт свои ключи через окружение или локальное шифрованное хранилище (§3.1).

---

## EN — Security (mirror)

> Status: this document describes the security mechanisms of the current release:
> a case-insensitive access gate, one provider-endpoint policy with key-to-endpoint
> binding, at-rest encryption of provider keys, Host/Origin validation, a loopback
> default bind, explicit POSIX modes for the data dir and a CI dependency-audit gate.
> Search-key rules are in §3.4; honest limits and known limitations are in §6.
> Mechanisms below are described from the code (`file:line` repo-relative).

### 0. Threat model: a local server

GeneRaptor is a user-launched local tool (`npm start`). The adversary is the network
(other devices, scripts on foreign pages in the user's browser) and other local
processes of the same user. The tool is **not** hardened against a malicious local user
with filesystem access (see §6 "Honest limits"). Assets: provider API keys (money),
article texts, generated content. In-model attacks: (a) a foreign web page hitting the
localhost API from the browser; (b) network brute-force of the startup token;
(c) session theft; (d) DNS rebinding through a spoofed `Host`; (e) CSRF-style
substitution of a state-changing request; (f) SSRF and key theft through a supplied
provider `baseUrl`; (g) an access-gate bypass through the path casing. Mechanisms for
(d)–(g) are implemented — §1, §2, §3.

### 1. One-time startup token and the access gate

| Mechanism | Implementation |
|---|---|
| Generation | `server/lib/startup-token.mjs:31-33` — `crypto.randomBytes(32)` → base64url (43 chars, ~256 bits) |
| Acceptance window | 15 minutes (`TOKEN_ACCEPTANCE_WINDOW_MS`, `server/lib/startup-token.mjs:26`); single-use — replay rejected (`:79`, `:81`) |
| Comparison | SHA-256 digest + `timingSafeEqual` — timing-attack resistant (`server/lib/startup-token.mjs:39-43`) |
| Delivery | the launcher prints the token to the terminal once (`formatTokenBanner`, `launcher-args.mjs:239-260`; the print block — `start.mjs:549-567`) |
| Exchange | `POST /api/auth/exchange` with `Authorization: Bearer <token>` → HMAC cookie `generaptor_auth` (`routes/auth.mjs:103`; cookie name — `lib/auth.mjs:27`) |
| Cookie | httpOnly, SameSite=Lax, path `/`, `secure` in production (`COOKIE_SECURE`), TTL from `--token-ttl` (`routes/auth.mjs:88-96`) |
| Rate limit | 5 attempts / 15 s per IP, in-memory sliding window (`lib/auth.mjs:56`, `:58`); 429 + `Retry-After` served before the exchange — a throttled request spends nothing (`server/routes/auth.mjs:106-108`) |
| Constant-work | `createGateToken()` runs on both answer branches (success/failure) — response time does not leak token validity (`routes/auth.mjs:115`, `server/lib/auth.mjs:115`) |
| WS | the cookie is checked on handshake (`verifyWsConnection` → 401, `lib/auth.mjs:216`, `server/express-app.mjs:253-267`); Express middleware does not cover WS upgrades |
| Logout | `POST /api/auth/logout` clears the cookie with the same attributes (`server/routes/auth.mjs:146-154`) |
| Overrides | `--token` = fixed reusable token (`server/lib/startup-token.mjs:88-90`); `--no-auth` disables the gate (`lib/auth.mjs:180`), the loud warning is printed **exactly once** per run (`formatNoAuthWarning`, `launcher-args.mjs:365`; marker `GENERAPTOR_NO_AUTH_WARNING_SHOWN`, :383, `announceNoAuth()` :393, `shouldPrintNoAuthWarning()` :409) |
| Session TTL | `session\|24h\|7d\|30d`; an invalid value stops the process at boot (fail-closed, `server/lib/auth.mjs:44-52`) |
| Restart | **without an env key** the session key is regenerated at start, so a restart invalidates every issued cookie (`server/lib/auth.mjs:15`, `lib/auth.mjs:101-104`). With an explicit `ACCESS_GATE_HMAC_KEY`/`JWT_SECRET` the cookie survives a restart — a deliberate operator choice. The startup token is **always new** after a restart; the previous one is not accepted |
| Auto-exchange | the launcher opens the browser itself at `<uiUrl>/#token=<value>`; the client (`src/components/SessionGate.tsx`) first probes `GET /api/auth/status` (another tab may already hold a session — then the token is **not spent**), then makes exactly one `POST /api/auth/exchange`. No input field and no page reload on the main path |
| Token delivery | in the `#token=` fragment only: a fragment is serialized neither into the request line nor into `Referer`, so the `[HTTP]` logger (`server/express-app.mjs:98`) never sees it. After 200/401 `history.replaceState` drops the fragment from the address **and from the history entry** (`src/lib/session.ts`); on 429/network failure the fragment is kept — the token is alive and the attempt must stay repeatable |
| Referrer-Policy | `<meta name="referrer" content="no-referrer">` in `index.html` — defense-in-depth: no subsequent request carries a `Referer` |
| Browser auto-open | `server/lib/open-browser.mjs`: `cmd.exe /c start "" <url>` (Windows), `open` (macOS), `xdg-open` (Linux), spawned without a shell. Guards: `--no-browser` → `NODE_ENV=test` → `CI` → non-TTY stdout → fixed token → unavailable UI. Before opening, the UI readiness is polled (2xx, up to 60 s). A failed open / an unready UI does **not** crash the launcher: it prints the clean URL without the token |
| Status under `--no-auth` | `GET /api/auth/status` answers `{authenticated:true}` even without a cookie: a disabled gate means every caller is authorized (`server/routes/auth.mjs:134-141`). The response shape `{authenticated:boolean}` is unchanged; the client branches on the **body**, never on the HTTP status |
| Manual fallback | the `TokenGate` screen survives as a **secondary** path behind the "Enter a token manually" link on the hint screen. It is needed for `--token` (a fixed reusable token is never put into an address/history entry), for a remote bind and for recovery without a restart. There is no input on the main path |

Token source precedence: env `GENERAPTOR_TOKEN` (fixed) > `GENERAPTOR_STARTUP_TOKEN`
(one-time) > self-generated.

**What "the token is bound to the session" means.** There is no server-side
session store: the binding is the one-time exchange "token → HMAC cookie". The
token is consumed by the first successful exchange and takes no further part;
every later request is authorized by the cookie (httpOnly — JS cannot read it,
and the token is stored nowhere: `localStorage`/`sessionStorage` are not used).
A request with the cookie and **without** an `Authorization` header passes the
gate; a repeated exchange of the same token returns 401.

**A restart with a tab already open.** The launcher opens a new tab with the new
token — it lands in the app immediately. The old tab gets a 401 on its first API
request and shows the hint "The session was closed: the server restarted"; the
Refresh button re-probes the status and opens the app, because the cookie is
browser-wide and has already been renewed by the new tab. There is no redirect:
`replaceState` uses only the `pathname + search` of the current same-origin
address, and no redirect parameter is ever honoured.

**Where the token never appears:** in the URL after the exchange, in the server
logs (including the `[HTTP] … <url>` lines), in API response bodies, in the
database, in `Referer`, in client storage. The only place it is printed is the
banner line `[Auth] token:`, exactly once per run; the auto-open line and the
fallback line carry the URL **without** the token.

**Honest boundaries of the auto-session.**

- There is **NO** per-request CSRF token. Protection of state-changing requests
  = the `SameSite=Lax` cookie + the `Origin`/`Referer` guard (foreign origin →
  403) + the CORS allow-list. An accepted boundary of a local tool; verified
  empirically in Chromium only.
- CORS boundary (an accepted risk of a local tool):
  the default `CORS_ORIGIN=http://localhost:5173` trusts a local origin in
  **every** mode. A page on `localhost:5173` can (a) burn the 5/15 s exchange
  limit — a login DoS against the studio; (b) being same-site with
  `localhost:8787`, issue a credentialed state-changing request with the
  victim's cookie. Follow-up: "same-origin only in prod".
- Token visibility window: until the exchange the token is visible in the
  address-bar fragment (shoulder/screenshot). The window lives seconds until
  the auto-exchange; the token is single-use and accepted for 15 minutes;
  after 200/401 the fragment is removed from the address and from history.
  On a 429 or a network failure the fragment **stays**: the token is still
  alive and the attempt has to stay repeatable.
- The session cookie is **stateless**: its value is `exp` + HMAC
  (`server/lib/auth.mjs:107-121`); there is no server-side session store and no
  revocation list. `POST /api/auth/logout` clears the cookie in the browser,
  but a cookie value copied before the logout stays valid until it expires
  (24 h by default, changed with `--token-ttl`; `session` — until the browser
  closes).
- **The shell is not the session.** A visible shell does not prove
  authorization: on a network failure of the boot probe the client stays
  optimistic. Only the server's answer on a protected request proves it
  (401 without a cookie, 200 with a valid one).
- `GET /api/auth/status` under `--no-auth` answers `{authenticated:true}`
  without a cookie: a disabled gate means every caller is authorized. This is
  a public configuration fact, not a secret.
- Restart: without an env key the signing key is ephemeral → the session is
  wiped; with an explicit `ACCESS_GATE_HMAC_KEY`/`JWT_SECRET` the session
  survives a restart (a deliberate operator choice). The startup token is
  always new after a restart.
- Automatic retries on 429 are capped at **two**: after the cap the
  hint is static and only the Refresh button retries — the client does not
  keep the limiter hot with an unbounded loop.

#### 1.1. Path casing does not matter

- The gate decides on the **original** request path: `requestPathname()` takes
  `req.originalUrl` and drops the query (`server/lib/api-paths.mjs:41`) — `req.path`
  is mount-relative and cannot answer "own/foreign".
- `isApiPath()` compares the lower-cased path: `/api` or `/api/...`
  (`lib/api-paths.mjs:53`); `isProtectedApiPath()` is an API path minus the
  public list (`:71`).
- The public exemptions are exactly four full paths (`server/lib/api-paths.mjs:22-27`):
  `/api/health`, `/api/auth/exchange`, `/api/auth/status`, `/api/auth/logout`.
  The comparison is exact and also case-insensitive; prefixes are never public.
- The gate is called with `requestPathname(req)` (`server/lib/auth.mjs:181`); the
  SPA fallback uses the same predicate so `/API/...` is not served as the HTML
  shell (`server/express-app.mjs:177-182`).
- Why: Express matches mounted routers case-insensitively, so a default `/api/`
  comparison allowed a gate bypass.
- The regression is pinned by `tests/integration/access-gate-casing.test.mjs`:
  `/API/articles`, `/Api/articles`, `/api/ARTICLES`, `/API/settings/providers` → 401;
  `/api/health` and `/API/health` → 200.

### 2. Loopback binding, Host/Origin validation and network hardening

- By default the API listens on `127.0.0.1` (`DEFAULT_BIND_HOST`,
  `server/lib/launcher-args.mjs:424`; applied at `launcher-args.mjs:432`,
  `express-app.mjs:212`). The port is `GENERAPTOR_API_PORT` || 8787.
- **A value-less `--host` no longer exposes all interfaces** — it is a usage error:
  the launcher prints `[ERROR] …` and exits with code 1 before the server starts
  (`server/lib/launcher-args.mjs:48`, :62-70, :71-79; flags are parsed before
  bootstrap — `start.mjs:385-395`). Going public requires an explicit
  `--host 0.0.0.0` (or a concrete address).
- When exposed, the banner prints the **actually bound** address and port
  (`server/index.mjs:29-34`) and emits
  `[Net] !!  WARNING: NETWORK-REACHABLE BIND — …` with the reminder that the
  access token is the only protection left (`launcher-args.mjs:475-486`;
  called at `server/index.mjs:75-82`; marker `GENERAPTOR_NETWORK_WARNING_SHOWN`,
  `launcher-args.mjs:491`).
- **Host check:** the `Host` header must name the server's own host and the real
  port (`server/lib/request-origin.mjs:117`, `:83`), otherwise 403
  `Запрещённый Host` (`server/express-app.mjs:112-114`). This closes DNS rebinding.
- **Origin check:** for state-changing methods (`POST`, `PUT`, `PATCH`, `DELETE`;
  `lib/request-origin.mjs:43`) under `/api`, `Origin` is checked and, when
  absent, `Referer` (`server/express-app.mjs:116-128`); a foreign origin → 403
  `Запрещённый Origin` (`request-origin.mjs:231`, `:261`). A missing
  header is allowed — CLI clients do not send one; the `null` origin is denied.
- **The dev loopback Origin alias.** In the dev topology the UI lives on
  the Vite port and the browser may open **either** spelling of that one address
  (`http://localhost:<uiPort>` or `http://127.0.0.1:<uiPort>`). The guard accepts
  both — but **only** on the launcher's topology marker: the
  `--dev-ui-origin <origin>` flag in the API child's argv (`start.mjs:487-492`,
  `:507`; the decision — `server/lib/launcher-args.mjs:197`, `:218`; flag
  extraction — `server/lib/data-dir.mjs:103`). The marker is emitted **only**
  when the launcher starts Vite itself (`!useProdBuild && !apiOnly`); in the
  packaged build and in `--api-only` no flag is passed at all, so the origin set
  is **never** widened — whatever `NODE_ENV` says. That matters: even with
  `NODE_ENV=production` in `.env` the launcher may start Vite, and a NODE_ENV-based
  rule produced false 403s on state-changing requests (for example on `DELETE`). Marker acceptance
  is **fail-closed** (`devUiOrigins`, `server/lib/request-origin.mjs:180`):
  exactly one origin, the `http`/`https` scheme is preserved, the host is
  loopback, an **explicit port is mandatory**, and there is **exactly one**
  alias (`127.0.0.1 <-> localhost`); `::1` is accepted as itself but is never
  aliased. Non-loopback / no port / a list / `null` / a path or credentials in
  the value → the marker is ignored and the set stays unchanged. The set is
  built in **one** place (`allowedOrigins`, `:231`) and is identical for the
  HTTP guard and the WS handshake.
- **The CORS ACAO is not widened.** The alias is a **guard** allowance ("may
  this Origin change state?"), not a grant to read responses with cookies:
  `cors({ origin: corsOrigin })` stays a single string — the configured
  `CORS_ORIGIN` (default `http://localhost:5173`), credentials on, methods and
  headers allow-listed (`server/express-app.mjs:69-77`). In dev the browser
  request is same-origin (relative URLs + the Vite proxy), so the browser does
  not involve CORS at all.
- **Logging of refusals and of the trusted set (CWE-778/CWE-117).** At startup
  the effective set is printed as `[Origin] allowed origins: …`, plus a separate
  line for the active alias, `[Origin] dev UI origin: … (loopback alias enabled:
  …)`; when `NODE_ENV=production` accompanies the marker, a warning about the
  topology/NODE_ENV mismatch is added (`server/express-app.mjs:225-247`).
  **Every** Origin refusal is logged: `[Origin] rejected origin: <value>` — for
  HTTP (`:124`) and for the WS handshake (`:260`). The value is untrusted input
  and goes through `sanitizeLogText` (`server/lib/log-sanitize.mjs:24`): CR/LF
  and other control characters are flattened to a space and the length is
  bounded to 120 characters, so a log line can neither be broken nor forged.
- **WS handshake** validates the origin **first** and answers 403 before the cookie
  check (`checkUpgradeOrigin`, `server/lib/request-origin.mjs:283`; order —
  `express-app.mjs:251-266`).
- Trust proxy is **removed** (`express-app.mjs:55-57`): `X-Forwarded-For` is
  client-spoofable and would nullify the per-IP rate limit.
- Middleware order: cookieParser (`express-app.mjs:90`) → the **Host/Origin guard**
  (`:111-129`; Host check — `:113-115`, Origin/Referer on state-changing `/api`
  requests — `:116-128`) → `/api/health` and `/api/auth`
  (public, `:135`, `:139`) → `requireGate` (`:145`) → the rest of `/api`.
  Health serves no secrets (a config block with tier models and DB status only).
- The gate decides on the **original request path, case-insensitively** (§1.1,
  `server/lib/api-paths.mjs:41`, `:53`, `:71`), so `/API/articles` is protected exactly
  like `/api/articles`, while `/API/health` stays public.
- Non-/api GETs skip the gate (SPA shell), but every data-bearing and mutating route
  is gated.

### 3. API key storage and provider endpoint policy

#### 3.1. Encryption at rest

- Provider keys are encrypted with **AES-256-GCM**; the stored format is
  `genr:v1:<iv>:<tag>:<ct>` (`server/lib/secret-store.mjs:43`, `:45`, `:46`,
  `encryptSecret` `:167`, `decryptSecret` `:188`). 32-byte key, 12-byte IV.
- The encryption key is a **per-install file** `provider-secrets.key` stored next to
  the database file (`server/lib/secret-store.mjs:42`, path resolution `:64`); with a
  `file:` `DATABASE_URL` it sits beside the SQLite file, otherwise in the data dir.
- The key file is created atomically (temp file + `rename` + read-back; on a
  parallel-creation race the key already on disk wins —
  `server/lib/secret-store.mjs:124-133`), mode 0600 on POSIX (`:80`, best effort),
  key directory 0700 (`:128`).
- Every write encrypts the key (`server/lib/providers.mjs:558`). If the key file is
  unavailable the write is **refused** with `secret_key_unavailable`
  (`:562-566`) — there is no plaintext mode.
- On read the value is decrypted (`server/lib/providers.mjs:144-149`); if decryption
  fails the key is treated as unavailable — empty value plus a log warning
  (`:209-210`), i.e. fail-closed behaviour.
- **Legacy migration:** a plaintext row is read as-is but is encrypted on first read,
  written back and the DB is `VACUUM`ed so the old bytes leave the file
  (`:201-207`). The migration is idempotent. `PRAGMA secure_delete = ON` is enabled
  on the connection (`server/db.mjs:44`).

#### 3.2. Precedence and public shape

- Env does **not** win over the local store — the source follows the endpoint the key
  is bound to (details in §3.3): an env key is applied only to an operator
  endpoint (canonical or env-provided), a stored key only to the stored user
  endpoint, and the `custom` kind never receives an env key at all
  (`server/lib/provider-url.mjs:239-262`).
- A local value can still be written: the stored key is encrypted and kept in the DB
  (`server/lib/providers.mjs:558`); the env key has priority only on its own endpoint
  (`server/lib/provider-url.mjs:239`). The UI shows the source of the key actually in
  use — `env`/`local`/`none` (`server/lib/providers.mjs:140`; the UI source label —
  `ProvidersSection.tsx:56`).
- The key value **never** leaves the server: `toPublicProvider()`
  (`server/lib/providers.mjs:417-432`) exposes only `keyConfigured`/`keySource`, the
  env key name, the `endpointSource`/`endpointRejected` flags and the capability.
- The key ping (`POST /api/settings/api-keys/test`, `server/routes/api-keys.mjs:114`)
  never writes the key to logs and never echoes the provider response: the request
  goes out as `GET /models` with an AbortController timeout
  (`server/lib/api-key-probe.mjs:67-69`, `:242`), and the response levels
  `ok|warning|error` are defined at `:185`, `:192`, `:199`. There are no retries.

#### 3.3. Provider endpoint policy and key-to-endpoint binding

- The outbound provider URL is **resolved and validated in one place** —
  `server/lib/provider-url.mjs`. A user-supplied `baseUrl` is accepted only for the
  kinds `custom` and `ollama`; `routerai` and `openrouter` have a fixed endpoint
  (`FIXED_PROVIDER_KINDS`, `lib/provider-url.mjs:49`), and an attempt to set
  it is rejected with `provider_url_not_allowed`
  (`server/lib/providers.mjs:526-529`), while `baseUrl` is always stored as `null`
  for those kinds (`:543`, `:546`).
- URL rules (`parseProviderBaseUrl`, `lib/provider-url.mjs:127`): `http`/`https`
  only (`provider_url_scheme`), no credentials in the URL
  (`provider_url_credentials`), no empty value (`provider_url_required`).
- The network class is computed from IP addresses (`classifyIp`,
  `server/lib/provider-url.mjs:72`) and from hostnames (`classifyHostname`, `:101`):
  loopback, private ranges, link-local, CGNAT and known metadata hosts (`:52`) are
  not public.
- Private addresses are rejected unless the operator explicitly sets
  `GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (`isPrivateNetworkAllowed`,
  `server/lib/provider-url.mjs:67`); loopback is additionally allowed for the kind
  `ollama` (`:198`). Rejection → `provider_url_private`; an unresolvable host →
  `provider_url_unresolved` (`:157`). DNS answers are cached for 60 s (`:60`).
- **The key is bound to its endpoint** (`bindProviderKey`,
  `server/lib/provider-url.mjs:239`): an env key goes only to an operator-controlled
  endpoint (canonical `:260` or env override `:256`), a stored key only to the stored
  user endpoint (`:250`), and the kind `custom` **never** uses an env key (`:245`).
  This closes the "env key sent to a supplied URL" case.
- The key probe and the model catalogue go through the same policy layer
  (`resolveProbeEndpoint`, `server/lib/provider-url.mjs:336`; called at
  `server/lib/api-key-probe.mjs:183`).
- On rejection **no outbound request happens at all** — the probe returns `warning`
  without touching the network (`server/routes/providers.mjs:153-162`), and the model
  catalogue answers 502 `provider_endpoint_rejected`
  (`routes/providers.mjs:237-242`).
- `GENERAPTOR_ALLOW_PRIVATE_NETWORK` is listed in `.env.example` (empty value)
  and read by the code (`server/lib/provider-url.mjs:67`).

#### 3.4. Search keys and backend rules

- Search backend keys live **in the environment only**:
  `GENERAPTOR_TAVILY_API_KEY`, `GENERAPTOR_SERPER_API_KEY`,
  `GENERAPTOR_YANDEX_API_KEY`. They are never written to the DB, never returned in
  API responses and never entered in the UI — the search sources panel shows the
  backend state and the environment variable name
  (`src/features/settings/SearchSourcesBlock.tsx:196`), and the probe answers
  honestly «Ключ не настроен на сервере»
  (`web-search.mjs:145`).
- **A backend key never reaches a foreign endpoint.** The endpoints are fixed in
  code (`server/lib/web-search/endpoints.mjs:11`) and a user-supplied provider URL
  is not forwarded into the search layer
  (`server/lib/web-search/index.mjs:331-332`) — the key-to-endpoint binding applies
  to the search backends as well. The Serper key goes **only** to the canonical endpoint
  `https://google.serper.dev/search` (`server/lib/web-search/endpoints.mjs:14`) —
  Serper has no other endpoints, a user-supplied URL is not accepted.
- **The redirect-wrapper policy.** Links arriving from a provider are
  unwrapped to their target address **without any network request** — pure URL
  parsing in the shared module `server/lib/web-search/redirect-unwrap.mjs`,
  applied at the single normalization point (`normalizeSearchResults`,
  `server/lib/web-search/http.mjs:80-107`) before deduplication and before the DB
  write. The rule: an unwrappable wrapper is dropped, a wrappable one becomes its
  target address. It is dropped rather than kept as is because the dedup signature
  drops the query string (`canonicalSignature`,
  `server/lib/url-normalize.mjs:42-66`): all wrappers of one form would collapse
  into a single signature and the answer would keep one junk source instead of N.
  Only `http(s)` targets without embedded credentials are accepted, length ≤ 2048,
  unwrap depth ≤ 2. An unwrapped URL is **untrusted provider text**: it flows into
  `sourceUrl`/`normalizedUrl` (`server/lib/research-source.mjs:93`, `:98`), into the
  «📚 Внешние источники» block of the role prompts
  (`server/lib/research-source.mjs:192-193`,
  `server/agent-role-execution.mjs:538`, `:727`) and into the UI as a link
  (`src/components/ArticleDetailsModal.tsx:471-479`) — and it is **never** used as
  the target of an outgoing request. The log carries only a count and the rule
  ids — no full URLs, no keys. The Serper key still goes only to the canonical
  endpoint; no new network hosts or environment variables are introduced; the
  `/resolve` endpoint is never called in the code.
- The only exception is the operator-owned Yandex endpoint
  (`YANDEX_SEARCH_ENDPOINT`): the operator sets it and it applies to the Yandex
  backend only (`server/lib/web-search/endpoints.mjs:17`).
- The keyless modes (`tavily-keyless`, `wikipedia`, `wikidata`) need no secret;
  the eight keyless verticals need no secrets and never receive keys at all —
  they are never probed (`PROBEABLE_BACKENDS`, `server/routes/web-search.mjs:30`);
  `duckduckgo` is unofficial scraping, outside the auto chain and opt-in only
  (see `docs/architecture.md` §10).
- Key values are never printed to a log and never travel to the browser: the UI
  shows only the env variable name of the selected backend and whether it is
  configured. The public key probe `POST /api/search/probe` is rate-limited by a
  30-s cooldown (`PROBE_COOLDOWN_MS`, `server/routes/web-search.mjs:40`); the key
  value never appears in the probe response.

#### 3.5. The provider error boundary

- The server rejects an invalid address with a **typed error carrying the canonical
  reason text** (Russian): the nested envelope `{success:false, error:{code, message}}`
  (`fail()`, `server/routes/providers.mjs:42-48`). Codes: `provider_url_private`
  (`server/lib/provider-url.mjs:205`), `provider_url_not_allowed`
  (`server/lib/providers.mjs:526`), `provider_url_unresolved`
  (`server/lib/provider-url.mjs:166`), `custom_base_url_required`
  (`server/lib/providers.mjs:549`) and others from the endpoint policy.
- The client understands **both** error envelopes — flat and nested — and carries
  the reason text to the field (`src/hooks/useApi.ts:107`); known codes are also
  translated RU/EN through the `ENDPOINT_ERROR_KEYS` table
  (`src/features/settings/ProvidersSection.tsx:31`). An unknown code / empty body
  gives a neutral localized message with the status (`src/hooks/useApi.ts:136`),
  **not** `res.statusText` ("Bad Request") and not a raw stack.
- **Honest assessment: this is configuration disclosure.** The refusal text states
  the policy reason: "private-network addresses are blocked", "a fixed kind's
  address is set through the environment only", "could not resolve the address".
  For a local single-user tool behind the access gate this is acceptable: the
  operator owns the configuration, and the messages reveal **policy facts, not
  secrets**. Key values, internal paths and stack traces never enter the error
  text — only the refusal reason goes out.
- **The disclosure boundary.** The messages carry no keys; a URL with
  credentials is rejected before validation (`parseProviderBaseUrl`,
  `server/lib/provider-url.mjs:127`), so credentials never surface in the text; a
  DNS error reveals only that a name did not resolve, not the internal resolver or
  topology. The private-address policy is publicly documented — knowing it
  is not a leak.
- **Residual risk.** A subject with API access (the gate disabled via `--no-auth`,
  or a stolen cookie) can probe the endpoint policy through the refusal texts. But
  in that scenario it already has full API access — the error texts add no secrets.
  This is a deliberate local-tool trade-off, alongside the accepted limitations
  (§6); there is no separate CSRF token (§6), protection relies on
  `Origin`/`Referer` + `SameSite=Lax`.

### 4. Audit and logging

There is **no** dedicated audit log. What exists:

- an HTTP request log to the console (method, path, status, duration —
  `server/express-app.mjs:75-91`);
- the `AgentRun` DB ledger — which roles ran, when, with what outcome and cost per article;
- the worker logs stage progress and errors to the process log.

Secrets are never logged (§3); the startup token is printed to the terminal once.

**WebSocket logs are stripped of client input.** A raw
client message in the log would allow forging a log line, so a sanitiser is
used (`server/lib/log-sanitize.mjs`): `sanitizeLogText` (`:24`)
replaces control characters and bounds the length, `sanitizeLogToken` (`:40`) keeps
only `[A-Za-z0-9._:-]`. The server logs just the frame type and size
(`describeClientMessage`, `:54`; call — `server/websocket.mjs:34`), and on a parse
error only the frame size and the error kind (`:39`). The client IP is sanitised as
well (`server/websocket.mjs:23`).

### 5. Data directory and file permissions

- The default data directory is `~/.generaptor` (`server/lib/data-dir.mjs:21-22`).
- **One directory for the launcher and the server.** The launcher
  resolves the path and exports it as an **absolute** `GENERAPTOR_DATA_DIR`
  before spawning any child (`start.mjs:453`); a relative `--data-dir` is
  resolved exactly once (`server/lib/data-dir.mjs:116`) — otherwise the
  launcher's cwd and the child's cwd would diverge. Without that export the
  covers and the key file could land in `~/.generaptor` while the delete
  cascade cleans a different directory.
- The directory is created with mode `0700` (`server/lib/data-dir.mjs:133`) and the DB
  file `generaptor.db` with mode `0600` (`:211`); both are applied by one function,
  `hardenDataPermissions()` (`:197`), called on DB connect (`server/db.mjs:38`) and
  after the launcher creates the DB (`start.mjs:217`).
- **Covers are created privately.** The `covers/` directory is `0700`
  (`server/lib/cover-store.mjs:42`, `:67`) and the cover files are `0600` (`:43`,
  `:143`). An explicit mode matters with `--data-dir` in a shared location: the parent
  itself may be accessible to others.
- **Warning about a non-private directory.** After the best-effort hardening,
  `dataDirPrivacyWarning()` (`server/lib/data-dir.mjs:156`) checks the location:
  POSIX — `mode & 0o077`; Windows — a path outside the user profile (POSIX bits
  are not the boundary there). The `[Data] WARNING: …` line is printed from
  `hardenDataPermissions()` (`:217-218`) and carries the **path only**, never
  key material.
- POSIX semantics: on Windows these calls are a no-op and the user's ACLs apply
  (comment `server/lib/data-dir.mjs:182-184`).
- `PRAGMA secure_delete = ON` is enabled on the connection (`server/db.mjs:44`) — old
  bytes do not linger in the DB file after a rewrite.
- The provider key file lives in the same protected directory
  (`server/lib/secret-store.mjs:64`) — see §3.1.
- Cover filenames are pattern-validated on every read; the article UUID is matched — a
  directory escape via filename is impossible (`server/lib/cover-store.mjs:56`, `:100`,
  `:111`, `:163`).
- The binary cover route serves `Cache-Control: no-store` — the browser does not cache
  private content (`server/routes/articles.mjs:1207`).

### 6. Honest limits and known limitations

The tool does **not** protect against:

- a malicious local user: provider keys are encrypted at rest, but the key file
  sits next to the DB in the user's directory, so a user with access to the data
  directory can decrypt them (encryption protects against leaking a copy of the
  DB file, not against a local user with filesystem access);
- other user processes reading the terminal/token printout;
- XSS inside generated articles — content is sanitized with DOMPurify on the client
  (`src/features/generation/ResultView.tsx:67`) and on the server during rendering
  (`server/lib/markdown-renderer.mjs:56`), but the server does not re-sanitize
  arbitrary HTML before serving it;
- CSRF in the form of a separate token: protection relies on the `Origin`/`Referer`
  check for state-changing `/api` requests — a foreign origin is refused with 403
  `Запрещённый Origin` (`server/express-app.mjs:116-128`,
  `server/lib/request-origin.mjs:43`, `:261`) — plus the SameSite=Lax cookie
  (`routes/auth.mjs:92`) and the CORS allow-list
  (`server/express-app.mjs:69-77`); a request without origin headers (CLI) stays
  allowed, while the `null` origin is denied (`server/lib/request-origin.mjs:261`).
  The auto-exchange is a same-origin fetch from the shell, so it passes the
  same Origin check; there is still no separate CSRF token, and the protection has
  not been verified empirically in foreign browsers (Chromium only);
- **another local application on the UI port** (the residual risk of the dev
  alias). The alias trusts both spellings of **the port the launcher gave
  to Vite**. If another local application took that port (a port collision), its
  pages become a trusted Origin for state-changing requests. Neither the
  launcher nor the server detects the collision. The attacker's gain is limited:
  the cookie is host-only and `localhost` / `127.0.0.1` are different sites, so a
  cookie issued on one spelling never travels to the other; the reading surface
  (ACAO) is not widened by the alias (§2). A full fix means moving the UI to a
  dedicated port/socket or verifying that the port belongs to our process. In the packaged build and in `--api-only` there is no alias
  at all;
- network brute-force beyond the 5/15 s exchange rate limit (the 15-minute one-time
  window further shrinks the payoff).

Known limitations — an honest list: the items below are **not fixed** and are
accepted as a deliberate trade-off of a local tool. The limiting factor is the
local single-user deployment: the server listens on
loopback only by default (§2), access is closed by the one-time startup token (§1),
provider addresses and keys are validated (§3.3) and keys are encrypted at rest (§3.1).

| Limitation | Level | Where to look | What it means for the operator |
|---|---|---|---|
| Silent degradation of an empty registry | LOW | `server/source-registry.mjs:100-101`, `:113-114` | An empty source registry degrades silently: a warning goes to the log, but no UI/health field reports the degradation — research quality can drop without an explicit signal |
| HTTP status in a provider error | LOW | `server/routes/providers.mjs:257` | For an **allowed** external provider the error text still contains `HTTP <status>` — a weak port-scanner oracle. For a **rejected** endpoint the answer is anonymised (`provider_endpoint_rejected`, `:237-242`) and no outbound request is made |
| Suppressing the `--no-auth` warning | LOW | `server/lib/launcher-args.mjs:383`, :409 | The `--no-auth` warning can be suppressed with the `GENERAPTOR_NO_AUTH_WARNING_SHOWN` environment marker; the launcher flag cannot suppress it, but a direct process start can |
| The `Secure` flag on a network bind | LOW | `server/routes/auth.mjs:81-96` | The cookie's `Secure` flag is not implied automatically when the server is exposed off-loopback: by default it follows `NODE_ENV=production`/`COOKIE_SECURE`. With `--host 0.0.0.0` over plain HTTP the cookie is sent without `Secure`; the network-exposure warning is printed (§2) |
| Broadcast progress frames | LOW | `server/websocket.mjs:67`, `:81` | Progress frames are broadcast to every connected client, without a per-article subscription. The frames themselves contain no prompts, keys or absolute paths, but one client sees other articles' progress |
| The source registry as a trusted input | LOW | `server/lib/source-domains.mjs:46`, `:79-95` | The content of the source registry decides which hosts count as "own". The registry is a trusted input: its content defines the trust boundary |
| A placeholder contact in the User-Agent | LOW | `research-user-agent.mjs:15` | The contact domain in the research-layer User-Agent is the placeholder `+https://generaptor.local`. For a public deployment, replace it with a real contact |

### 7. Opensource hygiene, dependencies and CI gates

- `.env.example` lists only the shipped code's variables, every value empty.
  The `GENERAPTOR_ALLOW_PRIVATE_NETWORK` variable is in it — empty by default, so
  private addresses stay blocked (see §3.3).
- LICENSE — MIT.
- The release is domain-neutral. Cleanliness is held by the permanent
  `npm run lint:brand` gate (scans `src`, `server`, `scripts`, `prisma` —
  `scripts/brand-gate.mjs:38`), domain neutrality by the `npm run lint:universal`
  gate (`scripts/universal-gate.mjs:78`). Both gates run in CI.
- The release ships no publishing modules (WordPress integration) or their env block.
- **Dependencies.** Known advisories in the production tree are closed: `dompurify`
  3.4.17 (was 3.4.11 — advisories included a critical XSS), `undici` 7.30.2,
  `body-parser` 1.20.9, `proxy-addr` 2.0.8, `qs` 6.17.1 (via `overrides`,
  `package.json:49-55`), `source-map-js` 1.2.2 — the versions are pinned in
  `package-lock.json`. `npm audit --omit=dev` reports 0
  vulnerabilities. The dev tree still carries advisories in `vite`/`esbuild`/`vitest`
  — they do not ship and do not fail the CI gate.
- **CI.** The production tree is checked by a dedicated step
  `npm audit --omit=dev --audit-level=high` ("Dependency audit (no high/critical
  advisory in the production tree)", `ci.yml:71-72`); the install
  step keeps `--no-audit` so the work is not duplicated (`:36`). CI also runs
  `npx prisma generate` (`:39`), `npm test` (`:50`), `npm run build` (`:53`), e2e
  (`:59`), the brand gate (`:63`) and the universality gate (`:66`).
- **Line endings.** The LF contract is pinned in `.gitattributes:13`
  (`* text=auto eol=lf`).
- **Secrets in the repository.** The repository holds no project keys. Every user
  sets their own keys through the environment or the local encrypted store (§3.1).
