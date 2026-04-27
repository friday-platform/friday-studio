# Webhook Tunnel — Go rewrite

**Status:** Design — ready to implement
**Author:** lcf + Claude
**Date:** 2026-04-26

---

## Problem Statement

The studio platform tarball is bloated by Deno-compiled binaries. The
`webhook-tunnel` binary alone is **997 MB** per platform — embedding V8
(~700 MB) plus the bundled npm graph (~250 MB). Across four target platforms
that's ~4 GB just for one small HTTP forwarder.

This makes every studio release slow to build, slow to download, and slow
to install on user machines. Earlier work converted `pty-server` to Go and
the binary collapsed to ~10 MB. The same opportunity exists here, but
larger in absolute terms because `webhook-tunnel` is shipped on every
platform target while `pty-server` is one of several smaller savings.

A second, related problem: the friday-launcher Go module currently lives
under its own `go.mod`, isolated from the rest of the atlas Go code in
`pkg/`. This was an over-cautious split — the supposed dep conflicts with
the root module turn out to be cosmetic (only `creack/pty` differs by a
patch version). The isolation now blocks code reuse: webhook-tunnel needs
the launcher's hard-won child-process lifecycle helpers, and copy-pasting
them creates drift on a class of code (cross-platform process kill, Job
Object, orphan sweep) where drift is exactly what bites a year later.

## Solution

A faithful 1:1 Go rewrite of `webhook-tunnel`, sized like the existing
Go binaries in the platform tarball (~10 MB stripped). The rewrite ships
in three phases so each step is reviewable independently and a regression
in one phase doesn't poison the others:

1. **Consolidate the launcher into the root Go module** so webhook-tunnel
   (and any future Go binary) can import shared code natively.
2. **Extract a `processkit` package** under `pkg/` with the launcher's
   process-lifecycle helpers (kill, Job Object, orphan sweep, sysprocattr).
3. **Rewrite webhook-tunnel** as a Go binary in `tools/`, importing
   `processkit`, embedding `webhook-mappings.yml` and the diceware
   wordlist, and managing cloudflared as a subprocess (same shape as the
   current TS code, but with goroutines + channels instead of EventEmitter).

Result: ~990 MB shaved from each platform's tarball, plus one fewer Go
module to maintain and a clean home for child-process plumbing.

## User Stories

1. As a studio user, I want my installer download to be smaller and faster
   so I'm not waiting on hundreds of MB of unnecessary V8 bytes.
2. As a studio user, I want the install to extract faster so the install
   wizard finishes in seconds, not minutes.
3. As a studio user, I want webhook-tunnel to behave identically to the
   Deno version so my existing webhook setups (GitHub PR, Slack, WhatsApp,
   Telegram) keep working with no config changes.
4. As a studio user, I want the auto-generated passphrase (when
   `WEBHOOK_SECRET` is unset) to keep working so first-run dev experience
   is unchanged.
5. As a studio user, I want both quick tunnels (trycloudflare.com URL) and
   token-backed named tunnels to keep working so my existing `TUNNEL_TOKEN`
   continues to surface a stable URL.
6. As a studio user, I want the same webhook URL pattern
   (`/hook/{provider}/{workspaceId}/{signalId}`) so existing third-party
   webhook registrations don't need to be re-pointed.
7. As a studio user, I want the `/platform/{provider}/{suffix}` pass-through
   to keep working so Chat SDK adapters (WhatsApp, Slack, Telegram) keep
   verifying upstream.
8. As a release engineer, I want webhook-tunnel built by the same
   `compileGo` pipeline as pty-server and friday-launcher so the build
   matrix has one Go-binary code path, not two.
9. As a release engineer, I want webhook-tunnel signed in the same codesign
   loop so the macOS notarization step needs no special cases.
10. As an atlas dev working on Go code, I want the launcher's process-kill
    helpers in a shared package so I don't copy-paste them when I write the
    next supervised binary.
11. As an atlas dev, I want a single `go test ./...` from the repo root to
    cover every Go package including the launcher so test coverage isn't
    split across modules I might forget to run.
12. As an atlas dev running `go mod tidy`, I want one module graph to think
    about, not two.
13. As a webhook integrator, I want to override the bundled
    `webhook-mappings.yml` via the existing `WEBHOOK_MAPPINGS_PATH` env var
    so I can add a custom provider without rebuilding the binary.
