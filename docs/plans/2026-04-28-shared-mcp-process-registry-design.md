# Design: shared MCP process registry (lazy daemon-scoped)

## Problem

The Google Workspace MCP servers (`google-gmail`, `google-calendar`,
`google-drive`, `google-docs`, `google-sheets`) are defined in
`packages/core/src/mcp-registry/registry-consolidated.ts:9-118`. Each one runs
its own `uvx workspace-mcp --tools <flag> --transport streamable-http` process
on a **fixed port** (8001–8005). The bearer token is pulled per-service from a
Link provider and passed to the running server via HTTP `Authorization`
header.

`createMCPTools` in `packages/mcp/src/create-mcp-tools.ts:87-202` is ephemeral
per agent: it spawns, tracks children in its own `allChildren` set, and
SIGTERMs them on `dispose` (lines 204-228). The header comment is explicit:
> "Single function replaces the MCPManager class — no pooling, no sharing, no
> ref counting."

This collides with the registry's hardcoded shared port the moment any Google
service is used in two consecutive FSM steps (or by two agents/sessions
running close together).

### Failure trace (observed)

Reproduced in two independent sessions; root cause confirmed identical.

- Workspace `square_nutmeg`, session `b06de932-88e4-43d4-8b7f-ecde67dafc5b`:
  FSM `fetch-emails` → `fetch-calendar`.
- Workspace `chewy_gouda` (Meeting Scheduler), session
  `ca88d506-7201-4bc9-81aa-5d99632504c8`: FSM `scan-emails` →
  `check-availability` → `draft-replies`. Failure at `draft-replies`, the
  *second* spawn of gmail in the same session. Pattern recurred across
  multiple sessions in the daemon log, always on the second spawn of a given
  service.

Sequence:

1. **State A enters** → `createMCPTools` spawns `workspace-mcp` on the fixed
   port (e.g. 8002 for gmail). State runs, LLM completes.
2. **FSM transitions** → previous state's MCP tools are disposed →
   `disposeAll` (`create-mcp-tools.ts:204-228`) SIGTERMs the child, waits
   2s, SIGKILLs survivors. The Python process exits cleanly; `lsof` shows
   the port free.
3. **But the kernel keeps a TIME_WAIT entry** for the readiness-probe
   connection that `connectHttp` made earlier:
   ```
   tcp4  127.0.0.1.8002  127.0.0.1.57688  TIME_WAIT
   ```
   On macOS Darwin 25.4.0 this clears in ~15–30s (`sysctl
   net.inet.tcp.msl`). Linux defaults are typically longer (~60s).
4. **State B enters** → fresh `createMCPTools` tries to respawn
   `workspace-mcp` on the same port → uvicorn `bind()` fails → process
   exits with code 1.
5. → `MCPStartupError(kind: "spawn", serverId: "google-…")` → FSM dies.

### Why the EADDRINUSE recovery branch doesn't save us

`connectHttp` has a fallback at `create-mcp-tools.ts:441-450` that
re-probes the URL when a child exits non-zero with `EADDRINUSE` /
`address already in use` in stderr. **uvicorn never prints either string.**

Empirically (`stderr-signatures.ts` from the colleague investigation,
2026-04-28, `uvx 0.5.9` + `workspace-mcp` FastMCP 3.2.4): stderr always
truncates at exactly:

```
[INFO] Protected resource metadata points to Google's authorization server
```

The FastMCP banner and `Uvicorn running on http://0.0.0.0:8002` (which
would normally print *after* bind succeeds) never appear. uvicorn fails
silently — no recoverable string in our captured buffer. The earlier
guess that this was a Node `'exit'`-vs-`'close'` race is **incorrect**:
the OS error is never written to stderr in the first place, so waiting
for `'close'` doesn't help.

This is also indistinguishable from a *bogus OAuth credentials* failure,
which produces byte-for-byte identical stderr. See "Ruled-out
alternatives" below.

