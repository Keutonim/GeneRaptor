# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

GeneRaptor is pre-1.0: fixes land on the latest release only.

## Reporting a vulnerability

Please report security vulnerabilities **privately** through GitHub Security
Advisories — on the repository page open the **Security** tab → **Advisories**
→ **Report a vulnerability**. The direct link is
`https://github.com/Keutonim/generaptor/security/advisories/new`.

Do not report vulnerabilities through public issues, discussions, or pull
requests.

When reporting, please include:

- A description of the vulnerability and its expected impact
- Steps to reproduce or a proof-of-concept
- Affected version and environment (operating system, Node.js version)

We will review reports and coordinate disclosure before any public fix is
released.

## Scope

**In scope:**

- Vulnerabilities in GeneRaptor's own code — the local web server and its
  access-token handling
- Encryption of provider keys at rest (AES-256-GCM)
- Local storage: the SQLite database and cover image files
- Handling of data received from search providers and LLM endpoints

**Out of scope:**

- Vulnerabilities in third-party services you configure (LLM providers, search
  APIs)
- Issues that require an already-compromised local machine or access to your
  data directory
- Misconfiguration such as deliberately exposing the server beyond its default
  loopback binding

## What the project does with keys and data

- The repository ships **no API keys**. Each user supplies their own, through
  the environment (a local `.env` file) or through **Settings → Providers**.
- Provider keys entered in the UI are stored in the local SQLite database,
  encrypted at rest with AES-256-GCM, using the key file `provider-secrets.key`
  in the local data directory. The key file is never sent to the browser.
- `.env`, the local data directory (`~/.generaptor/` by default) and build or
  report artifacts are git-ignored.
- The app runs on your own machine and listens on the loopback interface by
  default. The access gate is enabled by default and issues a single-use token
  that is printed to the terminal.

If you believe a key has been exposed — for example it appeared in a log, a
screenshot or an issue — rotate it at the provider first, then clean up the
local copy.

---

# Политика безопасности

## Поддерживаемые версии

| Версия  | Поддерживается |
| ------- | -------------- |
| 0.1.x   | Да             |

GeneRaptor пока в версии до 1.0: исправления выходят только в последнем
релизе.

## Как сообщить об уязвимости

Сообщайте об уязвимостях **приватно** через GitHub Security Advisories: на
странице репозитория откройте вкладку **Security** → **Advisories** →
**Report a vulnerability**. Прямая ссылка:
`https://github.com/Keutonim/generaptor/security/advisories/new`.

Не сообщайте об уязвимостях через публичные issue, обсуждения или
pull request.

При сообщении укажите:

- Описание уязвимости и ожидаемое воздействие
- Шаги для воспроизведения или proof-of-concept
- Затронутую версию и окружение (операционная система, версия Node.js)

Мы рассмотрим сообщение и скоординируем раскрытие информации до выхода
публичного исправления.

## Область

**В области ответственности:**

- Уязвимости в собственном коде GeneRaptor — локальный веб-сервер и
  обработка токенов доступа
- Шифрование ключей провайдеров на покое (AES-256-GCM)
- Локальное хранилище: база данных SQLite и файлы обложек
- Обработка данных, получаемых от поисковых провайдеров и LLM-эндпоинтов

**Вне области ответственности:**

- Уязвимости в сторонних сервисах, которые вы настраиваете (LLM-провайдеры,
  поисковые API)
- Проблемы, требующие уже скомпрометированной локальной машины или доступа к
  вашему каталогу данных
- Неправильная конфигурация, например намеренное открытие сервера за пределы
  стандартной привязки к loopback-интерфейсу

## Ключи и данные

- В репозитории **нет API-ключей**: каждый пользователь приносит свои — через
  переменные окружения (локальный `.env`) или через **Настройки → Провайдеры**.
- Ключи, введённые в интерфейсе, хранятся в локальной базе SQLite, зашифрованы
  на покое (AES-256-GCM) ключом из файла `provider-secrets.key` в локальном
  каталоге данных. Этот файл никогда не попадает в браузер.
- `.env`, локальный каталог данных (`~/.generaptor/` по умолчанию) и артефакты
  сборки исключены из git.
- Приложение работает на вашей машине и по умолчанию слушает на loopback-
  интерфейсе. Шлюз доступа включён по умолчанию и выдаёт одноразовый токен,
  который печатается в терминале.

Если вы считаете, что ключ мог утечь — например, появился в логе, на
скриншоте или в issue — сначала перевыпустите его у провайдера, затем удалите
локальную копию.