14. As a webhook integrator debugging signature failures, I want the same
    HMAC-SHA256 contract (sha256= prefix, timing-safe compare) so my
    existing signing logic works unchanged.
15. As an oncall during a tunnel outage, I want the auto-reconnect with
    exponential backoff to keep working so the tunnel recovers from laptop
    sleep and network changes without manual intervention.
16. As an oncall, I want the two-axis health probe (process alive + edge
    connection count > 0) to keep working so a stalled cloudflared with
    zero edge connections triggers reconnect even though the process is
    technically still running.
17. As a launcher author, I want webhook-tunnel's binary to live in the
    same install layout (sibling to friday/link/etc.) so the launcher's
    process spec and health probe configuration need no changes.
18. As a future Go-binary author, I want a stable `processkit` API so my
    binary can spawn children with cross-platform cleanup guarantees
    (Setpgid + Job Object) without re-deriving the platform tricks.
19. As a Windows user, I want webhook-tunnel's child cloudflared process
    to die with webhook-tunnel even on hard kill so I don't accumulate
    orphan cloudflared processes after crashes.
20. As a Unix user, I want SIGTERM to webhook-tunnel to propagate to
    cloudflared via process group so graceful shutdown actually shuts
    cloudflared down too.
21. As a CI engineer, I want the Go module consolidation to be a separate
    no-behavior-change PR so a regression in the launcher is immediately
    attributable to the consolidation, not bundled with hundreds of lines
    of webhook-tunnel code.

## Implementation Decisions

### Phase 1 — Consolidate friday-launcher into root module

- **No behavior change.** Pure module surgery.
- The launcher's own `go.mod` and `go.sum` are deleted. The launcher
  becomes another `package main` directory under `tools/`, identical to
  `pty-server` and `stripe-backfill` which already live in the root module.
- The root `go.mod` `go` directive moves from 1.25.4 to 1.26 (the launcher
  already requires 1.26 and CI is already on 1.26).
- `creack/pty` upgrades from v1.1.21 to v1.1.24 in the merged module
  (point-release range, API stable; root callers verified).
- The `./tools/friday-launcher` entry is removed from `go.work` (no longer
  a separate module).
- The studio build script's Go-binary compilation loop is updated so the
  launcher entry builds with no special cwd handling — same as pty-server.
- `go mod tidy` from the root absorbs ~80 transitive deps from
  process-compose et al. as indirects. This grows the root `go.mod` file
  but doesn't affect runtime behavior of any other binary because Go's
  package-level dead-code elimination keeps unused packages out of unrelated
  binaries.

### Phase 2 — Extract `pkg/processkit`

- **No behavior change.** Mechanical move + rename.
- A new package `processkit` under `pkg/` houses cross-platform child-process
  lifecycle code. The launcher's existing `kill_*.go`, `jobobject_*.go`,
  and `orphans.go` files move there, change package, and export their
  previously-unexported helpers.
- The launcher's call sites switch from local references to `processkit.X`.
- Unit tests come along with the move and run from the root `go test`.
- Future Go binaries (webhook-tunnel from phase 3, any later additions)
  import `processkit` natively via the root module path.

### Phase 3 — Rewrite webhook-tunnel in Go

- A new `package main` directory under `tools/` houses the binary. Same
  layout convention as pty-server and the consolidated launcher.
- The TS source is removed from the `apps/` Deno + npm workspace lists in
  the same commit so the workspace tooling stops trying to build it.
- The studio build script registers webhook-tunnel as a new Go-binary
  entry. It picks up the existing codesign loop in the studio-build CI
  workflow with no workflow change.
- The cloudflared subprocess is managed directly by webhook-tunnel — not
  embedded as a library. Library embedding was evaluated and rejected:
  cloudflared's "library" surface is incidental (no stable API, requires
  ~600 LoC of CLI-context wiring even for a quick tunnel, brings 86
  transitive deps including the entire QUIC / Prometheus / OpenTelemetry
  stack), and embedding would lose process isolation (a cloudflared crash
  would take down our HTTP server too).
- `webhook-mappings.yml` is embedded in the binary via `go:embed` so the
  binary is fully self-contained. The existing `WEBHOOK_MAPPINGS_PATH` env
  var continues to work as an override for ops that want to add providers
  without rebuilding.
- The diceware wordlist for passphrase generation is embedded the same
  way. Replaces the npm `random-words` dependency.
