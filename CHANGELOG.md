# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
