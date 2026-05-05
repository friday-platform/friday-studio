# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-05-04

This release migrates Friday's persistence and signalling layer to **NATS
JetStream**. The migration is automatic on first boot, but the move adds
a hard prerequisite (`nats-server`), removes several legacy CLI/HTTP
surfaces, and changes one default that affects scheduled signals. Read
the **Breaking changes** and **Migration** sections before upgrading.

### Breaking changes

- **NATS is now a hard prerequisite.** The daemon spawns its own
  `nats-server` by default (solo-dev mode), but the `nats-server` binary
  must be on `PATH`. Install via `brew install nats-server` on macOS or
  download from <https://github.com/nats-io/nats-server/releases>. To
  point at an external broker instead, set `FRIDAY_NATS_URL=nats://…`;
  when set, the daemon will *not* spawn an embedded broker. (#164)
- **Daemon startup now blocks on migrations completing.** First boot
  after upgrade is bounded by legacy data volume; subsequent boots see
  every migration as `skipped` and the cost is microseconds. The daemon
  refuses HTTP traffic until migrations finish — `GET
  /api/daemon/status` exposes `migrations.state` (`pending` /
  `complete` / `failed`) for monitoring. (#164)
- **Cron `onMissed` default flipped from `skip` to `manual`.** Existing
  cron timers and any `workspace.yml` files without an explicit
  `onMissed` will now surface a *pending* event in `/schedules` on
  first restart instead of silently skipping. To preserve the old
  behaviour, add `onMissed: skip` to the signal definition. The
  `coalesce` and `catchup` policies are unchanged. (#164)
- **CLI removed:** `atlas library …` and all subcommands. The library
  (workspace.yml templates / item registry) subsystem was retired;
  workspaces are authored via the workspace-chat meta-agent now. (#164)
- **HTTP routes removed:** `/library/*`,
  `/workspaces/blueprint-recompile`, `/workspaces/resources`,
  `/workspaces/resource-config`, `/activity`. Any client integration
  pointing at these endpoints needs to migrate. (#164)
- **Packages and storage adapters dropped.** Anything still importing
  these will fail to build:
  - Apps/packages: `apps/ledger`, `packages/resources`,
    `packages/activity`, `packages/workspace-builder`,
    `packages/cortex`.
  - Storage adapters: `@atlas/adapters-md` (md-memory / md-narrative),
    `@atlas/core/artifacts` local + cortex adapters,
    `@atlas/core/session/cortex-session-history-adapter`,
    `@atlas/core/mcp-registry/storage/cortex-adapter`,
    `@atlas/skills` local + cortex adapters,
    `@atlas/storage/library-storage-adapter`, all in-memory test
    adapters across packages.
  - Module entry: `@atlas/document-store/node.ts` — import from the
    package root (`@atlas/document-store`) instead. (#164)
- **In-memory test adapters removed.** Downstream test suites that used
  them must migrate to a shared NATS test server (one `nats-server` per
  Vitest worker — see `vitest.setup.ts`). (#164)
- **Signal `concurrency` policy added on `WorkspaceSignalConfig`** with
  `skip` as the default (matches old behaviour). New options: `queue`
  (per-key serial), `concurrent` (no overlap guard), `replace` (abort
  in-flight, start new). Existing `workspace.yml`s without the field
  pick up `skip` automatically — no action required, but the field is
  worth knowing about. (#182)

### Migration

- **Pre-existing data is migrated transparently on first boot** — no
  manual export/import. Each subsystem (chat, memory, scratchpad,
  workspace registry, MCP registry, cron timers, artifacts, sessions,
  document store, skills, workspace state) has an idempotent migration
  audited in the `_FRIDAY_MIGRATIONS` JetStream KV. Restart
  mid-migration is safe.
- **Recovery / CI: `atlas migrate` CLI** runs the same migration queue
  the daemon runs at startup. Idempotent. Mutating runs refuse to
  proceed if a daemon is reachable on `localhost:8080`. Read-only flags
  (`--list`, `--dry-run`, `--json`) work while the daemon is running.
- **Legacy `SESSIONS` JetStream stream is auto-decommissioned** on
  first boot under this release. Before deletion, every event is
  dumped to `~/.atlas/legacy-sessions-backup-<YYYY-MM-DD>.jsonl`.
  Sessions whose events lived only in the legacy stream return HTTP
  410 (`outdated storage format`) instead of HTTP 500. (#170)
- **If migrations fail:** the daemon surfaces `migrations.state:
  "failed"` and an ERROR-severity log line. Re-run via `atlas migrate`
  with the daemon stopped, or restart the daemon to retry.

### Added

- **NATS JetStream as the persistence and signalling backbone.** Chat
  history, memory, signals, tool dispatch, and artifacts all live in
  durable JetStream streams / KV / Object Store with at-least-once
  delivery, replay, and clean shutdown semantics. Lays the groundwork
  for multi-host deployments. (#164)
- **`atlas migrate` CLI** — runs the migration queue standalone for
  recovery, CI, or pipelines that need to migrate before starting the
  daemon. Flags: `--list`, `--dry-run`, `--json`. (#164)
- **`/schedules` page** with per-cron Fire / Fire-all / Dismiss
  controls for missed firings, backed by a new `WORKSPACE_EVENTS`
  JetStream stream. (#164)
- **`INSTANCE_EVENTS` stream + `GET /api/instance/events` SSE feed**
  for live cascade-backlog state — `cascade.queue_saturated`,
  `cascade.queue_drained`, `cascade.queue_timeout`,
  `cascade.replaced`. Replaces UI polling with a push feed. (#182)
- **Skill export and import.** Skills can be exported as gzipped
  bundles and imported back from a file, making it easy to share or
  back up workspace skills across machines. (#178)
- **`publish_skill` tool in the workspace-chat agent** — promote a
  workspace-scoped skill to a published, reusable skill directly from
  chat. (#179)
- **Chat attachment lifecycle.** A boundary scrubber lifts large
  embedded base64 blobs from MCP tool outputs into JetStream Object
  Store artifacts before they ever hit the AI SDK message buffer
  (fixes `MAX_PAYLOAD_EXCEEDED` on Gmail-PDF flows). A new
  `parse_artifact` builtin (and MCP tool) extracts PDF/DOCX/PPTX to
  markdown server-side, so bytes never enter the model context.
  Daemon shutdown drains in-flight chat turns so partial assistant
  messages survive a SIGTERM. (#169)
- **PDF inline preview + Download button** in the chat artifact card.
  Saved files get correct names + extensions via mime sniffing, no
  more `.bin` filenames. (#169)
- **`cascadeConsumer` block on `GET /api/daemon/status`** —
  `inFlight`, `cap`, `saturated` for ops visibility. (#182)
- **Workspace chat debug endpoint** at
  `/api/workspaces/:id/chat-debug` for inspecting the JetStream + KV
  state of a chat. (#164)

### Changed

- **Studio release pipeline split.** Building the Studio app is now
  decoupled from publishing the update manifest, so each step can be
  re-run independently without forcing a full rebuild. (#185)
- **Cascade execution decoupled from signal delivery.** A slow cascade
  on one workspace no longer blocks every other workspace's cron / HTTP
  signal — fixes a head-of-line regression introduced by the
  consolidated workQueue consumer in #164. Cascade in-flight is capped
  via `FRIDAY_CASCADE_CONCURRENCY` (default 32). (#182)
- **Per-message chat-stream subjects** with `max_msgs_per_subject: 1`
  and `allow_rollup_hdrs: true`, so re-publishing a message with the
  same id snapshot-replaces the prior copy at the broker. New chats
  use the new layout; existing chats stay on the flat layout — no
  migration needed. (#169)
- **Chat: cancel in-flight turn on follow-up message.** Sending a new
  message while the assistant is mid-turn now cancels the prior turn
  cleanly. (#164)
- **Daemon log levels lowered for domain failures.** A single LLM API
  rejection used to produce two error-level log lines plus a warn;
  the inner two are now warn so operators scanning at error level see
  infra-level failures, not every misconfigured `model:` id. (#182)
- **`deno task clean`** now purges JetStream state in addition to
  filesystem state. (#172)
- **CI:** dependabot configuration consolidated and `apps/ledger`
  brought under coverage (later removed entirely); `hono` and `zod`
  updates grouped to reduce PR noise. (#138, #151)

### Fixed

- **Google Sheets is now read-only end-to-end.** Both the OAuth scope
  (`spreadsheets.readonly` + `drive.readonly`, instead of the
  previously-requested `spreadsheets` write scope which was not in
  the verified GCP project) and the MCP tool catalog
  (`--permissions sheets:readonly`) were tightened. Connecting Google
  Sheets no longer hits the "This app is blocked" page, and write
  tools no longer register only to 403 at runtime. (#188)
- **Studio installer:**
  - sha256 verification works portably across platforms again, fixing
    install/verify failures on some setups. (#187)
  - Lockfile resynced for the Tauri 2.11.0 bump so the installer
    builds and launches cleanly. (#186)
  - Restored compatibility with `ruzstd` 0.8 so decompression works
    during install. (#187)
- **Cascade execution decoupled from signal delivery** — see Changed.
  This was the fix for cron jobs occasionally not firing across
  workspaces post-#164. (#182)
- Agent-created artifacts now persist with the correct MIME type, so
  previews, downloads, and thumbnails render correctly instead of
  falling back to `application/octet-stream`. (#176)
- The MCP `tools/list` endpoint no longer fails when artifact tools
  are registered, restoring the full tool catalog for connected MCP
  clients. (#175)
- Workspace chats: chat IDs are now sanitized before being written to
  JetStream KV, preventing corrupt or unreadable keys when a chat ID
  contains characters disallowed by JetStream subjects. (#181)
- Daemon shutdown is faster and more responsive: phases run in
  parallel, and a second Ctrl-C triggers a fast quit. (#168)
- In-flight session writes are flushed during daemon shutdown via the
  `SessionStreamRegistry`, so the last few messages of an active chat
  are no longer lost when Studio is quit mid-stream. (#167)
- Partial assistant turns survive a SIGTERM — the daemon drains
  in-flight chat turns before tearing down workspace runtimes,
  letting the agent's `onFinish` persist what was assembled. (#169)
- The web/browsing agent no longer leaks Chrome processes after a
  session ends — closed sessions actually release their browser. (#166)
- AI SDK error reporting: the underlying API error (rate limit / auth
  / model deprecated) now reaches the user instead of a generic
  `NoOutputGeneratedError: No output generated`. (#182)
- Stricter MCP `readyUrl` check — 5xx is now treated as not-ready, so
  workspace-mcp during OAuth bootstrap can't pass the readiness probe
  before it's actually serving requests. (#182)
- Add-skill dialog: skill autocomplete works again. (#118)
- Test suite: preserved an explicit `undefined`-or-empty-array
  assertion in `mcp-registry` tests that was being silently weakened
  by a refactor. (no PR)

### Removed

- `apps/ledger`, `packages/resources`, `packages/activity`,
  `packages/workspace-builder`, `packages/cortex`. (#164)
- CLI: `atlas library …`. (#164)
- HTTP routes: `/library/*`, `/workspaces/blueprint-recompile`,
  `/workspaces/resources`, `/workspaces/resource-config`,
  `/activity`. (#164)
- Storage adapters: `@atlas/adapters-md`, cortex adapters across
  artifacts/session/mcp-registry/skills, local artifact + skill
  adapters, library-storage-adapter, all in-memory test adapters.
  (#164)
- `@atlas/document-store/node.ts` — import from `@atlas/document-store`
  instead. (#164)
- Legacy `SESSIONS` JetStream stream — auto-removed with a JSONL
  backup on first boot. (#170)

### Configuration

New environment variables introduced by this release. `.env.example`
and `.env.ci` are not yet updated; the table below is the source of
truth.

NATS connectivity:
- `FRIDAY_NATS_URL` — external broker URL. Default
  `nats://localhost:4222`. **When set, the daemon will not spawn an
  embedded broker.**
- `FRIDAY_NATS_MONITOR` — set to `"1"` to enable nats-server's monitor
  port (8222). Off by default.

JetStream tuning (logged at startup with provenance):
- `FRIDAY_JETSTREAM_MAX_PAYLOAD` (default `8MB`)
- `FRIDAY_JETSTREAM_MAX_MEMORY` (default `256MB`)
- `FRIDAY_JETSTREAM_MAX_FILE` (default `10GB`)
- `FRIDAY_JETSTREAM_STORE_DIR` (default: nats-server's own default)
- `FRIDAY_JETSTREAM_MAX_STREAMS` / `FRIDAY_JETSTREAM_MAX_CONSUMERS`
  (telemetry only)
- `FRIDAY_JETSTREAM_MAX_MSG_SIZE` (default `8MB`)
- `FRIDAY_JETSTREAM_MAX_AGE` (default `0` — no expiry)
- `FRIDAY_JETSTREAM_DUPLICATE_WINDOW` (default `24h`)
- `FRIDAY_JETSTREAM_MAX_ACK_PENDING` (default `256`)
- `FRIDAY_JETSTREAM_MAX_DELIVER` (default `5`)
- `FRIDAY_JETSTREAM_ACK_WAIT` (default `5m`)

Tool dispatch:
- `FRIDAY_TOOL_WORKERS` — set to `"external"` to skip in-process tool
  worker registration (daemon assumes external workers will subscribe).
- `FRIDAY_TOOL_WORKER_RUNTIME` — `subprocess` (default) or `k8s`
  (not implemented).
- `FRIDAY_WORKER_TOOLS` — comma-separated tool allowlist forwarded to
  spawned workers.

Cascade dispatch:
- `FRIDAY_CASCADE_CONCURRENCY` — total in-flight cascade cap
  (default 32).
- `FRIDAY_CASCADE_QUEUE_TIMEOUT` — envelope pickup deadline
  (default 5 min).

Other:
- `FRIDAY_ATLAS_PLATFORM_URL` — overrides the daemon URL embedded in
  the atlas-platform MCP server config.

### Documentation

- README now shows CI status and Discord badges. (#180)
- Fixed broken README paths and converted the GitHub issue templates
  to short, mostly-optional issue forms. (#119)

### Dependencies

- Studio installer (`apps/studio-installer`): bumped to Tauri 2.11.0;
  plus `dirs` 5→6, `sha2` 0.10→0.11, `zip` 0.6→8, `ruzstd` 0.7→0.8,
  `which` 6→8, `windows-sys` 0.59→0.61, `@tauri-apps/cli` 2.10→2.11.
- AI SDKs: `@ai-sdk/anthropic` ^3.0.74, `@ai-sdk/openai` ^3.0.58,
  `@ai-sdk/svelte` ^4.0.174, `@ai-sdk/provider` ^3.0.10, `ai`
  ^6.0.174, `@anthropic-ai/claude-agent-sdk` ^0.2.126,
  `@anthropic-ai/claude-code` 2.1.126 (in `/docker`).
- Front-end: `@tanstack/svelte-query` ^6.1.27, `@tanstack/query-core`
  ^5.100.8, `@tanstack/svelte-table` 9.0.0-alpha.41, `@tauri-apps/api`
  2.11.0, `@tauri-apps/plugin-opener` 2.5.4, `dompurify` ^3.4.2,
  `marked` ^18.0.3, `node-html-parser` ^7.1.0, `@sveltejs/kit`
  ^2.59.0.
- `apps/link`: `hono` 4.12.16, `zod` 4.4.2, `nanoid` 5.1.11.
- Chat adapters: `@chat-adapter/discord` 4.27.0, `chat` 4.27.0.
- Go: `process-compose` 1.110.0, `caarlos0/env/v11` 11.4.1,
  `fyne.io/systray` 1.12.1.
- Tooling: `eslint` ^10.3.0, `globals` ^17.6.0, `knip` 6.11.0,
  `svelte-check` ^4.4.7, `gunshi` ^0.29.5, `yaml` ^2.8.4.

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