- All four current routes are preserved: `/health`, `/status` (with CORS
  for the playground), `GET /` (provider list + tunnel URL), and the two
  webhook-handling routes (`POST /hook/...` and `ALL /platform/...`).
- HTTP server uses Go stdlib `net/http` with a small router (chi or just
  `http.ServeMux` with Go 1.22's pattern syntax — chosen at implementation
  time based on which gives cleaner code for the path patterns).
- Cloudflared discovery order: sibling of own binary path (resolves the
  studio install layout); then `$PATH`; then dev-machine fallbacks
  (`/opt/homebrew/bin`, `/usr/local/bin`). The npm-install fallback from
  the TS version is dropped — studio bundles ship cloudflared, dev devs
  install via Homebrew.

### Module Boundaries

#### `tunnel` (internal to webhook-tunnel)

- **Interface:** `New(opts) → *Manager` constructor; `Manager.Start(ctx)`,
  `Manager.Stop()`, `Manager.Status()` returning a value snapshot of URL,
  alive flag, restart count, and last probe time.
- **Hides:** Cloudflared's stdout log line format and parsing rules; the
  reconnect state machine (exponential backoff 1s→30s, max-startup-retries,
  reconnect-while-reconnecting guard, generation counter for stale-tunnel
  exit-handler suppression); the two-axis health probe (process liveness
  AND edge-connection count); platform-specific subprocess attribute
  setup; the difference between quick tunnels and token tunnels.
- **Trust contract:** Callers ask "is the tunnel alive and what's its URL"
  via `Status()` and never need to know cloudflared exists. The package
  has the only place in the codebase that pattern-matches cloudflared log
  lines, so a future cloudflared release that changes its log format
  touches one file.

#### `provider` (internal to webhook-tunnel)

- **Interface:** `Get(name) → Handler`; `List() → []string`. `Handler`
  exposes `Verify(req, secret) → error` and `Transform(req) → (payload,
  description, error)`.
- **Hides:** YAML mapping schema; dot-path extraction including array
  indexing notation; event-key resolution (header vs body field per
  provider); action filtering rules; HMAC-SHA256 verification details
  (sha256= prefix, timing-safe compare); the special-case raw-passthrough
  provider that bypasses HMAC.
- **Trust contract:** Callers pass an HTTP request and a workspace
  shared-secret and get back a normalized signal payload or an error. The
  caller doesn't know what "github" vs "bitbucket" mean structurally;
  adding a new provider is a YAML change, not a code change.

#### `forwarder` (internal to webhook-tunnel)

- **Interface:** `Forward(workspaceID, signalID, payload) → (sessionID,
  error)`; `Proxy(req, provider, suffix) → http.Response`.
- **Hides:** atlasd URL formatting; status code conventions
  (`/api/workspaces/.../signals/...` for the signal route, the platform
  pass-through path layout); request/response body and header passthrough
  rules; the bookkeeping of which response headers must be stripped or
  rewritten on the way through.
