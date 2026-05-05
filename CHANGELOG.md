# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-05-04

### Added

- Skill export and import. Skills can now be exported as gzipped bundles and imported back from a file, making it easy to share or back up workspace skills across machines. (#178)
- New `publish_skill` tool in the workspace-chat agent — promote a workspace-scoped skill to a published, reusable skill directly from chat without leaving the conversation. (#179)
- Managed lifecycle for chat attachments: a scrubber tracks attachment references and frees orphaned blobs, a new `parse_artifact` step keeps attachment metadata accurate at write time, and the persistence layer drains cleanly on shutdown so attachments are not lost mid-write. (#169)

### Changed

- **Persistence and signalling migrated to NATS JetStream.** Chat history, signals, and tool dispatch now share a single transport. JetStream gives us durable, replayable streams with at-least-once delivery and clean shutdown semantics — replacing the previous mix of in-memory queues and ad-hoc IPC. This is a substantial internal refactor that lays the groundwork for multi-host deployments. (#164)
- Studio release pipeline split: building the Studio app is now decoupled from publishing the update manifest, so each step can be re-run independently without forcing a full rebuild. (#185)
- Retired the legacy `SESSIONS` JetStream stream now that all chat persistence flows through the new JetStream KV layout. Existing installs will see the old stream removed automatically. (#170)
- `deno task clean` now purges JetStream state in addition to filesystem state, so a clean reset really is clean. (#172)
- CI: dependabot configuration consolidated and `apps/ledger` brought under coverage; `hono` and `zod` updates are now grouped to reduce PR noise. (#138, #151)

### Fixed

- **Google Sheets is now read-only end-to-end.** Both the OAuth scope and the MCP tool catalog were tightened so connected Sheets cannot be modified by agents — only read. (#188)
- **Studio installer:**
  - sha256 verification works portably across platforms again, fixing install/verify failures on some setups. (#187)
  - Lockfile resynced for the Tauri 2.11.0 bump so the installer builds and launches cleanly. (#186)
  - Restored compatibility with `ruzstd` 0.8 so decompression works during install. (#187)
- Agent-created artifacts now persist with the correct MIME type, so previews, downloads, and thumbnails render correctly instead of falling back to `application/octet-stream`. (#176)
- The MCP `tools/list` endpoint no longer fails when artifact tools are registered, restoring the full tool catalog for connected MCP clients. (#175)
- Workspace chats: chat IDs are now sanitized before being written to JetStream KV, preventing corrupt or unreadable keys when a chat ID contains characters disallowed by JetStream subjects. (#181)
- Cascade execution is now decoupled from signal delivery in the daemon. A slow cascade can no longer block subsequent signals from being processed, fixing a class of stuck-workflow bugs. (#182)
- Daemon shutdown is faster and more responsive: shutdown phases run in parallel, and a second Ctrl-C triggers a fast quit. (#168)
- In-flight session writes are flushed during daemon shutdown via the `SessionStreamRegistry`, so the last few messages of an active chat are no longer lost when Studio is quit mid-stream. (#167)
- The web/browsing agent no longer leaks Chrome processes after a session ends — closed sessions actually release their browser. (#166)
- Add-skill dialog: skill autocomplete works again. (#118)
- Test suite: preserved an explicit `undefined`-or-empty-array assertion in `mcp-registry` tests that was being silently weakened by a refactor. (no PR)

### Documentation

- README now shows CI status and Discord badges. (#180)
- Fixed broken README paths and converted the GitHub issue templates to short, mostly-optional issue forms. (#119)
- README copy edits. (no PR)

### Dependencies

- Studio installer (`apps/studio-installer`): bumped to Tauri 2.11.0; plus `dirs` 5→6, `sha2` 0.10→0.11, `zip` 0.6→8, `ruzstd` 0.7→0.8, `which` 6→8, `windows-sys` 0.59→0.61, `@tauri-apps/cli` 2.10→2.11.
- AI SDKs: `@ai-sdk/anthropic` ^3.0.74, `@ai-sdk/openai` ^3.0.58, `@ai-sdk/svelte` ^4.0.174, `@ai-sdk/provider` ^3.0.10, `ai` ^6.0.174, `@anthropic-ai/claude-agent-sdk` ^0.2.126, `@anthropic-ai/claude-code` 2.1.126 (in `/docker`).
- Front-end: `@tanstack/svelte-query` ^6.1.27, `@tanstack/query-core` ^5.100.8, `@tanstack/svelte-table` 9.0.0-alpha.41, `@tauri-apps/api` 2.11.0, `@tauri-apps/plugin-opener` 2.5.4, `dompurify` ^3.4.2, `marked` ^18.0.3, `node-html-parser` ^7.1.0, `@sveltejs/kit` ^2.59.0.
- `apps/link`: `hono` 4.12.16, `zod` 4.4.2, `nanoid` 5.1.11.
- Chat adapters: `@chat-adapter/discord` 4.27.0, `chat` 4.27.0.
- Go: `process-compose` 1.110.0, `caarlos0/env/v11` 11.4.1, `fyne.io/systray` 1.12.1.
- Tooling: `eslint` ^10.3.0, `globals` ^17.6.0, `knip` 6.11.0, `svelte-check` ^4.4.7, `gunshi` ^0.29.5, `yaml` ^2.8.4.

## [0.1.1] - 2026-05-01

### Added

- Workspace-scoped skill assignment tools (`assign_workspace_skill` / `unassign_workspace_skill`) for the workspace-chat agent. Calls `SkillStorage` directly, validates `@namespace/name` refs via `SkillRefSchema`, and is idempotent. Assignments take effect on the next chat turn because `resolveVisibleSkills` reads the assignment table every turn. System prompt and `workspace-api` skill reference updated to distinguish ephemeral `load_skill` from persistent workspace assignment. (#114)

### Fixed

- Hung MCP servers no longer block workspace chats. `Promise.allSettled` replaces the serial connect loop so one stuck server cannot stall the others, and hard timeouts are enforced at every phase: 4s on the HTTP reachability probe, 20s on `createMCPClient` + `listTools` handshake, and a 15-minute ceiling on `callTool` invocation. Timed-out servers are silently dropped; structured `operation: "mcp_timeout"` telemetry (with `serverId`, `phase`, `durationMs`) is logged for future circuit-breaker decisions. The previous retry on hang was removed — one shot, one timeout, move on. (#116)
- Four macOS launcher / tray bugs (#113):
  - Autostart plist now points at the bundle ID the installer actually writes (`ai.hellofriday.studio`), not the never-installed `-launcher` suffix. LaunchServices no longer fails autostart and the tray "Restart" action with `LSCopyApplicationURLsForBundleIdentifier`. Existing broken installs self-heal on next launcher start.
  - Tray "Restart all" no longer paints the menubar `Error` for the few seconds children take to come back up. A new restart-grace window (active during the in-flight restart and for `bucketFailGraceWindow` after) suppresses the transient `AnyFailed` bucket.
  - Tray "Restart all" no longer terminates the supervisor watchdog. `RestartAll` now calls `processRunner.RestartProcess` per service in `startOrder`, which keeps `pendingRestarts > 0` and prevents process-compose's `runner.Run` loop from exiting "Project completed" between the stop and start passes. As a side benefit, four of five services stay running at any instant during a user-initiated restart.
  - The user's "Start at login" disabled choice now survives launcher restarts. `isAutostartStale()` on darwin matches the Windows contract: stale iff the registered value is both non-empty and mismatched. An absent plist means user-disabled and is left alone.
  - The cold-start grace and post-restart grace are unified behind a single `bucketFailGraceWindow` constant (90s) that covers the readiness-probe budget (`InitialDelay=2s + FailureThreshold=30 × PeriodSeconds=2s = 62s`), so legitimately slow first-pass readiness (the friday daemon's ~24s workspace scan + skill bundle hashing + cron registration on cold start) no longer flips the bucket red mid-startup.

## [0.1.0] - 2026-05-01

Initial tagged release.
