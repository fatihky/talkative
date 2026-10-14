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

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `BETTER_AUTH_SECRET` | yes | Secret used by Better Auth. |
| `BETTER_AUTH_URL` | yes | Public base URL of the app (scheme + host), used by Better Auth as its base URL and as a trusted origin. No default; you must set it. On Coolify-based deployments this can be set to `$SERVICE_URL_APP`. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | no | Comma-separated list of additional origins to trust. |
| `REDIS_URL` | no | Redis connection string for catalog caching. Defaults to `redis://localhost:6379`; the app runs without Redis. |
| `UPLOADS_DIR` | no | Directory for uploaded images. Defaults to a local `uploads/` directory for Node-based deployments; Docker-based deployments should point it at the mounted `uploads-data` volume. |
| `PROVIDER_KEY_ENC_KEYS` | no | Versioned keyring: comma-separated `version:base64-32-byte-key` pairs (e.g. `v1:<key>,v2:<key>`). Unset means provider keys are stored in plaintext. |
| `PROVIDER_KEY_ENC_ACTIVE` | no | Version **label** used for new writes (e.g. `v1`), not a key. Unset defaults to the last entry in `PROVIDER_KEY_ENC_KEYS`. |
| `TAVILY_API_KEY` | no | Enables the Tavily `web_search` backend and `http_fetch`. |
| `SERPER_API_KEY` | no | Enables the serper.dev `web_search` backend. |
| `SERPAPI_API_KEY` | no | Enables the SerpAPI `web_search` backend. |
| `SEARXNG_URL` | no | Enables the SearXNG `web_search` backend. |
| `EXA_API_KEY` | no | Enables the Exa `web_search` backend. |
| `SCRAPEDO_API_KEY` | no | Enables the Scrape.do `web_search` / `http_fetch` backends. |
| `GITHUB_PAT` | no | GitHub token for the GitHub search tools. Optional, but recommended for higher rate limits (required for discussion search). |

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

| Script | Description |
| --- | --- |
| `pnpm dev` | Start the dev server. |
| `pnpm build` | Build for production. |
| `pnpm start` | Run the production build. |
| `pnpm typegen` | Generate Waku router types. |
| `pnpm db:generate` | Generate Drizzle migrations from the schema. |
| `pnpm db:migrate` | Apply migrations. |
| `pnpm db:studio` | Open Drizzle Studio. |
| `pnpm keys:rekey` | Re-seal (or `--decrypt`) provider API keys. See [Provider API key encryption](#provider-api-key-encryption). |

## Project structure

```
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