- **Trust contract:** Callers describe the user-facing intent ("forward
  this signal to this workspace") and the package handles the atlasd
  protocol details.

#### `passphrase` (internal to webhook-tunnel)

- **Interface:** `Generate() → string`.
- **Hides:** The embedded wordlist; the cryptographically-secure word
  selection logic (uses `crypto/rand`, not `math/rand`).
- **Trust contract:** Pure function. Output is a hyphenated 4-word
  diceware-style passphrase. Same shape as the TS `random-words` output
  it replaces.

#### `pkg/processkit` (root module — shared)

- **Interface:** `SetSysProcAttr(*exec.Cmd)` (call before Start);
  `AttachSelfToJob() (io.Closer, error)`; `Kill(pid, gracePeriod) error`;
  `SweepOrphans(pidDir) (int, error)`.
- **Hides:** The Setpgid/CREATE_NEW_PROCESS_GROUP cross-platform split;
  Windows Job Object setup with `KILL_ON_JOB_CLOSE`; the SIGTERM →
  wait-grace → SIGKILL escalation on Unix and the `taskkill /T /F`
  shortcut on Windows; the orphan-sweep semantics (PID-file format,
  start-time verification, owner-of-self check).
- **Trust contract:** Callers can write cross-platform Go services that
  spawn children and trust that "if my process dies, my children die
  with me, and on next startup any leftover orphans get reaped" — without
  knowing the platform-specific tricks involved.

### Cutover

- The TS `apps/webhook-tunnel/` directory is deleted in the same PR that
  introduces the Go binary, alongside its workspace-list entries. Tests
  cover the Go binary; the TS tests don't carry over (they'd be testing
  code we're removing).
- The friday-launcher's process spec for webhook-tunnel needs no change —
  same binary name, same listening port, same `/health` endpoint, same
  install layout. The launcher discovers and supervises the new binary
  identically.

## Testing Decisions

- **Good tests cover external behavior, not internals.** For
  webhook-tunnel that means: HTTP request comes in, expected forwarded
  request goes out (or expected error response comes back). Tests don't
  inspect goroutine state, internal channels, or which method of the
  tunnel manager was called in what order.

- **Modules tested:**
  - `provider`: all current GitHub / Bitbucket / Jira / raw cases. HMAC
    pass and fail cases for each provider that has signature verification.
    Dot-path extraction including array indexing, missing keys, type
    mismatches. The same fixtures used in the existing TS test suite get
    ported (the input payloads are valuable test data).
  - `tunnel`: log-line parsing rules against captured real cloudflared
    output. The reconnect state machine via fake-cloudflared subprocess
    that emits scripted output. Generation-counter test that proves a
    stale tunnel's exit handler can't fire reconnect for the live tunnel.
  - `forwarder`: signal-forward path against a mock atlasd; platform
    pass-through path against a mock that asserts headers, query string,
    body bytes, and method are all preserved.
  - `passphrase`: generates 4 hyphenated lowercase words; doesn't repeat
    within a single generation (statistical, large sample).
  - `processkit` (in pkg): per-platform unit tests for kill grace-period
    behavior; orphan sweep behavior (write a PID file with a synthetic
    leftover, run sweep, assert killed count). Job Object behavior is
    Windows-only and verified in CI's Windows runner via integration.
  - End-to-end smoke: webhook-tunnel binary started, fake provider POST
    with valid HMAC, assert atlasd-mock received the expected normalized
    payload. Doesn't run cloudflared (NO_TUNNEL=true mode).

- **Prior art for the test shapes:** The existing
  `apps/webhook-tunnel/src/*.test.ts` files (providers.test.ts, routes.
  test.ts, passphrase.test.ts) describe the intended surface with good
  fixture coverage. The Go tests preserve the same input/expected-output
  pairs — the test descriptions translate directly.

- **No mocks of the standard library.** No mocks of `*exec.Cmd`. Tests
  that need a fake subprocess use a small Go helper binary built from
  test sources, the same pattern already used in friday-launcher's
  integration tests.

## Out of Scope

- Performance work. The TS version is fast enough for human-scale webhook
  rates; the Go version will be faster as a free side effect of being
  compiled. No benchmarks are part of acceptance.
- New webhook providers or new payload-extraction features.
- New tunnel modes beyond quick + token (no `cloudflared access` or
  WARP-routing flows).
- Changes to the playground's `/status` consumer. The Go binary preserves
  the JSON response shape exactly.
- Changes to atlasd's signal API.
- Embedding cloudflared as a Go library (evaluated and rejected — see
  Implementation Decisions Phase 3).
- Auto-installing cloudflared at runtime (the TS version's npm fallback
  goes away).
- Migrating other Deno-compiled binaries to Go (separate efforts).
- Re-architecting the launcher's process matrix (webhook-tunnel slots
  into the existing slot identically).

## Further Notes

- The studio bundle currently ships cloudflared as a separate executable
  in the same install directory. Webhook-tunnel discovers it as a sibling
  of its own executable path, which means the launcher doesn't need to
  pass the path through env vars or arguments. This keeps the launcher's
  process spec for webhook-tunnel unchanged.
- Phase 1 is gating: Phase 2 needs the launcher in the root module to
  import `pkg/processkit` cleanly. Phase 3 needs Phase 2 for `processkit`.
  All three are mechanical moves with no design risk; the value of the
  phasing is reviewability and bisectability, not technical necessity.
- The `creack/pty` v1.1.21 → v1.1.24 bump in Phase 1 is the only behavior
  change in the consolidation (and it's a point-release range that doesn't
  change the public API). If a root caller does break, the bump can be
  pinned via a `go.mod` constraint.
- Future Go-binary work (e.g. if we ever rewrite link or any other
  service) inherits this layout for free: drop a `package main` directory
  under `tools/`, add a Go-binaries entry in the build script, done. No
  new module, no `go.work` edit, no `replace` directive.
