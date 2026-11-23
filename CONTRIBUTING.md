# Contributing to GeneRaptor

Thanks for taking the time to contribute. GeneRaptor is a local studio for
AI-assisted article generation: research, an agent pipeline, covers and export,
running from one command against one SQLite file.

The project is MIT-licensed (see [LICENSE](LICENSE)). Every contribution is
accepted under the same license.

## Requirements

- Node.js **20 or newer** (`engines.node` in `package.json`)
- npm (bundled with Node.js)

## Set up

```bash
npm ci
npm run build
npm start
```

`npm start` launches the local server and prints the UI URL plus a one-time
token. For development you can also run the frontend and the API separately:

```bash
npm run dev       # Vite dev server for the UI
npm run dev:api   # API only (node start.mjs --api-only)
```

## Run the gates before opening a pull request

```bash
npm test              # vitest run — the unit and integration suite
npm run lint:brand    # brand-neutrality gate over the shipped file set
npx tsc --noEmit      # TypeScript type check
npm run build         # tsc --noEmit && vite build
```

`npm run test:e2e` (Playwright) needs the browsers installed with
`npx playwright install`; run it when your change touches the UI or the
end-to-end flow.

The brand gate is a permanent guard: the shipped file set must not contain a
legacy brand name, a legacy domain, a legacy env var, a legacy cookie, a legacy
URN/attribute or a legacy CSS prefix. If the gate fails, rename the identifier
to its GeneRaptor counterpart — do not weaken the gate.

## Proposing a change

1. Fork the repository and create a branch with a descriptive name
   (`feat/…`, `fix/…`).
2. Keep the change focused, and keep the public file set brand-neutral.
3. Add or update tests for the behaviour you change.
4. Run the gates above; paste the results into the pull request.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages, in English: `feat: add cover refresh`, `fix: keep token single-use`.
6. Fill in the pull request template.

## Secrets and personal data

The repository ships **no API keys** — every user supplies their own. Keep it
that way:

- Put local keys in `.env` (copy `.env.example`) or in the encrypted local
  provider store. Both are git-ignored.
- Never commit `.env`, `provider-secrets.key`, a database file or an export
  with real content.
- Never paste a key into an issue or a pull request. If you report a problem
  that involved a key, describe the shape of the problem, not the value.
- Report security problems privately — see [SECURITY.md](SECURITY.md).

## Documentation

`README.md` is English and `README.ru.md` is Russian. The two files mirror
each other section by section: when you change one, change the other and keep
the same structure (same sections, same order, same lists and tables).
