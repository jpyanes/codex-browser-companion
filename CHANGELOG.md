# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Added site-specific adapters for Google sign-in, Google Drive, Google Docs, and LinkedIn feed workflows.
- Added an MCP-style tab intelligence layer for cross-tab search, focus, and structured tab ranking.
- Added Codex logo assets and wired them into the extension icon, popup header, and side panel.
- Added a Playwriter-backed localhost bridge status panel and `npm run bridge` workflow for attaching to the user's existing Chrome session.
- Added an optional Stagehand-backed semantic bridge on `localhost:19989` that enriches suggested actions when a model is configured.
- Added workflow planner and memory support for compound commands, blocked-step tracking, workflow history, and a workflow panel with continue/resume behavior.
- Added multi-tab orchestration with a refreshable tab inventory, explicit focus controls, and scan/summary actions per tracked tab.

## [0.1.0] - 2026-04-14

Initial public release of Codex Browser Companion.

- Added a Manifest V3 Chrome extension shell with a background service worker, content script, popup UI, and side panel UI.
- Added active tab awareness, page snapshot extraction, semantic outlines, interactive element discovery, and suggested actions.
- Added a user approval queue for click, type, select, and submit actions.
- Added conservative security controls that block password capture and sensitive form submission.
- Added local build, typecheck, and test workflows plus unpacked `dist/` output for Chrome loading.