### Other variants (same root cause, larger blast radius)

- Two agents in one workspace using gmail in overlapping sessions →
  second caller piggybacks on the first's child (no children tracked,
  `create-mcp-tools.ts:380-382`); first caller's dispose kills the
  server out from under the second.
- Two sessions in one workspace ending and starting within the
  TIME_WAIT window → second session's first FSM step hits the same
  TIME_WAIT bind failure.
- Two workspaces on one host both wanting gmail → port collision on
  8002.

There is also a quieter, latent bug in the second-caller-piggybacks
case: the second silently inherits the first's
`GOOGLE_OAUTH_CLIENT_ID/SECRET` env. Today those are hardcoded
constants so it's invisible — but it forecloses per-tenant client
credentials.

## Goal

Stop tearing down HTTP MCP servers between FSM steps / agent sessions
within a single daemon process. Make Google MCP servers (and any other
HTTP MCP server with a startup command on a fixed port) safely shared
across consecutive callers without reintroducing per-agent ref-counted
pooling inside `createMCPTools`.

## Non-goals

- **Idle timeout / kill-when-quiescent.** Skip until memory is observably a
  problem. Processes live until daemon shutdown.
- **Per-tenant `GOOGLE_OAUTH_CLIENT_ID/SECRET`.** Keep the hardcoded Desktop
  app credentials. Bearer tokens remain per-request via HTTP header, so
  multi-user against the same shared process still works.
- **Stdio MCP servers.** Already correctly per-agent — no shared port,
  no cross-agent collision. This proposal touches HTTP-with-startup only.
- **`atlas-platform`.** Currently re-fetched fresh per agent
  (`agent-context/index.ts:285`). Continue doing so — it's not a
  spawn-per-port server, the cost is in-process, and the existing
  behavior may be deliberate. Out of scope.
- **Cross-daemon coordination.** A separate daemon process would still
  spawn its own children and collide on port. Two-daemon-on-one-host is
  out of scope; the launcher pattern enforces single-daemon already.
- **Eager boot at daemon start.** Most workspaces use 0–2 of the 5
  Google services. Lazy on first request.

## Scope decision: daemon vs session

The colleague's investigation proposed a narrower variant: hold MCP
clients on `ActiveSession` and dispose at session/workspace shutdown
("session-scoped"). Comparison:

| | **Daemon-scoped (this doc)** | Session-scoped (alternative) |
|---|---|---|
| Lifetime | Process registry survives until daemon SIGTERM | Per-session map; disposed at session end |
| Bug fixed: TIME_WAIT between FSM steps in one session | ✅ | ✅ |
| Bug fixed: TIME_WAIT between back-to-back sessions in one workspace | ✅ | ✗ (still respawns) |
| Bug fixed: two concurrent agents in one workspace | ✅ | ✓ (within session) |
| Cross-tenant credential mixing risk | Bearer per-request mitigates; startup env shared | Sessions are user-scoped already; lower risk |
| State surface | Module-level singleton in `@atlas/mcp` | Field on `ActiveSession`, threaded through FSMEngine |
| Files touched | `~3` | `~4–6` (runtime, agent-context, fsm-engine, orchestrator) |
| Risk of leaked/stuck processes | Higher (live until daemon shutdown) | Lower (die with session) |
| `atlas-platform` cache invalidation across FSM steps with differing tool sets | N/A (not cached) | Real concern (cache invalidation logic non-trivial) |
| Hung MCP teardown blocking session completion | N/A (no per-session teardown) | Real concern (`handleSessionCompletion` is awaited) |

**Choose daemon-scoped** because:

1. It's the strictly broader fix — between-session TIME_WAIT is a real
   risk on busy workspaces (cron-driven email scanners, chat sessions
   landing close together) and session-scope leaves it unfixed.
2. Smaller surface area to thread through (no FSMEngine / orchestrator
   plumbing).
