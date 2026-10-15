# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The log starts on 2026-10-14; changes made before that are not backfilled.

## [Unreleased]

### Added

- Identify the app to providers: send a `talkative/<version>` user-agent on every outbound provider request and OpenRouter app-attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`) so Talkative shows up in OpenRouter rankings and analytics.
- Link the composer's "not reported by this provider" thinking note to Settings → Models, deep-linking to the model via a `?model=` search prefill on /settings/providers.

### Changed

- Render `web_search` tool results as clickable title/URL/snippet links in the thread and tuck the raw provider JSON behind a collapsible "inspect raw results" disclosure instead of dumping it inline.
- Show `used / —` in the composer's context meter when the model window is unknown (previously only the used count appeared), and expose the full, locale-formatted context size in the meter's `title` tooltip.
- Adopt the "clean layout" design system: a green OKLCH accent, 14px type scale with a `clamp()` H1, 8/12px radii, a 48px topbar with green brand mark and capitalized wordmark, and OKLCH light/dark tokens throughout.
- Redesign the UI to the handoff: chat turns, tool cards, the `ask_user`/reasoning views, and the composer's model/tool pickers, plus a new `Pill` primitive and ripple animation.
- Widen the thread/composer/stage column to 760px and the right panel to 440px (underline tab strip), drop the composer Tools count badge and model-picker glyph, move Delete to the end of the actions row, confirm failed tool-call retries in the app modal, and remove the `BRANCH A`/`stopped` header extras.

<!-- Add entries under the matching group below (create it if missing):
     ### Added / ### Changed / ### Fixed / ### Removed / ### Security
     One line per change, imperative mood. Cut a versioned heading only on release. -->
