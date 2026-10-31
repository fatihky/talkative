# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The log starts on 2026-10-14; changes made before that are not backfilled.

## [Unreleased]

### Added

- Render GitHub `github_repo_search`, `github_issue_search`, `github_pr_search` and `github_discussion_search` results in the thread as clickable title/URL/detail links, like `web_search`, with the raw API response behind the "inspect raw results" disclosure.

- Show the provider connection's name above the model name in each assistant message header, so replies to a model served by several connections stay distinguishable.
- Add a per-user Enter-key preference for the composer: Enter can send the message or start a new line (Shift+Enter always breaks, ⌘/Ctrl+Enter always sends). Set it on `/settings/appearance` or by clicking the send hint in the composer footer; it is stored server-side and follows the account across devices.
- OpenTelemetry: `instrumentation.mjs` is preloaded with `node --import` by `pnpm dev`, `pnpm start`, the packaged `talkative` CLI and the Docker image, and reports a service name (new `OTEL_SERVICE_NAME`, default `talkative`). Configure the exporter with the standard `OTEL_*` variables.

### Changed

- Show a "Model override saved" / "Model override reset" toast when an override is saved from the dialog, hidden, unhidden or reset on `/settings/providers`.
- Show a "Tool settings saved" toast once a tool-preference edit is persisted, so a grant, provider, result-count or concurrency change no longer saves silently.
- Filter the capability-overrides list on `/settings/providers` by provider in the browser, over the list already loaded, instead of refetching it with `?provider=<name>`; hidden models now carry their provider name so they filter too.

### Fixed

- Let the model-override dialog turn a capability off, not just on: the form now sends only the `Supports` checkboxes that differ from the catalog row (the old body only ever sent `true` values, so unticking a tool-capable model did nothing), and the PUT drops a block that merely restates the provider's flags so it can't pin today's catalog.
- Unwrap Google's `google.com/goto` and `/url?q=` redirect links in scrape.do search results: the backend now asks for `resolveGoto=true` and any redirect left in `link` is resolved locally, so the model and the tool card see the publisher URL.
- Give every outside link `rel="noopener noreferrer"`, including markdown and artifact links, which previously only had `noreferrer`, and the search results in tool calls, which had neither `noopener`.
- Stop sending `reasoning_effort` to models whose reasoning capability is unknown — `GET /v1/models` exposes none for openai and ollama, so every request carried a guessed `medium` that models without the parameter reject with a 400; a model with `thinkingLevels: []` still gets no effort on any compatibility.
- Skip System One/decision models when background jobs like chat classification pick a model, so an ollama connection whose first model is a decision model no longer fails with `"<model>" does not support chat`.
- Show each provider's models on `/settings/providers` as one group instead of splitting them into many small groups that followed the alphabetical order across providers.
- Keep every provider chip on `/settings/providers` while one is selected, so you can switch providers directly, and offer every connection to Add model while a filter is on.
- List hidden custom models on `/settings/providers` so they can be unhidden.
- Stop the page's slow first catalog refresh on `/settings/providers` from overwriting a newer model list.
- Stop saving a capability override from writing back the catalog values the form was prefilled with: only ticked supports are sent, and an untouched thinking list is no longer saved as "takes no effort", so saving one field no longer wipes the provider's thinking levels and disables the composer's effort picker.

## [0.2.2] - 2026-10-29

> 🇹🇷 Cumhuriyetimizin 103. yılı kutlu olsun!

### Added

- Make the model list on `/settings/providers` editable: correct a model's name, context window, thinking levels/default and other capabilities, set its USD-per-million pricing, hide models from every picker, and add models the provider doesn't list (with their own upstream name and optional base URL) — with Reset returning a model to what the provider reports. Overrides are stored per user in a new `model_overrides` table and applied wherever the catalog is read: the composer, decisions runs, settings, and the server's reasoning-effort lookup.
- Show local model sizes (and quantization) in the composer's model selector, replacing the $0/M pricing line for lm studio and ollama models.
- Filter the model catalog on `/settings/providers` when a provider name is clicked, and show the active provider as a clearable badge above the list.

### Changed

- Make the sidebar's "New chat" buttons links to `/`, so cmd/ctrl/shift-click (or middle-click) opens a fresh chat in a new tab.

### Fixed

- Send the running app's real version in the `talkative/<version>` user-agent (read from `package.json` instead of a stale hardcoded `0.1.0`), and give the `http_fetch` tool's own requests the same version instead of a hardcoded `1.0`.
- Omit the reasoning effort entirely for a model that reports no selectable level (`thinking: unknown`), instead of sending an empty `reasoning: {}` to bifrost or a guessed `reasoning_effort` elsewhere.
- Send the opened provider API key with the `/models` lookup that resolves bifrost reasoning effort, so the request is no longer rejected for a missing virtual key.
- Filter the capability-overrides list on `/settings/providers` by the focused provider server-side (`?provider=<name>`), so the row count, rows and hidden models all match that provider — including a provider whose every model is hidden — and the clearable provider chips now come from the configured connections instead of the visible rows.