3. The cross-tenant concern is mitigated by per-request Bearer tokens
   plus the hardcoded shared OAuth client (which is already shared
   across all sessions today — daemon-scope doesn't change tenancy
   behavior).
4. We dodge the `atlas-platform` cache-invalidation question and the
   "session-completion blocked on dispose" concern entirely, because
   neither is in the daemon-scoped lifecycle.

The session-scoped alternative remains a fallback if daemon-scoped
runs into trouble during implementation (e.g. stuck-process
diagnosis turns out to be too painful).

## Proposed shape

A daemon-scoped singleton process registry inside `@atlas/mcp`,
consulted by `connectHttp` before spawning. First caller for
`google-gmail` spawns and registers the child. Subsequent callers
find the registered process and skip the spawn. The registry — not
the per-agent `createMCPTools` call — owns the child's lifetime.
`dispose` closes the MCP client only; the child stays alive across
`createMCPTools` invocations and dies with the daemon.

### Registry interface

New file: `packages/mcp/src/process-registry.ts`.

```ts
interface SharedProcessHandle {
  /** The PID-bearing child. Owned by the registry, not the caller. */
  child: ChildProcess;
  /** Resolves once the URL becomes reachable. Subsequent callers await this. */
  ready: Promise<void>;
}

interface ProcessRegistry {
  /**
   * Get-or-spawn a long-lived child for this serverId. Awaits the readiness
   * promise so the caller can connect immediately after `await`.
   *
   * Concurrent calls for the same serverId share the same spawn — the
   * second caller does not race a duplicate spawn.
   */
  acquire(
    serverId: string,
    spec: SharedProcessSpec,
    deps: { spawn: typeof defaultSpawn; fetch: typeof fetch },
    logger: Logger,
  ): Promise<SharedProcessHandle>;

  /** Kill all registered children. Called on daemon shutdown. */
  shutdown(): Promise<void>;
}

interface SharedProcessSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  readyUrl: string;
  readyTimeoutMs: number;
  readyIntervalMs: number;
}

/** Module-level singleton for the daemon process. */
export const sharedMCPProcesses: ProcessRegistry;
```

### How `connectHttp` changes

`packages/mcp/src/create-mcp-tools.ts:352-471`:

1. **Reachable check stays first** — if something is already listening
   (e.g. from a prior daemon run that didn't shut down cleanly, or an
   external server), connect to it without registry involvement. No
   regression.
2. **If unreachable AND `startup` is present** → call
   `sharedMCPProcesses.acquire(serverId, spec, deps, logger)` instead
   of the current inline `_spawn` + poll loop.
3. **`acquire` handles**:
   - Concurrent first-spawn (mutex per serverId so two callers don't
     both spawn).
   - Polling readiness (logic moved from current `connectHttp`).
   - Tracking child for daemon-shutdown cleanup.
4. **`connectHttp` returns `{ client, tools, children: undefined }`**
   — no children tracked at the call site, because the registry owns
   them.

The current EADDRINUSE-stderr-fallback in `connectHttp` is **deleted**.
With the registry in place, the fallback is unreachable: the registry
never respawns a child while one is alive, and the only TIME_WAIT
window comes from a *previous* daemon run, which is handled by the
reachable-first check (or by a manual cleanup if the prior daemon
left an orphan). The bogus stderr-detection code adds risk without
covering any remaining failure mode — see "Ruled-out alternatives".

### How `disposeAll` changes

`packages/mcp/src/create-mcp-tools.ts:204-228`:

`disposeAll` currently kills every child in the call's `allChildren`
set. After this change, **`createMCPTools` never holds children for
HTTP-with-startup configs**, because `connectHttp` no longer returns
any. Stdio MCP children (`connectStdio`) keep their current per-agent
lifetime — they're not in the registry, and `client.close()` already
kills the stdio subprocess via the transport. So `disposeAll` keeps
the SIGTERM/grace/SIGKILL pattern but the registry-owned children
never reach it.

