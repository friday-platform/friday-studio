# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-05-06

### Breaking changes

- **Phantom bundled-agent references now hard-fail at validation.** Workspace YAMLs with `type: atlas, agent: "<id>"` referencing a non-existent bundled agent (e.g., the deleted `email` agent) previously survived load: the daemon logged "Base agent not found" and silently dropped the agent at registration, so any FSM step delegating to it stalled in production with no surfaced error. New `checkBundledAgentRefs` validator pass rejects unknown ids at create / lint / publish; daemon load path surfaces registration failures via `metadata.lastError` instead of dropping. Existing workspaces with phantom agents will show `lastError` in workspace metadata until the reference is removed. (#201)

### Migration

- **JetStream store relocates from `$TMPDIR` to `<friday_home>/nats` automatically.** macOS periodically garbage-collects `$TMPDIR`, silently wiping chat history, memory, and workspace state. On first restart after upgrade, `friday migrate` runs a pre-NATS, filesystem-only relocation step (PID-file locked at `<friday_home>/.pre-nats-migrate.lock`) before `connectOrSpawn`: it detects legacy `$TMPDIR/nats/jetstream` data, moves it via atomic rename with EXDEV copy-fallback, and emits structured logs per entry to `~/.friday/logs/migrate.jsonl`. Installer writes `FRIDAY_JETSTREAM_STORE_DIR=<friday_home>/nats` to `.env` (atomic write-then-rename); launcher reads it and passes `-sd <path>` to nats-server, falling back to `<friendlyHome()>/nats` if absent. No manual action required. (#214)
- **Installer no longer deletes `~/.friday/local` on reinstall.** Previous `extract.rs` renamed `local → local.bak` and restored only `.env`/`.installed`/`friday.yml`, silently deleting `workspaces/`, `nats/`, `uv/`, `link-data/`, `logs/`. The new installer atomically replaces only the top-level paths the archive ships (`bin/`, `friday-launcher`); user data is never touched. VM-tested: workspace configs and chat history now persist through reinstall. (#214)

### Added

- **Workspace and instance event SSE feeds.** `GET /api/events?stream=true` and `GET /api/daemon/api/instance/events?stream=true` extend the replay-only endpoints with an optional NATS-backed live branch that forwards each event as an SSE frame; the replay endpoint remains as a load-after-disconnect safety net. The `/schedules` page drops 60-second polling and opens an EventSource, merging live events into the TanStack cache via dedup key `(workspaceId, signalId, scheduledAt)`. (#206)
- **Cascade queue saturation banner.** A new `CascadeStatusBanner` component (mounted in `+layout.svelte` alongside `UpdateBanner`) subscribes to `cascade.queue_{saturated,drained,timeout}` / `cascade.replaced` events: renders a persistent banner while saturated, clears on drained, and emits toasts on timeout / replaced. Hydrates from the replay endpoint on mount before opening SSE so a `drained` event can't arrive before the older snapshot. (#206)
- **Liquid-style `| default: 'fallback'` filter for input placeholders.** `{{inputs.foo | default: 'bar'}}` in agent action prompts now renders the fallback when `foo` is missing or empty (matching Liquid semantics — `0`/`false` pass through as legitimate values). Covers single- and double-quoted literals. (#199)
- **MCP tool-probe cache + background prewarm.** `GET /api/mcp-registry/:id/tools` consults a `serverId`+config-hash keyed cache (1h TTL, success-only) before probing. Add / install / custom-add / update fire a background prewarm with a 60s timeout — generous enough for cold `npx` / `uvx` package downloads. The user-facing endpoint awaits any in-flight prewarm (5s race cap) before falling back to its own 5s foreground probe, preventing duplicate `npx` spawns on the very click the prewarm was meant to optimise. Servers that fail to start with no `disconnected` entry now throw `MCPProbeNoToolsError` instead of caching an empty tool list; credential-disconnected errors are surfaced as auth-phase failures. (#195)
- **`scripts/setup-dev-env.sh` full-bootstrap rewrite.** Expanded from a `uv`-only shim into a one-shot, idempotent bootstrap with version detection: keeps existing tools that satisfy minimums, auto-installs missing or stale ones via Homebrew on macOS (Xcode CLT detection, Deno, Go, nats-server, agent-browser CLI + Chromium). Writes `FRIDAY_JETSTREAM_STORE_DIR` to `.env` so JetStream data lands under `friday_home`. All eight steps map to `*_MIN` constants in the script. (#205)

### Changed

- **Chat SSE resume survives Chrome's ~50–60s fetch streaming cap.** Server emits `id: <index>` per SSE frame and accepts `Last-Event-ID` headers on resume; the client wraps `DefaultChatTransport`'s fetch with a `TransformStream` scanner that commits cursors only on event terminators. The stream registry re-emits open `*-start` and `tool-input-available` chunks on cursored resume so the AI SDK's `chat.resumeStream()` doesn't reject missing-part deltas. The resume budget resets on forward progress (capped at 20 consecutive no-progress retries, not absolute attempts); overflowed buffers return 410 + `X-Stream-Replay-Disabled` to distinguish from clean completion (204). Verified across 12+ Chrome-fetch drops on a 12-minute generation with no duplication. (#197)
- **MCP catalog UI (agent-playground) refactored.** Server detail view consolidates credentials into a reusable table, the action bar is now persistent with badges for server status / type (bundled vs. registry), the sidebar is decluttered, and markdown rendering is extracted to a dedicated component. New `Badge` and `SimpleTable` primitives moved into `@atlas/ui`. Net −255 lines despite the new features. (#204)
- **README rewritten around chat-first framing.** Workspaces are now positioned as a chat pattern; hellofriday.ai is the packaged distribution of the same daemon + playground. Example flow leads with the playground chat surface, then promote-to-workspace, then Python via `friday-platform/agent-sdk`. (#205, #140b85f88)

### Fixed

- **Chat handler buffer-capture race.** The handler captured `ownBuffer = streamRegistry.getStream(chatId)` *after* awaiting `thread.subscribe` and `ChatStorage.appendMessage` — in that 10–50ms window, a follow-up POST could replace the chatId-keyed buffer, causing the handler to write turn 1's late chunks into turn 2's buffer. Now stashes the buffer on `Message.raw.turnBuffer` at dispatch and reads it back deterministically; non-web adapters (Slack / Telegram / Teams) that never create a buffer no longer log spurious `stream_event_dropped` warnings. (#206, follow-up to #192/#193)
- **Cross-turn event leak in chat stream registry.** Two cooperating bugs let a stopped turn's late events corrupt the next turn's stream: `finishStream(chatId)` was called in `finally` without identity verification, so a fresh buffer for the same chatId was flipped to inactive by the prior turn's cleanup; `appendEvent` looked up buffers by chatId only, so late events from an aborted turn (subprocess emit, NATS reconnect-buffer flush, streamSub drain) landed in whatever buffer was current. Now the handler captures `ownBuffer` once and threads it through both `appendEvent(chatId, chunk, ownBuffer)` and `finishStreamIfCurrent(chatId, ownBuffer)` so the identity check lives at the registry boundary. (#194)
- **`{{inputs.x}}` interpolation in agent action prompts.** Friday workspaces (which exclusively use agent actions) previously saw literal `{{inputs.description}}` in the prompt while the resolved values sat in an appended `## Input` block. Placeholders are now interpolated uniformly across both action types. (#199)
- **`cancelSession` no longer wedges when an engine ignores `AbortSignal`.** Workspace agents that make blocking calls without piping the AbortSignal through (e.g., `fetch` with no `signal:`) used to pin cascade-stream's in-flight slot forever — every subsequent trigger of the same signal was rejected as `skipped-duplicate` until daemon restart. New `awaitWithAbort` helper races `engine.signal()` against the effective AbortSignal, releasing the slot within ~1 tick on cancel; the orphaned `engine.signal` continues in the background with a tail handler that logs settlement and prevents `UnhandledPromiseRejection`. A `finalized` flag short-circuits late events so they don't land in JetStream after `session:complete`. (#202)
- **MCP cold-start probe timeout on first install.** The 5-second foreground probe was too tight for `npx` / `uvx` MCP servers on first run — npm cold-downloaded the package in 5–6s, timing out the user's first click while the second succeeded against cached npm. The new prewarm + cache pipeline (see Added) eliminates the cold-click failure mode. (#195)
- **FSM-path MCP servers now receive registry `platformEnv` variables.** The code-execution path through `runtime.ts` was handing raw workspace MCP server configs to the FSM engine without applying registry-owned `platformEnv` (`MCP_ENABLE_OAUTH21`, dummy `GOOGLE_OAUTH_CLIENT_ID` / `SECRET`, `WORKSPACE_MCP_STATELESS_MODE`). Cron-triggered LLM actions spawned `workspace-mcp` without those vars, so it ran in native-OAuth mode and rejected every bearer-authed request — meanwhile chat (via `discoverMCPServers`, which does apply `platformEnv`) worked fine. Mirrors the same pattern used in `executeCodeAgent`. (#196)
- **MCP subprocess registry evicts stale children on spec drift.** `sharedMCPProcesses.acquire` was first-spawner-wins: whichever caller hit `acquire(serverId, …)` first locked their `spec.env` for the daemon's lifetime, so a cached subprocess spawned by a buggy code path served stale config until restart. Each cached entry now carries a stable hash of `{command, args, env}`; on mismatch the registry SIGTERMs the child, waits up to 2s, SIGKILLs as fallback, and awaits full exit before respawn (mandatory because `workspace-mcp` binds fixed ports — a racing respawn through `TIME_WAIT` is the exact failure this registry exists to avoid). (#196)
- **MCP registry search tolerates unknown `registryType`.** `/api/mcp-registry/search` was returning 502 for any query matching a server with a `registryType` outside the hardcoded Zod enum (e.g., `nuget`); upstream defines the field as an open string, so a single unrecognised value tanked the entire response. Each entry is now parsed independently — malformed ones are dropped with logging — and the response shape gains a `dropped` count for telemetry. (#191)
- **Bundled-agent lookup now uses `Set.has` instead of the `in` operator.** `in` walks the prototype chain, so `agent: "toString"` / `"constructor"` / `"hasOwnProperty"` silently passed validation — the same shape of silent-failure bug the four-layer phantom-ref defence (above) prevents. Switched to a `Set` built from `Object.keys()` for safe own-property lookup. (#201)
- **`.env` quote handling for API keys and secrets.** The Settings UI's `PUT /api/config/env` used `@std/dotenv`'s `stringify`, which wrapped any value containing non-word chars (e.g., `-` in `sk-ant-foo`) in single quotes. The launcher read those values raw and passed them to spawned services, so agents inherited `ANTHROPIC_API_KEY='sk-ant-foo'` with literal quotes, breaking authentication. Values are now serialised unquoted unless truly necessary (whitespace, `#`, `$`, leading quote, newline, backslash); the launcher strips one layer of surrounding matching quotes on read so existing hand-quoted or bug-quoted files continue working. Keys are validated as POSIX identifiers and CR/LF in values is rejected at the boundary to prevent env-var injection. (#203)
- **`.env` parsing now trims trailing `\r` on CRLF files.** Both Rust (`parse_env_lines`) and the Go launcher (`loadDotEnv`) strip trailing `\r` so Windows-edited `.env` files parse correctly; internal CR is preserved. (#214)
- **Platform env vars refresh on every install / update.** Previous `write_env_file` only ran when the API Keys step rendered, so `FRIDAY_JETSTREAM_STORE_DIR` and other platform defaults wouldn't propagate on quiet updates. New `ensure_platform_env_vars` Tauri command runs unconditionally in `Extract.svelte` with add-if-missing semantics — never overwrites, only appends new keys. (#214)
- **`atlas migrate` reads `.env` for `FRIDAY_PORT_FRIDAY` daemon-probe.** Was hardcoded to 8080, broken in installer mode where the daemon binds to a configurable port. Now reads `.env` via `@std/dotenv`. (#214)
- **`studio-release` shell parser absorbed trailing ellipsis.** Under some locales bash treats UTF-8 continuation bytes as identifier characters, so `$publish_wf…` was parsed as including the ellipsis bytes, tripped `set -u`, and failed the publish workflow. Bracing as `${publish_wf}…` stops the parser at the `}`. (#190)

### Configuration

- **`FRIDAY_JETSTREAM_STORE_DIR`** (new) — absolute path to the JetStream store directory. Installer writes this on every install / reinstall; daemon and launcher read it for nats-server's `-sd` argument; falls back to `<friday_home>/nats` for operators on legacy `.env` files. (#214)

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
