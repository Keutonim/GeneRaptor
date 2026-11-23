<p align="center">
  <img src="docs/assets/generaptor.png" alt="GeneRaptor — a local AI article studio" width="100%">
</p>

# GeneRaptor

[![CI](https://github.com/Keutonim/generaptor/actions/workflows/ci.yml/badge.svg)](https://github.com/Keutonim/generaptor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3d20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**A local studio for AI-assisted article generation.** One command starts the app and
opens it in your browser — no token to type — and one SQLite file stores everything.

GeneRaptor turns a topic into a researched, structured, fact-checked article with
a cover image — locally, on your machine, without a cloud account.

The product is industry-neutral: the same eleven roles write for any business and
any topic, and a permanent gate keeps domain-specific wording out of the shipped
code.

---

## Requirements

- **Node.js 20 or newer** (the CLI and the build both need it)
- An API key for an LLM provider (RouterAI by default; OpenRouter, Ollama or any
  OpenAI-compatible endpoint also work). You can add it later in the UI — see
  **Configuring your keys**.

## Install and run

```bash
npx generaptor
```

The command starts the local server, prints the URL and a **one-time token** in
your terminal, and opens the app in your default browser:

```
  GeneRaptor is running!
     UI:          http://127.0.0.1:5173 (Vite dev server)
     API health:  http://127.0.0.1:8787/api/health
     WS:          ws://127.0.0.1:8787/ws
     Data dir:    C:\Users\you\.generaptor
[Auth] ----------------------------------------------------------
[Auth] token: <one-time token, 43 characters>
[Auth] Paste this token at http://127.0.0.1:5173 to unlock the app.
[Auth] ONE-TIME: single use, valid for 15 min
[Auth] ----------------------------------------------------------
[Auth] Opening the app in your default browser…
```

**You never type the token.** The browser opens with the token in the URL
fragment, the app exchanges it for a session cookie by itself and removes the
token from the address — you land straight in the studio. The token stays
single-use and valid for 15 minutes; the terminal copy is only a fallback.

**Closed the tab?** The session cookie belongs to the browser, not to the tab:
press **Refresh** in the old tab — the app probes its status, sees the session
and opens the studio. If the tab was closed before the exchange happened, start
the studio again: it opens a fresh tab with a fresh token. The manual path is
always there too — open the printed URL and use the **"Enter a token manually"**
link on the hint screen.

Prefer to open the browser yourself? Start with `--no-browser`, open the printed
URL and use the same "Enter a token manually" link.

Install it globally if you prefer a shorter command:

```bash
npm install -g generaptor
generaptor
```

From a clone of the repository:

```bash
npm ci
npm run build
npm start
```

### CLI options

| Option | Description |
| --- | --- |
| `--port <n>` | Port for the local server (default `5173` in dev, `8787` for a packaged build) |
| `--data-dir <path>` | Directory that holds the SQLite database (default `~/.generaptor`) |
| `--no-auth` | Disable the access gate — the app starts without a token and prints a loud warning (the browser still opens, just without a token) |
| `--token <value>` | Use a fixed reusable token instead of the one-time startup token — the browser is then **not** opened automatically, because a reusable token never goes into an address bar |
| `--token-ttl <value>` | Lifetime of the session cookie: `session` (until the browser closes), `24h` (default), `7d`, `30d` |
| `--host <address>` | Interface the API binds to (default `127.0.0.1`, loopback only) — the address is required, and a non-loopback bind prints a network-reachable warning |
| `--no-browser` | Do not open the browser automatically — print the URL and the token, then enter the token manually |
| `--help`, `-h` | Show the help text and exit |
| `--version`, `-v` | Print the version and exit |

## First generation

1. The app opens in your browser by itself — no token entry is needed.
2. Go to **Settings → Providers**, pick a provider, enter the API key and save.
3. Go to **Settings → Models** and choose a model for each tier.
4. Switch to the **Generation** tab, type a topic, and start the run.

Below the topic there is an optional **"Topic clarifications"** field with an
`{n}/1000` counter (1000 characters max). Your notes are injected into the
author's and the brief preparer's prompts as priority guidance for emphasis and
delivery — they never override facts, professional correctness or the SEO core.
An empty field is not stored; the field resets after a successful start.

The pipeline plans the structure, researches the topic, writes the article,
fact-checks it and prepares the cover. Progress arrives live over a WebSocket.

## The three tabs

| Tab | What it does |
| --- | --- |
| **Generation** | Write a topic, add topic clarifications, watch the agent pipeline, refine the result, generate and edit the cover |
| **History** | Browse finished articles, open the full run sheet, copy or download the text and the cover, delete an article |
| **Settings** | Providers and keys, models per tier, cover generation, agent roles, language and theme |

## Providers and models

Four provider kinds are supported: **RouterAI**, **OpenRouter**, **Ollama**
(local models) and **custom** (any OpenAI-compatible base URL). Providers and
their keys are stored in your local database — the API key is never sent back
to the browser.

Stored keys are encrypted at rest (AES-256-GCM). The encryption key lives in
its own file next to the database (`provider-secrets.key`, mode `0600` on POSIX),
so a copy of the database alone does not reveal the keys.

RouterAI and OpenRouter ignore a saved address and use their canonical
endpoint; the operator can point RouterAI at another address through the
environment. A **custom** base URL is checked before it is used: only
`http`/`https`, no credentials inside the URL, and no private, loopback,
link-local, CGNAT or cloud-metadata address — unless you set
`GENERAPTOR_ALLOW_PRIVATE_NETWORK=true` (Ollama may use loopback). Each key is
bound to one address: an environment key is only sent to the canonical or
operator-configured endpoint, and a saved key only to the endpoint of its own
provider — canonical for RouterAI and OpenRouter, the saved address for a
custom provider.

**Provider endpoint.** The base URL field is editable under **Settings →
Providers** for **custom** and **Ollama** only: RouterAI and OpenRouter have a
fixed address (set through the environment; the field shows a hint instead).
A **custom** provider requires an address — saving without one is rejected.
The server validates the address before writing it: `http`/`https` scheme, no
login/password inside the URL, no private or loopback addresses (except
Ollama). A server refusal is shown **at the field** with the canonical reason
text (for example, "Private-network addresses are blocked by policy"), not a
generic "Bad Request"; the client understands both server error shapes — flat
and nested.

Models are assigned per tier, so the expensive model only handles the critical
steps:

| Tier | Used for |
| --- | --- |
| `critical` | Planning, fact-checking and quality control |
| `generation` | Writing and rewriting the article |
| `standard` | Research and secondary steps |
| `cover` | Image generation for the cover — a read-only row: the model is managed in the "Cover generation" section |

## Web search

The research step uses one pluggable web-search layer with several backends.
**Serper.dev is the primary engine** (a free key — no card required); **Tavily free
is the fallback** (a free key, 1,000 credits/month). Without any key the free
fallback chain runs: keyless Tavily → Wikipedia → Wikidata, and an empty result is a
valid answer, never an error. The chain degrades honestly — keyless Tavily answers
403 from some hosts, and the chain moves on to Wikipedia instead of failing.

| Backend | Key | Notes |
| --- | --- | --- |
| Serper.dev | `GENERAPTOR_SERPER_API_KEY` | the primary engine — free key, no card (2,500 starter queries); the real answer ceiling is **10 results**, pagination is not supported |
| Tavily | `GENERAPTOR_TAVILY_API_KEY` | fallback keyed backend (1,000 credits/month) |
| Tavily (keyless) | — | the same endpoint in anonymous mode; some hosts refuse it |
| Yandex Search API | `GENERAPTOR_YANDEX_API_KEY` | paid; only used when you pick it explicitly |
| Wikipedia / Wikidata | — | official, free, keyless |
| DuckDuckGo | — | unofficial scraping, opt-in only, never in the automatic chain |

Topic verticals — OpenAlex, Crossref, Europe PMC, GDELT, Nominatim, OpenLibrary,
Stack Exchange, Hacker News — are keyless sources consulted automatically when the
topic matches; they are never offered as the primary search engine and add their
results on top of the main chain with per-item attribution.

Pick the backend in **Settings → Providers → Search sources**; the choice is stored
in your browser and applied to the search requests. The verticals are listed there
with a "used automatically by topic" note, and the block honestly hints that a Serper
key enables the primary engine while the free chain works without any key. The block
shows the environment variable name of the selected backend and whether it is
configured — there is no search-key field in the UI, so search keys live in the
environment only.

Set a key in `.env` (see `.env.example`):

```bash
GENERAPTOR_SEARCH_BACKEND=serper   # auto | tavily | tavily-keyless | serper | yandex | wikipedia | wikidata | duckduckgo
GENERAPTOR_SEARCH_LANG=ru          # ru | en
GENERAPTOR_SERPER_API_KEY=…        # or GENERAPTOR_TAVILY_API_KEY / GENERAPTOR_YANDEX_API_KEY
```

Without a Serper key the primary engine stays off and the free fallback chain is used
(keyless Tavily → Wikipedia → Wikidata), so research is thinner — set
`GENERAPTOR_SERPER_API_KEY` for full-quality results; Yandex remains a paid, opt-in
choice.

**Serper.dev key:** get a free key at [serper.dev](https://serper.dev) — no credit
card required — and enable it with `GENERAPTOR_SERPER_API_KEY` in your `.env` (see
`.env.example`) or in your shell environment before starting the app. Serper.dev is
the primary search engine; without a key the free fallback chain (keyless Tavily →
Wikipedia → Wikidata) is used. The real answer ceiling is **10 results** per
query even when more are requested, and there is no pagination — source-expansion
passes stop when a pass adds no new links, so one article spends two search
credits (the initial collection + one pass) instead of six.

## Configuring your keys

**This repository ships no API keys.** Every user brings their own, in one of two
ways:

- **Environment** — put the key in a local `.env` file (start from `.env.example`)
  or export it in the shell before starting the app. The variables the app reads
  are listed in `.env.example`; `ROUTERAI_API_KEY` is the one for the default
  provider.
- **Settings** — add the key under **Settings → Providers**. It is encrypted at
  rest (AES-256-GCM) and never returned to the browser.
- **Search backends** — the web-search layer reads its keys from the environment
  only (`GENERAPTOR_TAVILY_API_KEY`, `GENERAPTOR_SERPER_API_KEY`,
  `GENERAPTOR_YANDEX_API_KEY`); the UI has no search-key field. See the Serper.dev
  note in **Web search** above.

The `.env` file and the local data directory (by default `~/.generaptor/`, which
holds the database and the `provider-secrets.key` file) are git-ignored: keep
them out of version control, and never paste a key into an issue or a pull
request.

## Agent roles

Eleven roles make up the pipeline: topic selection, brief preparation,
knowledge-base curation, research, semantic strategy, structure design,
authoring, fact-checking, SEO review, quality control and humanization. Each
role can be switched on or off and can use a different model per tier in
**Settings → Roles**.

## Covers: fresh and refine

The cover panel generates an image for the article and lets you keep iterating:

- **Fresh** — generate a new cover from the current prompt.
- **Refine** — describe the change you want (up to 500 characters) and
  regenerate on top of the current cover.

Resolution (`512`, `1K`, `2K`, `4K`), quality (`auto`, `low`, `medium`, `high`)
and format (`png`, `jpeg`, `webp`) are configurable, plus a monthly budget in
rubles that stops runaway spending.

### The "Cover generation" panel

Every cover generation parameter lives in one place — **Settings → Cover
generation**:

- **Image model** — the generation model (a supported list or your own id);
- **Article compression model** — an optional override; an empty value inherits
  the `standard` tier model from the environment;
- **Format** — the aspect ratio (`16:9`, `1:1`, `9:16` and others);
- **Resolution** — `512`, `1K`, `2K`, `4K`;
- **Quality** — `auto`, `low`, `medium`, `high`;
- **File** — the output image format: `png`, `jpeg`, `webp`;
- **Prompt template (SYSTEM)** — the illustrator agent's prompt (up to 8000
  characters, stored byte-identical; "Reset to template" restores the default
  locally without writing);
- **Generate automatically** — create the cover right after the article;
- **Monthly limit, ₽** — the budget that stops generation when exhausted.

The panel is the **single source of truth** for the cover model: the `cover`
tier row under "Models" only displays the current model and re-reads it after
the panel saves. The settings are stored in the SQLite database (the
`cover_settings` table); the images themselves live in `<data-dir>/covers/`
(see **Where the data lives**).

## Export and images

Every finished article can be copied or downloaded as **HTML**, **plain text**
or **Markdown**. The cover image is downloadable separately as a file.

## One-time token

GeneRaptor is meant to run on your own machine, but the access gate is on by
default:

- On every start the launcher generates a **one-time token**, prints it in the
  terminal once and opens the browser with the token in the URL **fragment**
  (`#token=…`). A fragment never reaches the server, so the token cannot end up
  in the request logs or in a `Referer` header.
- The app exchanges the token for a session cookie automatically — exactly one
  attempt, no input field, no page reload — and then removes the fragment from
  the address and from the history entry. The token is stored nowhere in the
  browser: the session lives in an httpOnly cookie (`generaptor_auth`,
  `SameSite=Lax`, path `/`, `Secure` only behind TLS, lifetime 24 h by default —
  `--token-ttl session` makes it a browser-session cookie).
- The token is single use and valid for 15 minutes. A repeated exchange is
  rejected with 401; a restart issues a new token and (without an explicit
  `ACCESS_GATE_HMAC_KEY`/`JWT_SECRET`) invalidates the old cookies. An already
  open tab then shows a hint — press **Refresh** there once the new tab has
  opened the app.
- If the exchange fails, the app shows a hint screen instead of an input: a
  stale link, a rate limit (with a countdown and an automatic retry) or an
  unreachable server. The secondary link **"Enter a token manually"** opens the
  classic token screen — that is the fallback path, not the main one.
- `--no-browser` skips the auto-open: open the printed URL yourself and use the
  manual link. Auto-open is also skipped in CI, in a non-interactive terminal
  (no TTY on stdout), under `NODE_ENV=test`, when a fixed `--token` is used and
  when the UI is not served; a failed open never crashes the launcher — it
  prints the URL to open by hand.
- `--token <value>` pins a reusable token instead; `--token-ttl` sets how long the
  session cookie lives. A fixed token is never put into the browser address —
  auto-open is skipped and the manual link is the way in.
- `--no-auth` turns the gate off. It prints a loud warning, because then anyone
  who can reach the port can use the app. The browser opens without a token and
  the app is available immediately. `GET /api/auth/status` then answers
  `{"authenticated": true}` even without a cookie: the gate is off, so every
  caller is authorized — a public fact of the configuration, not a bypass. The
  client always branches on that body, never on the HTTP code.
- The manual screen stays as a **fallback**, not as the main path. The one-time
  token is delivered in the URL fragment, which never reaches the server, while
  a reusable `--token` must not be written into an address bar or into the
  browser history at all. The manual screen is what you need with `--token`,
  with a remote bind, or to get in without restarting the studio.
- Logging out clears the cookie in the browser. The session token itself is
  stateless (an expiry plus an HMAC), and there is no server-side revocation
  list — a cookie value copied before the logout stays valid until it expires.
- Honest boundaries: there is no separate CSRF token — protection =
  `SameSite=Lax` + the `Origin`/`Referer` check + CORS. The default
  `CORS_ORIGIN` trusts local `localhost:5173` in every mode: an accepted risk
  of a local tool (follow-up — same-origin only in prod). The token is visible
  in the address bar only until the auto-exchange — and stays there on a rate
  limit or a network failure, because the token is still alive and the attempt
  has to stay repeatable. The app shell is not the session — the server confirms
  authorization. On 429 the client makes at most two automatic retries, then a
  static hint and the Refresh button.

The gate covers every `/api` path, whatever the letter case it is written in.
The server also rejects requests whose `Host` header points at another host, and
state-changing `/api` requests that carry a foreign `Origin`.

## Language and theme

The interface is bilingual (Russian and English) and switches instantly; the
choice is remembered in the browser. The theme has **light**, **dark** and
**auto** modes and is remembered the same way.

## Where the data lives

Everything is local. The SQLite database is created on the first start:

| Place | How to change it |
| --- | --- |
| `~/.generaptor/generaptor.db` | default |
| `--data-dir <path>` | CLI flag (highest priority) |
| `GENERAPTOR_DATA_DIR` | environment variable |
| `DATABASE_URL` | full database URL (wins over the data dir) |

No PostgreSQL, no Redis, no cloud storage. Back up the database file if you
want to keep your articles — and keep `provider-secrets.key` next to it, because
without that file the stored provider keys cannot be decrypted.

The data directory is created with mode `0700`, the database file and the cover
files with `0600` (on POSIX; on Windows this is best effort — the security
boundary is the NTFS ACL). Covers live in `<data-dir>/covers/` as
`<articleId>-<n>.<ext>` files; the database keeps only the file reference. When
the data directory sits in a shared location, the launcher prints a privacy
warning.

### Deleting an article

In **History**, delete an article through the row's action menu ("…") →
**Delete**. An opaque confirmation dialog appears on its own layer: "The
article “{topic}” will be deleted permanently" with a **Delete permanently**
button. After confirmation the article is removed from the database **together
with its cover files** in `<data-dir>/covers/`. Cancel closes the dialog
without changes; a deletion error is surfaced at the action, not only in the
console.

## Renamed settings

Every environment variable now starts with `GENERAPTOR_`. The names of the
previous build are no longer read — there is no legacy fallback, so an
outdated `.env` is ignored silently:

| Setting | Name |
| --- | --- |
| API port | `GENERAPTOR_API_PORT` |
| UTM tagging in links | `GENERAPTOR_UTM_ENABLED` |
| Access-gate cookie | `generaptor_auth` |
| Source-site registry | `GENERAPTOR_SOURCE_REGISTRY` |

After an upgrade, rename the port variable in your `.env` — otherwise the
API falls back to `8787` and the port you picked is ignored.

## Source sites

GeneRaptor ships with **no source sites registered**: the research stage
falls back to open web search, and everything it finds is treated as a
secondary source. Pin your own sites with `GENERAPTOR_SOURCE_REGISTRY`, a
path to a JSON file:

```json
{
  "sites": [
    {
      "id": "example",
      "name": "Example",
      "baseUrl": "https://example.com",
      "doctorsIndex": "https://example.com/doctors",
      "servicesIndex": "https://example.com/services"
    }
  ]
}
```

The file is read once at startup. A missing or broken file is a warning, not
a crash — the app keeps working with web search only.

`doctorsIndex` and `servicesIndex` are the field names the registry parser
accepts; they are legacy names kept for compatibility and point at your own
pages, whatever those pages describe.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Prisma client is not ready` | Run `npx prisma generate` in the install folder — `npm install` normally does it for you |
| The port is already in use | Start with `--port <other-port>` |
| The startup link is stale / the token is rejected | The one-time token was already used by the auto-exchange, or its 15-minute window expired, or the server restarted — restart the studio: it opens a fresh tab with a new token. In an old tab press **Refresh** |
| The browser did not open | Auto-open is best-effort (and skipped in CI / a non-interactive terminal / with `--no-browser` or `--token`). Open the URL printed in the terminal and use the "Enter a token manually" link with the token from the banner |
| The tab was closed | The session cookie belongs to the browser, not to the tab — press **Refresh** in the old tab and the app picks the session up. If the tab was closed before the exchange happened, restart the studio: it opens a fresh tab with a fresh token |
| Generation fails immediately | Add an API key in **Settings → Providers** and check the model for each tier |
| The database has an old schema | Delete the `.db` file in the data dir: the app recreates it with `prisma db push` on the next start |
| Nothing happens after `npx generaptor` | The terminal holds the URL and the token — scroll up in the console where you started it, open the URL and use the manual token link |
| `EADDRINUSE` from the API | The API uses `8787` in dev mode; stop the other process or set `GENERAPTOR_API_PORT` — the old port variable name is no longer read |

## Development

```bash
npm ci              # install dependencies
npm run dev         # Vite dev server + API, hot reload
npm test            # unit tests (vitest)
npm run test:e2e    # end-to-end tests (playwright, own SQLite stack)
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build
npm run db:studio   # Prisma Studio on the local database
npm run lint:brand   # brand gate: no legacy brand tokens in the shipped set
```

The CI (`.github/workflows/ci.yml`) runs the same steps on Node.js 20 and 22, plus
a production dependency audit (`npm audit --omit=dev --audit-level=high`) that
fails the build on a high-or-higher advisory.

The e2e suite starts its own API and Vite server on the default ports `8787` and
`5173`. If something else already holds them, run it in an isolated mode on free
ports:

```bash
GENERAPTOR_E2E_API_PORT=8899 GENERAPTOR_E2E_UI_PORT=5199 npm run test:e2e
```

The two variables change the **test stack only** — they are not product settings
and the app never reads them. With an explicit UI port the suite does not reuse
a server that is already listening there: that server could be somebody else's
application.

## License

[MIT](LICENSE) © GeneRaptor contributors
