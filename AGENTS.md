# AGENTS.md

## Secrets

**Never read `.env` (or any `.env.*` file).** It holds real secrets (provider keys,
`BETTER_AUTH_SECRET`, encryption keys). To inspect or edit configuration, use
`.env.example` as the reference, or ask the user. If you need to know a value, request
it rather than opening the file.

## Database access

**Never start a database server or connect to one yourself.** No `docker compose up`,
`docker exec … psql`, `psql`, port-forwarding, or ad-hoc scripts pointed at
`DATABASE_URL` — not even read-only, and not against the containers already running.
Ask the user to run the query, migration, or script and paste the output back.
Verify code with `pnpm exec tsc --noEmit` and `pnpm build` instead.

## Commands

- `pnpm dev` — start the dev server (Waku).
- `pnpm build` — production build.
- `pnpm exec tsc --noEmit` — typecheck.
- `pnpm db:generate` — generate a Drizzle migration from `src/db/schema.ts`.
- `pnpm db:migrate` — apply pending migrations (loads `.env` itself).
- `pnpm db:studio` — Drizzle Studio.
- `pnpm keys:rekey` — re-seal (or `--decrypt`) provider API keys; see "Provider API keys" below.
- `pnpm uploads:gc` — remove orphaned uploads (`--days N`, `--dry-run`); see "Uploads" below.

There is no test runner or linter configured. Verify changes with `pnpm exec tsc --noEmit` and `pnpm build`.

## Database migrations

Always give migrations a meaningful name via `--name`; never accept drizzle-kit's
random adjective+noun tags (e.g. `0011_lush_chronomancer`).

```
pnpm exec drizzle-kit generate --name add_message_refusal_and_annotations
```

Rules:

- Use a short, lowercase, snake_case description of the schema change
  (e.g. `add_message_refusal_and_annotations`, `add_folders_notes_tool_prefs`).
- Prefer `add_` / `drop_` / `alter_` prefixes so the change is obvious from the filename.
- One logical change per migration; don't mix unrelated tables in a generated file.
- Never edit an already-applied migration file or `drizzle/meta/*` by hand; create a
  new migration instead. Renaming/removing an applied migration requires dropping the
  change from the DB, deleting its row in `drizzle.__drizzle_migrations`, and removing
  the SQL + snapshot + journal entry before regenerating.

## Provider API references

Upstream API reference docs for each supported provider compatibility live in
`docs/providers/` — one file per provider (`lmstudio.md`, `openrouter.md`,
`bifrost.md`, …). Each file opens with a comment linking to the upstream docs it
mirrors (model list, chat completions, etc.). When adding or updating a provider
integration, first read its `docs/providers/*.md` and add any new upstream doc
links there before changing `src/server/catalog.ts` (model catalog) or
`src/server/runs.ts` / `src/server/complete.ts` (chat completions).

## Provider API keys

`provider_connections.api_key` holds either plaintext (when `PROVIDER_KEY_ENC_KEYS`
is unset) or an `enc:<version>:<base64>` envelope, so the column can't be trusted
as-is. Never send it upstream raw: seal writes with `encryptSecret()` and open
reads with `decryptSecret()` from `src/server/secrets.ts`. The only outbound uses
are `server/catalog.ts` (opened once in `getCatalog`), `server/complete.ts` and
`server/runs.ts`. `toDto` must keep returning only `hasApiKey`.

## Changelog

**Update `CHANGELOG.md` whenever you make a notable change** — a new feature, bug fix,
behavior change, provider integration, new script/command, or schema change. Add one
line under `## [Unreleased]` in the matching Keep a Changelog group (`### Added`,
`### Changed`, `### Fixed`, `### Removed`, `### Security`; create the group if it's
missing) as part of the same task as the code change. Entries are single lines in the
imperative mood. Don't backfill history predating the log, and only promote
`[Unreleased]` to a versioned heading (bumping `package.json` too) when the user
explicitly asks for a release.

## Uploads

An upload is an `attachments` row plus, for images, a file at
`$UPLOADS_DIR/<userId>/<attachmentId>` (default `uploads/`, see `src/server/uploads.ts`).
Messages reference uploads by id inside their `attachments` jsonb, so nothing cascades
on its own: any route that deletes messages or chats must hand the removed turns to
`pruneAttachments()` (`src/server/attachments.ts`), which drops the row and the file
only once no surviving message of that user still carries the id — an edit or a resend
reuses ids across branches. `pnpm uploads:gc` collects what slipped through (files taken
back out of the composer, leftovers from a deleted user).