### Daemon shutdown wiring

`apps/atlasd/` boots the daemon. Wherever it registers shutdown hooks
(SIGTERM/SIGINT handler), call `await sharedMCPProcesses.shutdown()`
before exit. `shutdown` SIGTERMs every registered child, waits ~2s,
then SIGKILLs survivors — same pattern as `disposeAll` today.

If the daemon crashes hard (SIGKILL), child processes orphan. The
launcher's existing orphan sweep
(`tools/friday-launcher/main.go`, `SweepByBinaryPath` per CLAUDE.md)
needs to know to clean up `uvx workspace-mcp` too. Verify whether
the existing sweep already covers `uvx`-spawned children or only
`pty-server`/`webhook-tunnel`/`playground`.

## Concurrency

- **Two callers, same serverId, neither has spawned yet:** the
  registry's per-serverId mutex (or the cached
  `Promise<SharedProcessHandle>` itself acting as the mutex) means
  only one spawn happens; the second `await`s the same readiness
  promise.
- **First caller's spawn fails (e.g. `uvx` not installed):** the
  cached promise rejects; second caller sees the same rejection. The
  cache entry is *removed* on failure so a retry can spawn fresh.
- **Child dies mid-life** (OOM, manual kill, port stolen): the
  registry's `child.on('exit')` handler removes the cache entry. Next
  caller spawns a new one. In-flight callers using the old client get
  an HTTP error and the per-agent retry/error path handles it.
- **Concurrent shutdown + acquire:** acquire after `shutdown()` has
  been called must reject (the daemon is dying, no new spawns). A
  `disposed: true` flag on the registry, checked at the top of
  `acquire`.

## Edge cases & their resolution

| Case | Resolution |
|---|---|
| External pre-existing server on the port (e.g. user runs `workspace-mcp` manually for debugging) | The reachable-first check in `connectHttp` short-circuits before `acquire`. We never claim ownership of something we didn't spawn. |
| Daemon restart with stale child still bound to port | Same as external pre-existing — reachable check connects to it. The orphan from the prior run keeps serving until the launcher sweep or manual `kill`. Acceptable: the binary is the same. |
| Daemon restart inside the prior run's TIME_WAIT window | Registry is empty → acquire → spawn → uvicorn `bind()` fails silently (the same bug we're fixing, but on cold start). Mitigation: launcher sweep should kill prior `uvx workspace-mcp` *and* wait for TIME_WAIT to clear before relaunching the daemon, or the daemon should retry-with-backoff on first-spawn failure. Track as a separate bead. |
| Two distinct services using the same port (currently nothing in the registry, but defensive) | Cache key is `serverId`, not port. Two services with the same port would both try to spawn and the second would fail — same as today. Out of scope until it actually happens. |
| Test isolation | `sharedMCPProcesses` is exported; tests reset it in `beforeEach` via a `_resetForTesting()` helper. Existing `create-mcp-tools-startup.test.ts` mocks `spawn`/`fetch` — those mocks pass through to `acquire` unchanged. |
| Tool count metrics | `connectHttp` already logs `toolCount` per `createMCPTools` call. Unchanged — each agent still pulls its own tool list per connect. |
| `atlas-platform` server | Not affected. Continues to be re-fetched fresh per agent in `agent-context/index.ts:285` — it's an in-process server with no port and no startup command, so the registry never sees it. |

## Ruled-out alternatives

The colleague investigation
(`docs/investigations/2026-04-28-mcp-respawn-time-wait.md` from
~/Downloads/mcp/, scripts at
`docs/investigations/2026-04-28-mcp-respawn-scripts/`) empirically
disproved two surgical fixes. Documenting here so we don't relitigate
when slicing beads.

### Node `net.createServer().listen()` test-bind probe — disproven