## [0.2.1] - 2026-10-28

### Changed

- Stop snapping the sidebar width to fixed presets on resize release; keep it exactly where the pointer is dropped.

### Fixed

- Resolve the reasoning effort against the model's reported levels before sending it upstream (bifrost forwards `reasoning.effort` verbatim, so an unlisted level was a 400), omit the parameter entirely for models with no selectable effort instead of guessing one, never send `none` for "off", and stop the composer displaying a level a model can't take when the model reports none. A clamped level is noted in the transcript.
- Stop the chat behind the mobile drawer from scrolling when a touch drag starts on the drawer scrim (or on the chat list once it has reached its end).

### Added

- Show the hover action row (copy, provider stats, delete) under private chat message bubbles.
- Retry `web_search` and `http_fetch` upstream calls that answer 429, backing off on the provider's own `Retry-After`/`X-RateLimit-*` hints and sharing a per-provider cooldown across concurrent calls.

## [0.2.0] - 2026-10-24

### Added

- Let `ask_user` ask multi-select questions: the model can set `multi_select` (globally or per question) and the card's options toggle instead of replacing each other, sending the picked labels joined by ", ", while typing a free-text answer still overrides the picks.
- Backdate a send by opening it with a `[yyyy/mm/dd HH:mm]` prefix: the turn (and its reply) are timestamped to that local wall-clock time and the prefix is dropped from the stored text, so long-running chats can slot historical entries into the transcript.
- Add a composer clock toggle that, for one send, prefixes every history turn sent to the model with its `[yyyy/mm/dd HH:mm]` timestamp so a long conversation carries its timeline into context.
- Store the timestamp-prefix toggle on the user turn (`messages.timestamp_prefix`) and mark such turns with a clock icon in the transcript; regenerating or retrying their reply re-sends the history timestamped too.
- Add ranked full-text message search on Postgres GIN indexes (`simple` config, expression indexes over message text and, optionally, reasoning and tool-call output) plus `pg_trgm` indexes for substring matches; queries support prefix words, `"phrases"`, `-exclusions` and `or` (migrations `add_pg_trgm_extension` and `add_message_search_indexes`).
- Add a `/search` page (sidebar and palette "See all results") with author, time range, folder, model, reasoning/tool-output and sort filters, highlighted snippets grouped by chat, and infinite scroll.
- Add find-in-chat (⌘F / Ctrl+F or the thread header's search button) that highlights matches on the visible branch and steps through them.
- Open a search hit at its message: `/c/<chat>?m=<message>&q=<query>` switches to the hit's branch, centers and flashes the message and highlights the matched words.

### Changed

- Give a streaming reply up to 10 minutes to send its first chunk (so a local backend like LM Studio can finish prefilling a long prompt) and raise the between-chunk idle timeout from 2 to 5 minutes before reporting "<provider> stopped responding".
- Count the effective system prompt (folder chain plus the chat's own, or the pending folder and prompt on home) in the composer's context meter, and break its hover tooltip down into folder and chat tokens.
- Remove the 20,000-character cap on chat and folder system prompts: `parseSystemPrompt`, the two prompt editors, and the home-draft prompt box no longer truncate or reject long prompts.
- Let the right panel be resized on the overlay sheet too (768px and up): it now carries the same drag handle, double-click reset and keyboard resize as the docked layout, sharing one stored width, while a full-screen phone sheet stays fixed.
- Rank `chat_search` tool results with the same full-text search as the UI and accept its query syntax.
- Extend `GET /api/search` with filters (`role`, `chat`, `folder`, `model`, `after`, `before`, `extra`), `sort`, paging (`limit`/`offset`/`next`) and highlight-marked snippets; the palette's message hits are now ranked and come only from the server.
- Slow note auto-save from a 500ms to a 1500ms debounce so continuous typing sends fewer PATCH requests (leaving the editor still flushes immediately).

### Fixed

- Make the sidebar rows' ⋯ menus open on phones again: the menus portal at z 40, under the mobile drawer's z-50 scrim, so a tap hit the scrim instead of the menu — they now paint at z 55, above the drawer, and a press on a row's own ⋯ trigger (or folder chevron) no longer arms the touch drag that was swallowing the click.
- Drop the `REASONING` pill from a thought block once thinking has settled, so the header reports only the duration instead of still labeling finished reasoning as reasoning.
- Keep the right panel's width drag anchored to the panel's right edge (it measured `clientX` from the left of the viewport, so any drag on the docked panel snapped to 720px), widen the handle's grab area, and capture the pointer with a drag overlay so dragging across an artifact or preview iframe no longer freezes the panel mid-resize.
- Keep the new-chat default model from leaking into existing chats: reloading on a chat page no longer overwrites that chat (and the persisted draft) with the default, picking a model inside a chat only re-selects it for that chat instead of also becoming the default, and a chat whose thread hasn't loaded yet shows no model rather than the default it never used.
- Fix upward scrolling while a reply is streaming: the auto-scroll's own scroll events no longer re-pin the view to the bottom, so scrolling up mid-stream now sticks instead of being yanked back down by each token.
- Reset the composer's "last reply cost" to the ~estimate while a reply is regenerated or a tool call is retried, instead of showing the replaced reply's cost: the cost now reads from the visible branch, so the replaced sibling's cost drops out as soon as the new branch starts.

## [0.1.2] - 2026-10-20

### Added

- Give the thread header's ⋯ menu the same chat actions as the sidebar row (rename, pin, system prompt, move to folder, export, delete) and add "Move to…" to it, built from one shared list so the two menus can't drift.
- Show the app's real version in the status bar footer (it was hard-coded to `v0.4.1`), inlined from `package.json` at build time so only the version number ends up in the bundled client javascript.
- Mark chats that carry their own system prompt with a small sliders icon in the sidebar, and show how many folder prompts apply ahead of the chat's own in the system prompt editor.
- Show the signed-in user's name and email in the topbar account menu and their initials in the avatar chip, driven by the live session instead of hard-coded stubs.
- Show the provider name on each model option in the composer's model picker, so it stays visible even when a search query flattens the provider-grouped list.

### Changed

- Make the user-message Edit and Copy actions icon-only, dropping their text labels (tooltips and accessible names are unchanged).
- Make moving chats and folders between folders work on phones and tablets: mobile never fires HTML5 drag & drop, so sidebar rows now also start a pointer drag with a lifted ghost copy under the finger and auto-scroll when held near the list's edges.
- Keep the sidebar rows' ⋯ menu visible on small screens (it was hover-only, so it couldn't be opened on touch) and label "Move to…" as "Move to… (or drag)" on phones so the gesture is discoverable.
- Narrow the composer's side padding on small screens (from `px-4` to `px-2`) so it uses more of the width on phones.
- List `get_current_timestamp` first in the Tools grants popover so the clock tool sits at the top of the list.
- Ask for confirmation before deleting a folder from the sidebar, noting that its subfolders and chats move up a level instead of being removed.
- Let the right panel's chat-scope system prompt box be used on home, before a chat exists: the prompt is kept on the composer draft and stored on the new chat by its first send, so that first reply already runs with it.
- Move a decision's run stats (tokens, cost, latency, model, last run time) from the page footer to just under the title, and put "Run again" beside the results summary at the top instead of below it.
- Cap tool-call cards at 80% of the assistant column width on medium screens and up, so they read as narrower annotations under the prose instead of spanning the full message body.
- Drop recent chats from the home-screen suggestions so only the fixed pinned + static prompts show, keeping previous conversations' instructions out of the "new chat" starters.

### Fixed

- Match the mobile drawer's close bar to the sidebar's stored width (it was pinned to `w-64`) and to the topbar height, so the two pieces no longer show a step where the upper strip is narrower than the list below it.
- Edit message box now auto-grows to fit the text instead of collapsing to a tiny box on long single-line messages.
- Wire the right panel's chat-scope system prompt box to the active chat (it was an unwired stub), with Save, Discard and a saved/unsaved label so a stored prompt edit is always visible.
- Copy `pnpm-workspace.yaml` into the Docker runtime stage so pnpm settings (build allowlist, release-age excludes) still apply to the container's `pnpm db:migrate` command.

## [0.1.1] - 2026-10-15

### Added

- Identify the app to providers: send a `talkative/<version>` user-agent on every outbound provider request and OpenRouter app-attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`) so Talkative shows up in OpenRouter rankings and analytics.
- Link the composer's "not reported by this provider" thinking note to Settings → Models, deep-linking to the model via a `?model=` search prefill on /settings/providers.
- Show a compact "Results" summary at the top of a decision editor once it has answers, so the headline value and confidence for every question are visible at a glance without scrolling past the form.

### Changed

- Widen the thread/composer/stage column from 760px to 880px.
- Lighten the user message bubble background in dark theme so it reads more clearly against the dark stage.
- Render `web_search` tool results as clickable title/URL/snippet links in the thread and tuck the raw provider JSON behind a collapsible "inspect raw results" disclosure instead of dumping it inline.
- Show `used / —` in the composer's context meter when the model window is unknown (previously only the used count appeared), and expose the full, locale-formatted context size in the meter's `title` tooltip.
- Adopt the "clean layout" design system: a green OKLCH accent, 14px type scale with a `clamp()` H1, 8/12px radii, a 48px topbar with green brand mark and capitalized wordmark, and OKLCH light/dark tokens throughout.
- Redesign the UI to the handoff: chat turns, tool cards, the `ask_user`/reasoning views, and the composer's model/tool pickers, plus a new `Pill` primitive and ripple animation.

[0.1.1]: https://github.com/fatihky/talkative/releases/tag/v0.1.1
[0.1.2]: https://github.com/fatihky/talkative/releases/tag/v0.1.2
[0.2.0]: https://github.com/fatihky/talkative/releases/tag/v0.2.0
[Unreleased]: https://github.com/fatihky/talkative/compare/v0.2.0...HEAD
