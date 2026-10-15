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

<!-- Add entries under the matching group below (create it if missing):
     ### Added / ### Changed / ### Fixed / ### Removed / ### Security
     One line per change, imperative mood. Cut a versioned heading only on release. -->