Idea: before spawning `uvx`, do `net.createServer().listen(port)` to
probe whether the port is bindable. If `listen()` errors `EADDRINUSE`,
wait + retry. If it succeeds, close the test-server and proceed to
spawn.

Reality: Node defaults `SO_REUSEADDR=1`. uvicorn doesn't (or sets a
different combination). Empirically across 5 trials in
`probe-vs-uvicorn.ts`, Node's probe reported "free" on the same port
where uvicorn's subsequent `bind()` failed. The probe answers a
different question than the one we care about.

### stderr pattern matching — false-positive cost

Idea: detect `exitCode !== 0 && stderr.includes("Protected resource
metadata")` → treat as TIME_WAIT, retry with backoff.

Reality: TIME_WAIT and *bogus OAuth credentials* produce **byte-for-byte
identical** stderr (`stderr-signatures.ts`, 6 failure modes
characterized). A retrier on this signature would silently delay
genuine config errors by the full retry budget (~10–20s).

This is the proximate reason the current EADDRINUSE-string fallback in
`connectHttp:441-450` doesn't recover from the real bug — uvicorn
prints neither `EADDRINUSE` nor `address already in use`. Deleting the
fallback (rather than trying to fix it) is part of this design.

### Upstream fix in workspace-mcp / uvicorn — possible, not load-bearing

File issue requesting `SO_REUSEADDR=1` on uvicorn's bind. Even if
upstream fixes it, we'd still want the Friday-side registry for the
broader sharing benefits (concurrent agents, cross-session reuse).
Track separately.

## Test plan

New file `packages/mcp/src/process-registry.test.ts`:

1. First `acquire` spawns; subsequent `acquire` for same id reuses
   (assert `spawn` called once across N concurrent `acquire` calls).
2. Failed spawn (mock `spawn` throws) → both concurrent callers see
   the error; cache entry removed; next `acquire` spawns again.
3. Child exit removes cache entry; next `acquire` spawns fresh.
4. `shutdown()` SIGTERMs all registered children, then SIGKILLs
   survivors after the grace window.
5. `acquire` after `shutdown` rejects.

Existing tests in `create-mcp-tools-startup.test.ts` need updating:
the `children` field on the return value is no longer populated for
HTTP+startup configs. Replace assertions on `result.children` with
assertions on the registry's state. The EADDRINUSE-fallback test
(`"EADDRINUSE fallback: spawn fails with port in use, existing
server is reachable → connects directly"`) is **deleted** alongside
the fallback code. Stdio behavior tests are unaffected.

End-to-end verification using the colleague's repro script
`rapid-respawn.ts` (~/Downloads/mcp/2026-04-28-mcp-respawn-scripts/),
adapted to drive `createMCPTools` directly: spawn, dispose,
immediately re-acquire — must succeed deterministically. Compare
against the current `main` where it fails ~100% within the TIME_WAIT
window.

End-to-end behavioral check: rerun the
`square_nutmeg`/`b06de932-…` session and the `chewy_gouda`/`ca88d506-…`
session. Both must complete without `MCPStartupError`. After the
change, `ps` should show one persistent `workspace-mcp` per service
for the daemon's lifetime, not a churn of spawns and exits.

## Risks

- **Memory accumulation.** ~5 Python processes × ~150–250 MB RSS each
  if every Google service gets touched once. Acceptable for the
  targeted user (laptop daemon); flag for revisit on long-running
  headless deployments.
- **Stuck process diagnosis gets harder.** Today, `lsof -i :8002`
  showing no listener implies "Friday will respawn next call." After
  this change, the same observation could mean "the daemon's
  registered child died and the next acquire will respawn" — which is
  fine, but operationally subtle. Add registry state to the daemon's
  `/api/health` or equivalent debug endpoint.
- **Behavior change visible to callers.** `connectHttp` returning
  `children: undefined` for the HTTP+startup case. Verify no caller
  outside `createMCPTools` reads that field. Quick grep before
  slicing tasks.
