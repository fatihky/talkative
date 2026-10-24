# Talkative

A full-stack, multi-provider ChatGPT-style chat app with authentication. Bring your own LLM backend (OpenAI, OpenRouter, LM Studio, Ollama, Bifrost), hold branching conversations with streaming responses, and let the model call tools like web search, GitHub search, persistent memory, and artifacts.

## Features

- **Auth** — email/password sign-up and sign-in via [Better Auth](https://better-auth.com); every chat, provider, and memory is scoped to a user.
- **Bring your own provider** — register LLM backends with a base URL and API key. Keys stay server-side and can optionally be encrypted at rest. Each compatibility mode maps to a catalog fetcher: `openai`, `openrouter`, `lmstudio`, `ollama`, `bifrost`.
- **Server-side streaming** — generations run detached from the HTTP request and stream over SSE, so you can refresh or close the tab and resume where the reply got to.
- **Branching conversations** — messages form a tree; siblings are branches and you can switch the visible path per chat.
- **Tool calling** — a per-chat tool picker with per-tool backend selection:
  - `web_search` — Tavily, Serper, SerpAPI, SearXNG, Exa, Scrape.do
  - `http_fetch` — direct, Scrape.do, Tavily
  - `github_repo_search` / `github_issue_search` / `github_pr_search` / `github_discussion_search`
  - `memory` — persistent facts the model can save and recall across chats
  - `artifact` — write code, documents, and pages to an artifact panel
  - `ask_user` — the model asks you questions and waits for an answer
  - `chat_search` — search your other chats (requires explicit consent)
  - `get_current_timestamp`
- **Queued turns** — one generation runs per chat at a time; additional prompts wait in line and start automatically.
- **Decisions** — a `/decisions` workbench for the typed-evaluation API: evaluate one input against `predicate`, `choice` and `score` questions and get back probabilities, a chosen value, or a weighted level index with confidence. Runs are stored per user, and each provider is spoken to in its own dialect (OpenAI/LM Studio/Bifrost list form, OpenRouter's alpha map form).
- **System One** — a second decision API alongside `/decisions`: the native TypeSafe `/systemone` endpoint (LM Studio, OpenRouter, Ollama) answers the same `predicate`/`choice`/`score` questions map-form, spelled `noul` on the wire. Runs of both kinds share the `decisions` table, distinguished by a `kind` column (`decision` vs `systemone`).
- **Model catalog caching** — provider model lists are cached in Redis with a stale-while-revalidate fallback (Redis is optional).
- **Mock model** — demo catalog models stream a canned reply so the composer works with no provider configured.

## Stack

- [Waku](https://waku.gg) (React 19, React Compiler) + TypeScript
- [Tailwind CSS 4](https://tailwindcss.com)
- [Zustand](https://zustand-demo.pmnd.rs) for client state
- [Drizzle ORM](https://orm.drizzle.team) + PostgreSQL
- [Redis](https://redis.io) (optional) for catalog caching
- [Better Auth](https://better-auth.com)

## Getting started

```sh
pnpm install

cp .env.example .env
# fill in DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL

pnpm db:migrate
pnpm dev
```

The app runs at http://localhost:3000. Open **Settings** to add a provider connection, then start a chat.

Generate a secret with:

```sh
openssl rand -base64 32
```

## CLI

The package ships a `talkative` bin that serves the production build and runs the
maintenance tasks. You need Node.js 22.12+, PostgreSQL, and (optionally) Redis.

```sh
npm install -g @fatihky/talkative

mkdir talkative && cd talkative
cat > .env <<'ENV'
DATABASE_URL=postgres://localhost:5432/talkative
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
ENV

talkative migrate                    # creates the database if needed, applies migrations
talkative                            # serves on http://127.0.0.1:3000
talkative admin grant you@example.com
```

`talkative` works from the directory you run it in: it loads `.env` from there
(variables already present in the environment win) and stores uploads in `./uploads`
unless `UPLOADS_DIR` says otherwise. See [Environment variables](#environment-variables)
for the full list. Run `talkative migrate` again after every upgrade.

From a checkout, `pnpm build` and then `node bin/talkative.mjs` does the same.

| Command                                         | What it does                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `talkative [start]`                             | Start the server.                                                 |
| `talkative migrate`                             | Create the database if it's missing and apply pending migrations. |
| `talkative admin grant\|revoke <email\|id>`     | Grant or revoke admin rights.                                     |
| `talkative keys:rekey [--dry-run \| --decrypt]` | See [Provider API key encryption](#provider-api-key-encryption).  |
| `talkative uploads:gc [--days N] [--dry-run]`   | Remove orphaned uploads.                                          |

| Flag              | Env var | Default     | What it does                                                |
| ----------------- | ------- | ----------- | ----------------------------------------------------------- |
| `-p`, `--port`    | `PORT`  | `3000`      | Port to listen on.                                          |
| `--host`          | `HOST`  | `127.0.0.1` | Host to bind to; use `0.0.0.0` to listen on all interfaces. |
| `-h`, `--help`    | —       | —           | Show usage and exit.                                        |
| `-v`, `--version` | —       | —           | Print the version and exit.                                 |

## Environment variables

| Variable                      | Required | Description                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | yes      | PostgreSQL connection string.                                                                                                                                                                                                                                                                                                                                                     |
| `BETTER_AUTH_SECRET`          | yes      | Secret used by Better Auth.                                                                                                                                                                                                                                                                                                                                                       |
| `BETTER_AUTH_URL`             | yes      | Public base URL of the app (scheme + host), used by Better Auth as its base URL and as a trusted origin. No default; you must set it. On Coolify-based deployments this can be set to `$SERVICE_URL_APP`.                                                                                                                                                                         |
| `BETTER_AUTH_TRUSTED_ORIGINS` | no       | Comma-separated list of additional origins to trust.                                                                                                                                                                                                                                                                                                                              |
| `BETTER_AUTH_IP_HEADERS`      | no       | Comma-separated headers Better Auth reads the client IP from, in order (used for rate limiting). Defaults to `x-forwarded-for`. Use `cf-connecting-ip` behind Cloudflare (only if the origin isn't reachable directly) or `x-real-ip` behind nginx.                                                                                                                               |
| `BETTER_AUTH_TRUSTED_PROXIES` | no       | Comma-separated IPs/CIDRs of your reverse proxies. Required when `x-forwarded-for` carries more than one hop (e.g. Cloudflare → Traefik → app); the chain is walked right to left and the first untrusted hop is the client. Unset, a multi-value header is ignored and all clients share one rate-limit bucket. List only the proxies' own addresses, not a broad private range. |
| `REDIS_URL`                   | no       | Redis connection string for catalog caching. Defaults to `redis://localhost:6379`; the app runs without Redis.                                                                                                                                                                                                                                                                    |
| `CATALOG_REFRESH_MS`          | no       | How often (ms) provider model catalogs are refetched in the background to keep the cache warm. Defaults to `300000` (5 minutes); `0` disables the sweep.                                                                                                                                                                                                                          |
| `UPLOADS_DIR`                 | no       | Directory for uploaded images. Defaults to a local `uploads/` directory for Node-based deployments; Docker-based deployments should point it at the mounted `uploads-data` volume.                                                                                                                                                                                                |
| `PROVIDER_KEY_ENC_KEYS`       | no       | Versioned keyring: comma-separated `version:base64-32-byte-key` pairs (e.g. `v1:<key>,v2:<key>`). Unset means provider keys are stored in plaintext.                                                                                                                                                                                                                              |
| `PROVIDER_KEY_ENC_ACTIVE`     | no       | Version **label** used for new writes (e.g. `v1`), not a key. Unset defaults to the last entry in `PROVIDER_KEY_ENC_KEYS`.                                                                                                                                                                                                                                                        |
| `TAVILY_API_KEY`              | no       | Enables the Tavily `web_search` backend and `http_fetch`.                                                                                                                                                                                                                                                                                                                         |
| `SERPER_API_KEY`              | no       | Enables the serper.dev `web_search` backend.                                                                                                                                                                                                                                                                                                                                      |
| `SERPAPI_API_KEY`             | no       | Enables the SerpAPI `web_search` backend.                                                                                                                                                                                                                                                                                                                                         |
| `SEARXNG_URL`                 | no       | Enables the SearXNG `web_search` backend.                                                                                                                                                                                                                                                                                                                                         |
| `EXA_API_KEY`                 | no       | Enables the Exa `web_search` backend.                                                                                                                                                                                                                                                                                                                                             |
| `SCRAPEDO_API_KEY`            | no       | Enables the Scrape.do `web_search` / `http_fetch` backends.                                                                                                                                                                                                                                                                                                                       |
| `GITHUB_PAT`                  | no       | GitHub token for the GitHub search tools. Optional, but recommended for higher rate limits (required for discussion search).                                                                                                                                                                                                                                                      |

The tool keys above are shared with users according to the admin-only "environment key access" setting: `all`, `admins` (default) or `none`. Users can also add their own keys under **Settings → Tool keys**; those are stored encrypted.

## Provider API key encryption

Provider API keys are encrypted at rest with AES-256-GCM using a versioned keyring
that lives outside the database (environment / secret manager). Encryption is
optional: when `PROVIDER_KEY_ENC_KEYS` is unset, keys are stored in plaintext and the
app logs a warning at boot. Enabling it is non-breaking — any stored value that isn't
an `enc:<version>:<base64>` envelope (a pre-encryption row) is read through untouched.

Stored format (same `api_key` column, no migration):

```
enc:<version>:<base64( iv(12) | authTag(16) | ciphertext )>
```

### Generating keys

`PROVIDER_KEY_ENC_KEYS` is a comma-separated list of `version:base64-key` pairs. The
key must decode to exactly 32 bytes; the version is an arbitrary label (`v1`, `v2`, …)
used to pick the right key when decrypting. Generate one with:

```sh
openssl rand -base64 32
```

Then prefix it with a version:

```sh
echo "PROVIDER_KEY_ENC_KEYS=v1:$(openssl rand -base64 32)" >> .env
```

`PROVIDER_KEY_ENC_ACTIVE` is the version new writes are sealed with. It is optional —
unset, it defaults to the **last** version listed, so a single `v1:` entry needs no
`ACTIVE` at all. When set, it must be a version **label** that appears in the keyring
(`v1`), never the key material itself; an unknown label is fatal at boot.

> Note the `v1:` prefix is required. A bare key with no version is rejected at startup,
> as is an `ACTIVE` value that doesn't match a version in `PROVIDER_KEY_ENC_KEYS`.

### Enable (no downtime)

```sh
echo "PROVIDER_KEY_ENC_KEYS=v1:$(openssl rand -base64 32)" >> .env
pnpm keys:rekey --dry-run     # preview
pnpm keys:rekey               # seal existing rows
# restart the app
```

### Rotate

1. List both versions and point the active one at the new key, then restart — new
   writes use `v2`, `v1` rows still decrypt:

   ```sh
   PROVIDER_KEY_ENC_KEYS=v1:<old>,v2:<new>
   PROVIDER_KEY_ENC_ACTIVE=v2        # or just append v2 last and omit ACTIVE
   ```

2. `pnpm keys:rekey` — re-seal the `v1` rows.
3. When the summary reports no `v1` rows left, drop `v1` from
   `PROVIDER_KEY_ENC_KEYS` and restart.

**Compromise:** rotate and rekey immediately. Dropping a version while rows are still
sealed with it makes those keys unrecoverable — affected users must re-enter them.

### Disable / escape hatch

```sh
pnpm keys:rekey --decrypt      # while the keyring is still configured
# then unset PROVIDER_KEY_ENC_KEYS
```

### Verify at any time

```sql
select left(api_key, 8) v, count(*)
  from provider_connections
 where api_key is not null
 group by 1;
```

## Scripts

| Script                                                           | Description                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                                                       | Start the dev server.                                                                                        |
| `pnpm build`                                                     | Build for production.                                                                                        |
| `pnpm start`                                                     | Run the production build.                                                                                    |
| `pnpm typegen`                                                   | Generate Waku router types.                                                                                  |
| `pnpm db:generate`                                               | Generate Drizzle migrations from the schema.                                                                 |
| `pnpm db:migrate`                                                | Apply migrations.                                                                                            |
| `pnpm db:studio`                                                 | Open Drizzle Studio.                                                                                         |
| `pnpm admin:grant <email\|id>` / `pnpm admin:revoke <email\|id>` | Grant or revoke admin rights.                                                                                |
| `pnpm keys:rekey`                                                | Re-seal (or `--decrypt`) provider API keys. See [Provider API key encryption](#provider-api-key-encryption). |
| `pnpm uploads:gc`                                                | Remove orphaned uploads (`--days N`, `--dry-run`).                                                           |

## Project structure

```
bin/                 # talkative CLI entry point
scripts/             # maintenance scripts (admin, rekey, uploads-gc)
drizzle/             # SQL migrations
src/
  pages/            # routes (Waku file-based routing)
    _api/api/       # server API routes (mounted at /api/*)
    c/[slug].tsx    # chat thread page
  components/        # UI components
  server/            # auth, chats, runs (agent loop), tools, decisions, catalog, sse
  db/                # Drizzle schema and client
  lib/               # shared helpers (tools, decisions, api client, auth, artifacts)
  stores/            # Zustand stores
```

## Notes

- **Single-instance only.** Live generations and pending `ask_user` questions are held in process memory, so a second server process won't see in-flight runs.
- Adding a new environment variable? Also add it to `.env.example`.

## License

[MIT](LICENSE)
