# OAuth Refresh Resilience — QA runner

End-to-end QA for the OAuth refresh resilience feature
(`docs/plans/2026-05-11-oauth-refresh-resilience-design.v8.md`).

Each scenario combines a **unit pre-check** (a fast vitest run that
seals the underlying logic invariant) and a **live UI drive** (the
runner boots a daemon, sends signals or chat messages, and asserts on
the rendered DOM). Failures are prefixed `[unit-precheck]` or `[ui]`
so post-mortems read cleanly.

## Layout

- `run.ts` / `run-core.ts` — runner entry point and per-scenario
  lifecycle.
- `scenarios/p1.ts` — Phase 1 scenarios (P1-01..P1-10).
- `scenarios/p2.ts` — Phase 2 scenarios (P2-01..P2-05).
- `browser.ts` — CDP-driven browser helpers
  (`navigateToChat`, `sendMessage`, `assertChipVisible`, …).
- `harness.ts` — credential tamper / read + Link metrics readback.
- `mock.ts` — wrapper around the mock Google Cloud Function
  (`tools/qa/fixtures/oauth-mock-server/`).
- `daemon.ts` — atlasd lifecycle + credential seeding.
- `seed.ts` — substitutes placeholders in the credential templates
  under `tools/qa/fixtures/oauth-refresh-qa/credentials/` and writes
  the result to `<FRIDAY_HOME>/credentials/dev/`.

## Prerequisites

The runner spawns its own atlasd + Chrome + mock OAuth Cloud
Function, but four services must already be running on the host:

| Service           | Where                                | Required by                       |
| ----------------- | ------------------------------------ | --------------------------------- |
| Link              | `apps/link` on `:3100`               | All scenarios that read/tamper a credential |
| Friday Studio     | web-client on `:5200`                | All chat-driven scenarios (P1-01..P1-06) |
| Stub MCP servers  | `tools/qa/fixtures/stub-mcp-google/` on `:8001` + `:8002` | All chat- and signal-driven scenarios (P1-01..P1-08) |
| Anthropic API key | `~/.atlas/.env` `ANTHROPIC_API_KEY=` | Any scenario that runs a `type: llm` action |

### Starting the host services

In four separate shells:

```bash
# Shell 1 — Link
cd apps/link && LINK_DEV_MODE=true deno task start

# Shell 2 — stub Google MCP servers
deno run --allow-all -e 'import { startStubMCPServers } from "./tools/qa/fixtures/stub-mcp-google/server.ts"; await startStubMCPServers(); await new Promise(() => {});'

# Shell 3 — Friday Studio web-client (for chat scenarios)
cd tools/agent-playground && npx vite dev --port 5200

# Shell 4 — `~/.atlas/.env` must contain ANTHROPIC_API_KEY=sk-ant-...
```

### Running the scenarios

```bash
# All scenarios
deno run --allow-all tools/qa/oauth-resilience/run.ts

# Just Phase 1
deno run --allow-all tools/qa/oauth-resilience/run.ts --filter "P1-"

# Single scenario
deno run --allow-all tools/qa/oauth-resilience/run.ts --filter "P1-02" --verbose

# Discover registered scenarios without running them
deno run --allow-all tools/qa/oauth-resilience/run.ts --list
```

The unit-only scenarios (`P1-09`, `P1-10`, all of `P2-*`) run
without the host services — they only need a daemon, which the
runner spawns.

## Per-scenario behavior

| Scenario  | Surface                              | Host services needed |
| --------- | ------------------------------------ | -------------------- |
| P1-01..06 | Chat-driven, integration chip in DOM | Link, web-client, stub MCP, Anthropic |
| P1-07/08  | Cron-driven, session SSE status      | Link, stub MCP, Anthropic |
| P1-09/10  | Unit pre-check on `classifyProbeError` | (none beyond daemon) |
| P2-01..05 | Unit pre-check on session-interactivity helpers | (none beyond daemon) |

## Telemetry counter assertions

Phase 1 scenarios deliberately **skip** counter-delta assertions —
the Link `/metrics` endpoint currently exposes only HTTP
counters, not the per-outcome counters the QA plan describes
(`retry_saved`, `silent_fallback`, `platform_bug`,
`refresh.outcome{kind=…}`). Task #17 (Phase 3) wires those.

Each scenario carries a `// TODO(task-17): assert counter delta …`
comment at the spot the assertion belongs. Unwrap them when #17
ships.
