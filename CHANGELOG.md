# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-04-15

Initial public release of Codex Browser Companion.

- Added a Manifest V3 Chrome extension shell with a background service worker, content script, popup UI, and side panel UI.
- Added active tab awareness, page snapshot extraction, semantic outlines, interactive element discovery, and suggested actions.
- Added a user approval queue for click, type, select, and submit actions.
- Added conservative security controls that block password capture and sensitive form submission.
- Added local build, typecheck, and test workflows plus unpacked `dist/` output for Chrome loading.
