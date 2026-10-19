# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The log starts on 2026-10-14; changes made before that are not backfilled.

## [Unreleased]

<!-- Add entries under the matching group below (create it if missing):
     ### Added / ### Changed / ### Fixed / ### Removed / ### Security
     One line per change, imperative mood. Cut a versioned heading only on release. -->

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
- Keep the new-chat default model out of existing chats: picking a model with a chat open now only applies to that chat instead of also moving the default underneath the next one, and "Change model…" in a chat's ⋯ menu picks one chat's model through its own dialog without touching the default.
- Keep a chat's own model through "Regenerate": it answers again with the chat's model instead of the composer's (and so the workspace default), and clicking a recent model on home no longer reopens that chat's model.
- Size the model picker's search input at 16px so iOS Safari no longer zooms the page when it's focused.
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
[Unreleased]: https://github.com/fatihky/talkative/compare/v0.1.2...HEAD