- **Test flakiness from real port binding.** All tests must mock
  `spawn` and `fetch`; never bind real ports. The existing pattern
  already does this.
- **Cold-start TIME_WAIT.** A daemon restart inside the previous
  run's TIME_WAIT window will hit the same bind failure on the
  *first* call, since the registry is empty. The launcher's orphan
  sweep should kill prior `uvx workspace-mcp` processes and ideally
  wait for ports to clear. Tracked as separate bead.

## Open questions

1. Should `sharedMCPProcesses` live in `@atlas/mcp` (next to
   `connectHttp`) or in `@atlas/core` (where the daemon-scoped state
   typically lives)? Lean `@atlas/mcp` — keeps the cross-cutting
   concern co-located with the only code that uses it, no new
   imports needed.
2. Do we also need a `release(serverId)` API for tests / explicit
   teardown, or is `shutdown()` sufficient? Default to shutdown-only;
   add release if a test needs finer control.
3. Should the launcher's `SweepByBinaryPath` learn about
   `uvx workspace-mcp`? Confirm during implementation by reading the
   existing sweep code in `tools/friday-launcher/main.go`.
4. **Cold-start TIME_WAIT recovery:** retry-with-backoff on first
   acquire if the spawn fails silently? Or rely entirely on the
   launcher sweep + TIME_WAIT clearing naturally? The first-spawn
   failure on a fresh daemon was specifically the case the colleague
   investigation traced — worth deciding before slicing the bead.
5. **Does uvicorn upstream care?** Tracked as a separate item — file
   an issue requesting `SO_REUSEADDR=1`. Not load-bearing for this
   design.

## Slicing into beads (preview, not the bead spec)

Rough ordering for when we cut tasks:

1. Add `process-registry.ts` with `acquire` / `shutdown`, fully
   unit-tested.
2. Wire `connectHttp` to call `acquire` instead of inline spawn;
   delete the EADDRINUSE-stderr-fallback branch.
3. Update existing `create-mcp-tools-startup.test.ts` for the new
   return shape; delete the EADDRINUSE-fallback test.
4. Wire `sharedMCPProcesses.shutdown()` into the daemon's shutdown
   handler in `apps/atlasd/`.
5. **Cold-start TIME_WAIT handling.** Either (a) retry-with-backoff on
   first acquire when the child exits non-zero with empty stderr
   signature, or (b) leave it to the launcher sweep + manual restart.
   Decide answer to open question #4 first.
6. (Separate, optional) Audit `tools/friday-launcher` orphan sweep
   for `uvx workspace-mcp`; extend if needed.
7. **End-to-end verification using the colleague's repro
   `rapid-respawn.ts`** plus rerun of sessions
   `square_nutmeg`/`b06de932-…` and `chewy_gouda`/`ca88d506-…`. Both
   must complete; `ps` should show one persistent `workspace-mcp`
   per service.
8. (Separate) File upstream issue with `workspace-mcp` /
   `fastmcp` / `uvicorn` re: silent bind-failure +
   `SO_REUSEADDR=1`. Not blocking this work; useful long-term.

## Credits

- Bug originally surfaced by @michal in workspace `square_nutmeg`,
  session `b06de932-88e4-43d4-8b7f-ecde67dafc5b`.
- Independent root-cause investigation by @eric in workspace
  `chewy_gouda`, session `ca88d506-7201-4bc9-81aa-5d99632504c8`.
  Provided the empirical disproofs for Node test-bind probe and
  stderr pattern matching, the `rapid-respawn.ts` repro, and the
  `stderr-signatures.ts` characterization across failure modes.
  Investigation doc + scripts at
  `~/Downloads/mcp/2026-04-28-mcp-respawn-time-wait.md` and
  `~/Downloads/mcp/2026-04-28-mcp-respawn-scripts/`.
