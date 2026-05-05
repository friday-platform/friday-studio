# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-05-04

Persistence and signalling moved to NATS JetStream (#164). Read **Breaking changes** and **Migration** before upgrading.

### Breaking changes

- **NATS is now a hard prerequisite.** The daemon spawns its own `nats-server` by default, but the binary must be on `PATH` (`brew install nats-server` on macOS, or grab a release from <https://github.com/nats-io/nats-server/releases>). Set `FRIDAY_NATS_URL=nats://…` to point at an external broker — when set, the daemon will *not* spawn an embedded one. (#164)
- **Daemon startup blocks on JetStream migrations.** First boot after upgrade is bounded by legacy data volume; subsequent boots are microseconds. The daemon refuses HTTP traffic until migrations finish; `GET /api/daemon/status` exposes `migrations.state` for monitoring. Detached-start callers should poll that field on a fresh upgrade. (#164)
- **Cron `onMissed` default flipped from `skip` to `manual`.** Existing timers without an explicit `onMissed` will now surface a *pending* event in `/schedules` on first restart instead of silently skipping. Add `onMissed: skip` to preserve the old behaviour. (#164)
- **CLI removed:** `atlas library …`. **HTTP routes removed:** `/library/*`, `/workspaces/blueprint-recompile`, `/workspaces/resources`, `/workspaces/resource-config`, `/activity`. (#164)
- **`skipStates` body field on `POST /api/workspaces/:workspaceId/signals/:signalId` is silently dropped** — still accepted by the schema, but no longer plumbed into the FSM. (#164)
- **Memory backends pruned to narrative-only.** `retrieval`, `dedup`, and `kv` strategies were removed; external `workspace.yml` referencing them will fail to load. Use `memory.kind: narrative` (or omit). (#164)
- **Packages and adapters dropped.** Build will fail on imports of: `apps/ledger`, `packages/{resources,activity,workspace-builder,cortex}`; `@atlas/adapters-md`; cortex/local adapters across artifacts/session/mcp-registry/skills; `@atlas/storage/library-storage-adapter`; in-memory test adapters; `@atlas/document-store/node.ts` (use the package root). (#164)
- **Signal `concurrency` policy added** on `WorkspaceSignalConfig` (`skip` default — matches old behaviour; `queue` / `concurrent` / `replace` available). No action required for existing workspaces. (#182)

### Migration

- **First-boot data migration is automatic** — no manual export/import. Subsystems (chat, memory, scratchpad, workspace/MCP registries, cron timers, artifacts, sessions, document store, skills, workspace state) migrate via idempotent steps audited in the `_FRIDAY_MIGRATIONS` KV. Restart mid-migration is safe; failures surface as `migrations.state: "failed"` with an ERROR log line. (#164)
- **Legacy on-disk paths are no longer read.** External tooling that touches `~/.atlas/sessions-v2/`, `state.db`, the on-disk artifacts dir, `~/.atlas/document-store/*.sqlite`, or per-workspace skills dirs must switch to JetStream KV / Object Store. The files remain on disk but are dead. (#164)
- **`atlas migrate` CLI** runs the same queue standalone — for recovery (daemon stopped) or CI. Flags: `--list`, `--dry-run`, `--json`, `--nats-url`, `--no-spawn`. Mutating runs refuse if a daemon is reachable on `localhost:8080`. (#164)
- **Legacy `SESSIONS` stream auto-decommissioned** on first boot, with every event dumped to `~/.atlas/legacy-sessions-backup-<date>.jsonl` first. Sessions that lived only in the legacy stream now return HTTP 410 `outdated storage format` (was 500). (#170)

### Added

- **NATS JetStream as the persistence and signalling backbone** — chat, memory, signals, tool dispatch, and artifacts all live in durable JetStream streams / KV / Object Store. Lays the groundwork for multi-host deployments. (#164)
- **`atlas migrate` CLI** for running the migration queue standalone. (#164)
- **`/schedules` page** with Fire / Fire-all / Dismiss controls for missed cron firings, backed by a new `WORKSPACE_EVENTS` JetStream stream and a workspace-events HTTP API (`GET/POST /api/workspaces/:id/events*`, plus a top-level `GET /api/events` feed). (#164)
- **Cron control API** — `GET /api/cron/timers`, `POST /api/cron/timers/:workspaceId/:signalId/{pause,resume}` — toggle timers at runtime without editing `workspace.yml`. (#164)
- **Chunked upload API** under `/api/chunked-upload/*` for streaming large attachments into JetStream Object Store. (#164)
- **NATS-mediated tool dispatch** with public contract `tools.<id>` (invoke) and `tools.<id>.cancel.<reqId>` (cancel). `scripts/run-tool-worker.sh` ships as the sandbox-runtime entrypoint for external workers (`FRIDAY_TOOL_WORKERS=external`). (#164)
- **`/api/instance/events` SSE feed** for live cascade-backlog state (`cascade.queue_{saturated,drained,timeout}`, `cascade.replaced`); `GET /api/daemon/status` gains a `cascadeConsumer` block (`inFlight`, `cap`, `saturated`). (#182)
- **Skill export/import** as gzipped bundles, plus a **`publish_skill`** tool in the workspace-chat agent for promoting a workspace skill to a published one from chat. (#178, #179)
- **Chat attachment lifecycle.** Large embedded base64 blobs in MCP tool outputs are lifted to JetStream Object Store at the boundary (fixes `MAX_PAYLOAD_EXCEEDED` on Gmail-PDF flows). New `parse_artifact` builtin + MCP tool extracts PDF/DOCX/PPTX to markdown server-side. PDFs render inline in the chat with a Download button; mime-sniffed filenames replace `.bin`. Daemon shutdown drains in-flight chat turns so partial assistant messages survive SIGTERM. (#169)
- **Workspace chat debug endpoint** at `GET /api/workspaces/:id/chat-debug`. (#164)

### Changed

- **Studio release pipeline split** — Studio build is decoupled from update-manifest publish, so either step can be re-run independently. (#185)
- **Cascade execution decoupled from signal delivery.** A slow cascade on one workspace no longer head-of-lines every other workspace's cron / HTTP signals (regression introduced by the consolidated workQueue consumer in #164). In-flight cap is `FRIDAY_CASCADE_CONCURRENCY` (default 32). (#182)
- **Chat:** sending a follow-up while the assistant is mid-turn now cancels the prior turn cleanly. New chat streams use per-message subjects with rollup so re-publishing a message snapshot-replaces the prior copy; existing chats stay on the flat layout. (#164, #169)
- **Workspace YAML `inputs.<signal_field>` interpolation** is now preserved through `inputFrom` chains — placeholders no longer stay literal in chained steps. (#164)
- **`deno task clean`** purges JetStream state in addition to filesystem state. (#172)

### Fixed

- **Google Sheets is read-only end-to-end.** OAuth scope tightened to `spreadsheets.readonly` + `drive.readonly` (in the verified GCP project), and the MCP tool catalog is launched with `--permissions sheets:readonly`. Connecting Sheets no longer hits the "This app is blocked" page; write tools no longer register only to 403 at runtime. (#188)
- **Studio installer build** unblocked — lockfile resynced for the Tauri 2.11.0 bump. (#186)
- **Studio CI build portability** — Windows runner sha256 verification + `ruzstd::decoding::StreamingDecoder` import path after the 0.8 bump (compile fix, not runtime). (#187)
- Agent-created artifacts persist with the correct MIME type — no more `application/octet-stream` fallback. (#176)
- MCP `tools/list` no longer fails when artifact tools are registered. (#175)
- Chat IDs are sanitized before being written to JetStream KV, preventing corrupt keys when a chat ID contains subject-disallowed characters. (#181)
- Daemon shutdown is faster and more responsive: phases run in parallel, a second Ctrl-C triggers fast-quit, and in-flight session writes are flushed via `SessionStreamRegistry` so the last messages of an active chat survive. (#167, #168)
- **Tool-worker NATS SUB flush race** — callers dispatching tool work immediately after worker registration no longer hit `NatsError: 503 — no responders`. (#167)
- **Orphaned Chrome reaped on startup and shutdown.** Web-agent Chrome left behind by a SIGKILL'd / crashed daemon or a mid-session reboot now self-heals on next launch — the prior `finally`-based cleanup didn't run on those paths. (#166)
- AI SDK error reporting now surfaces the underlying cause (rate limit / auth / model deprecated) instead of a generic `NoOutputGeneratedError`. (#182)
- MCP `readyUrl` check now treats 5xx as not-ready, so half-initialised servers (e.g. workspace-mcp during OAuth bootstrap) can't pass the probe. (#182)
- Add-skill dialog: `skills.sh` autocomplete works again. (#118)

### Security

- **HTML artifact previews are sandboxed.** The daemon's content route serves HTML artifacts with `Content-Security-Policy: sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`, and the playground iframe sets `sandbox=""`. Agent-authored HTML cannot execute as same-origin. (#176)

### Removed

- Apps/packages: `apps/ledger`, `packages/{resources,activity,workspace-builder,cortex}`. (#164)
- CLI: `atlas library …`. (#164)
- HTTP routes: `/library/*`, `/workspaces/blueprint-recompile`, `/workspaces/resources`, `/workspaces/resource-config`, `/activity`. (#164)
- Storage adapters: `@atlas/adapters-md`, cortex/local adapters across artifacts/session/mcp-registry/skills, `library-storage-adapter`, in-memory test adapters. (#164)
- Memory strategies: `retrieval`, `dedup`, `kv`. (#164)
- Module entry: `@atlas/document-store/node.ts` — use the package root. (#164)
- Legacy `SESSIONS` JetStream stream — auto-removed on first boot with a JSONL backup. (#170)

### Configuration

New env vars (none required for default solo-dev mode). `FRIDAY_NATS_URL` (external broker; daemon won't spawn when set), `FRIDAY_NATS_MONITOR=1` (nats-server :8222 monitor port). `FRIDAY_TOOL_WORKERS=external` plus `FRIDAY_TOOL_WORKER_RUNTIME` / `FRIDAY_WORKER_TOOLS` / `FRIDAY_WORKER_CMD` for external tool workers. `FRIDAY_CASCADE_CONCURRENCY` (default 32) / `FRIDAY_CASCADE_QUEUE_TIMEOUT` (5m) tune cascade dispatch. `FRIDAY_JETSTREAM_*` (max-payload, max-memory, max-file, store-dir, max-msg-size, max-age, duplicate-window, max-ack-pending, max-deliver, ack-wait) tune the embedded broker — startup logs each value with its provenance.

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
