<!-- v4 - 2026-04-26 - Generated via /improving-plans from docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v3.md -->

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

A third problem surfaced during review: the existing Go binaries write
to the same `~/.friday/local/logs/` directory but use different log
libraries. Launcher uses `rs/zerolog`, pty-server uses raw `log/slog`.
Webhook-tunnel would be the third — a good moment to introduce a shared
atlas-flavored Go logger that mirrors the TS `@atlas/logger` shape and
migrate the existing Go binaries to it.

## Solution

A faithful 1:1 Go rewrite of `webhook-tunnel`, sized like the existing
Go binaries in the platform tarball (~10 MB stripped). The work lands as
a single ordered stack of commits on the `declaw` branch:

1. **Consolidate the launcher into the root Go module.** Remove
   `tools/friday-launcher/go.mod`, bump root toolchain, absorb
   `process-compose` and friends as indirects, drop the launcher's `go.work`
   entry, simplify `compileGo()` in the build script.
2. **Extract `pkg/processkit/`.** Move the launcher's process-lifecycle
   helpers (kill, Job Object, orphan sweep, sysprocattr) under `pkg/`,
   change package, export the helpers, update launcher call sites.
3. **Add `pkg/logger/`.** A thin Go wrapper around `log/slog` that
   matches the `@atlas/logger` TS API (level methods + `Child(kv...)` for
   merged context). Migrate launcher and pty-server to use it.
4. **Rewrite webhook-tunnel** as a Go binary at `tools/webhook-tunnel/`,
   importing `pkg/processkit` + `pkg/logger`, embedding
   `webhook-mappings.yml` and the diceware wordlist, managing cloudflared
   as a subprocess (same shape as the current TS code, but with goroutines
   + channels instead of EventEmitter).

Result: ~990 MB shaved from each platform's tarball, plus one fewer Go
module to maintain, a clean home for child-process plumbing, and a
single logger across every Go binary.

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
   verifying upstream — and to keep working *correctly*, including
   stripping hop-by-hop headers per RFC 7230 (a latent bug in the current
   TS implementation that the Go rewrite fixes for free via
   `httputil.ReverseProxy`).
8. As a studio user, I want the `/status` JSON shape preserved exactly
   (all 7 fields: url, secret, providers, pattern, active, tunnelAlive,
   restartCount, lastProbeAt) so the playground and any other consumer
   keeps working without code changes.
9. As an atlas dev running locally without `cloudflared` installed, I want
   the binary to download cloudflared on first run so my first-run
   experience matches what the npm `cloudflared` package gave me before.
10. As an atlas dev whose laptop loses network mid-download, I want the
    next launch to detect the partial download and re-fetch cleanly so I
    never end up with a broken cached cloudflared binary that fails on
    every subsequent run.
11. As an atlas dev, I want webhook-tunnel to reject malformed or
    pathologically-large request bodies (>25 MB) with a 413 response so a
    bad caller can't OOM the binary. 25 MB matches GitHub's documented
    webhook cap and is the largest body any common webhook provider sends.
12. As a release engineer, I want webhook-tunnel built by the same
    `compileGo` pipeline as pty-server and friday-launcher so the build
    matrix has one Go-binary code path, not two.
13. As a release engineer, I want webhook-tunnel signed in the same codesign
    loop so the macOS notarization step needs no special cases.
14. As an atlas dev working on Go code, I want the launcher's process-kill
    helpers in a shared package so I don't copy-paste them when I write the
    next supervised binary.
15. As an atlas dev working on Go code, I want one logger library across
    every Go binary so log shape in `~/.friday/local/logs/` is uniform and
    I can write tooling against a single format.
16. As an atlas dev, I want a single `go test ./...` from the repo root to
    cover every Go package including the launcher so test coverage isn't
    split across modules I might forget to run.
17. As an atlas dev running `go mod tidy`, I want one module graph to think
    about, not two.
18. As a webhook integrator, I want to override the bundled
    `webhook-mappings.yml` via the existing `WEBHOOK_MAPPINGS_PATH` env var
    so I can add a custom provider without rebuilding the binary.
19. As a webhook integrator debugging signature failures, I want the same
    HMAC-SHA256 contract (sha256= prefix, timing-safe compare) so my
    existing signing logic works unchanged. The Go server reads the raw
    body once, verifies HMAC over those exact bytes, then JSON-parses
    those same bytes — no double-read, no buffering ambiguity.
20. As an oncall during a tunnel outage, I want the auto-reconnect with
    exponential backoff to keep working so the tunnel recovers from laptop
    sleep and network changes without manual intervention.
21. As an oncall, I want the two-axis health probe (process alive + edge
    connection count > 0) to keep working so a stalled cloudflared with
    zero edge connections triggers reconnect even though the process is
    technically still running.
22. As an oncall stopping the launcher, I want webhook-tunnel to drain
    in-flight requests within a 25-second deadline (matching the current
    TS behavior) and then force-exit so a stuck cloudflared can't hold
    shutdown indefinitely.
23. As a launcher author, I want webhook-tunnel's binary to live in the
    same install layout (sibling to friday/link/etc.) so the launcher's
    process spec and health probe configuration need no changes.
24. As a future Go-binary author, I want a stable `processkit` API so my
    binary can spawn children with cross-platform cleanup guarantees
    (Setpgid + Job Object) without re-deriving the platform tricks.
25. As a future Go-binary author, I want a stable `pkg/logger` API so my
    binary's logs match the rest of the platform without inventing my own
    structured-log conventions.
26. As a Windows user, I want webhook-tunnel's child cloudflared process
    to die with webhook-tunnel even on hard kill so I don't accumulate
    orphan cloudflared processes after crashes.
27. As a Unix user, I want SIGTERM to webhook-tunnel to propagate to
    cloudflared via process group so graceful shutdown actually shuts
    cloudflared down too.
28. As an installer running with checksum-pinned downloads, I want the
    in-Go cloudflared fallback to verify the SHA-256 of the downloaded
    binary against the official sha256 sidecar from the same release so
    a bit-flipped or partial download is rejected. The sidecar is fetched
    from the same GitHub release, with the same TLS chain trusted for the
    binary itself — so the trust model is unchanged from "I trust GitHub
    release hosting."

## Implementation Decisions

### Commit ordering on `declaw`

This work lands as one stack of commits on `declaw`. There are no separate
PRs or feature branches. The commits are ordered so that each one builds
and passes tests on its own — bisection works.

1. **`refactor(go): collapse friday-launcher into root module`**
   - Delete `tools/friday-launcher/go.mod` and `go.sum`.
   - Bump root `go.mod` `go` directive from 1.25.4 to 1.26.
   - Resolve `creack/pty` v1.1.21 → v1.1.24 in the merged module
     (point-release range, API stable; root callers grep-verified).
   - `go mod tidy` from root absorbs ~80 transitive deps from
     `process-compose` et al. as indirects.
   - Remove `./tools/friday-launcher` entry from `go.work`.
   - Simplify `compileGo()` in the build script: delete the
     `hasOwnModule` branch that special-cased the launcher's separate
     `go.mod`. Both code paths now collapse to "build from repo root with
     the package import path".
   - Verify: launcher binary builds for all 4 targets; `go test
     ./tools/friday-launcher/...` passes; smoke-test the launcher locally.

2. **`refactor(processkit): extract cross-platform child-process helpers`**
   - Create `pkg/processkit/` package.
   - Move `kill_unix.go`, `kill_windows.go`, `jobobject_unix.go`,
     `jobobject_windows.go`, `orphans.go` from `tools/friday-launcher/` →
     `pkg/processkit/`.
   - Change package to `processkit`. Export `Kill`, `JobObject`,
     `SweepOrphans`, `SetSysProcAttr` (and `AttachSelfToJob` if that's
     the cleaner name).
   - Update launcher call sites (~10 lines).
   - Move existing tests; add coverage for the public API surface.
   - Verify: `go test ./...` from root passes; launcher binary builds and
     behaves identically.

3. **`feat(logger): introduce pkg/logger and migrate launcher + pty-server`**
   - Create `pkg/logger/` Go package wrapping `log/slog`.
   - Public API mirrors `@atlas/logger` (TS): `Trace/Debug/Info/Warn/
     Error/Fatal(msg string, kv ...any)`, `Child(kv ...any) *Logger`,
     constructor `New(component string) *Logger`.
   - JSON output to stderr by default; level read from `ATLAS_LOG_LEVEL`
     env (default `info`); component name set as the first kv pair so
     all log lines include `component=<binary-name>`.
   - Migrate `tools/friday-launcher/main.go` and friends from
     `rs/zerolog` to `pkg/logger` (mechanical translation; the kv-list
     idiom is roughly the same shape).
   - Migrate `tools/pty-server/main.go` from raw `slog` to `pkg/logger`
     (essentially adding the `component=pty-server` prefix and Fatal helper).
   - Remove `rs/zerolog` from `go.mod`.
   - Verify: `go test ./...` passes; launcher and pty-server binaries
     produce JSON logs with `component=` set.

4. **`feat(webhook-tunnel): rewrite in Go, drop Deno build`** (single
   commit but largest by line count)
   - New `tools/webhook-tunnel/` `package main` directory in the root
     module — same layout as pty-server / launcher.
   - Internal sub-packages: `tunnel/`, `provider/`, `forwarder/`,
     `passphrase/`, `cloudflared/`.
   - Embed `webhook-mappings.yml` and the diceware wordlist via
     `go:embed`.
   - Wire into `scripts/build-studio.ts` `GO_BINARIES`.
   - Remove webhook-tunnel from `apps/` Deno workspace + npm workspace
     lists.
   - Delete `apps/webhook-tunnel/` (the TS source).
   - Verify: end-to-end smoke (POST signal, observe atlasd-mock receives
     normalized payload) and full launcher start showing all 6 supervised
     processes healthy with the new Go binary in the webhook-tunnel slot.

### Architectural decisions

- **Cloudflared is a subprocess, not a Go-library import.** Library
  embedding was evaluated and rejected: cloudflared's "library" surface
  is incidental (no stable API, requires ~600 LoC of CLI-context wiring
  even for a quick tunnel, brings 86 transitive deps including the entire
  QUIC / Prometheus / OpenTelemetry stack), and embedding would lose
  process isolation (a cloudflared crash would take down our HTTP server
  too). Subprocess management is also the shape the current TS code uses
  via the npm `cloudflared` wrapper — porting goroutines + channels
  instead of EventEmitter + callbacks.

- **The body is read once.** For any route that does HMAC verification
  (`POST /hook/...`), the handler reads the raw request body fully into
  a `[]byte`, computes HMAC-SHA256 over those exact bytes for the verify
  step, then `json.Unmarshal`s the same bytes for the transform step. The
  `provider.Handler.Verify` and `Handler.Transform` methods take
  `(headers, body []byte)` rather than an `http.Request` — this keeps the
  HTTP/transport concern out of the provider package and makes the
  one-shot-body contract obvious from the signature. A naive port that
  reads `req.Body` twice would silently fail on the second read; the
  contract is explicit so this can't slip in.

- **Body size cap: 25 MB.** Both `/hook/...` and `/platform/...` wrap
  `req.Body` in `http.MaxBytesReader` with a 25 MB cap (matching GitHub's
  documented maximum webhook payload). Oversized bodies get rejected with
  413 before the handler reads them — no OOM risk from a hostile or
  buggy caller. The limit is a single constant in the route setup.

- **`/status` is a public contract.** All 7 fields are preserved exactly
  (url, secret, providers, pattern, active, tunnelAlive, restartCount,
  lastProbeAt). The contract is locked by a JSON-shape test (described
  in Testing Decisions) so any future field reordering or rename trips
  CI before it can break the playground or any other consumer.

- **`/platform` proxy uses `httputil.ReverseProxy`.** Stdlib's
  `httputil.NewSingleHostReverseProxy` (with a custom `Director` to
  rewrite path + preserve query string) handles all the proxy correctness
  details for free — including stripping RFC 7230 hop-by-hop headers
  (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`,
  `TE`, `Trailers`, `Transfer-Encoding`, `Upgrade`) which the TS version
  fails to do. Less code than a hand-rolled `http.Client.Do`, fewer bugs,
  and the latent TS bug gets fixed as a side effect.

- **Cloudflared discovery has four tiers, in order:**
  1. Sibling of own binary path. Resolves the studio install layout
     (`~/.friday/local/cloudflared`).
  2. `$PATH`. Resolves `brew install cloudflared` and any custom dev
     install.
  3. `~/.atlas/bin/cloudflared`. Resolves a previous in-Go fallback
     download.
  4. **In-Go HTTPS fallback download** to `~/.atlas/bin/`. On first run
     when none of the above succeed, download the right release artifact
     from `github.com/cloudflare/cloudflared` based on `runtime.GOOS` and
     `runtime.GOARCH`. Verify the SHA-256 against the **official sidecar
     `.sha256` file** from the same GitHub release (downloaded together).
     Show progress on stderr. Cache for next run. This preserves the
     zero-config dev experience the npm `cloudflared` package provided
     with zero per-version maintenance burden in our codebase — bumping
     the pinned cloudflared version is a one-constant change.

- **Cloudflared download is atomic.** The fallback writes the binary to
  `~/.atlas/bin/cloudflared.tmp.<pid>`, calls `(*os.File).Sync()` after
  the body is written, verifies the SHA-256 against the sidecar, then
  `os.Rename`s to the final `~/.atlas/bin/cloudflared` path. Any failure
  before the rename leaves the final path untouched and removes the
  `.tmp` (best-effort). A subsequent run on a partially-failed machine
  finds no cached binary at the final path (or the previous good one)
  and re-runs the download fresh — there is no "partial binary at the
  cache path" failure mode. On Unix the rename also sets the executable
  bit before the rename so callers can `exec.Command` the path
  immediately after `Resolve` returns. On Windows, atomic rename across
  the same volume is well-defined; the same `.tmp → rename` shape works.

- **Graceful shutdown deadline: 25 seconds.** On SIGINT / SIGTERM the
  HTTP server enters `Shutdown(ctx)` with a 25-second context (matching
  the current TS behavior). Tunnel manager is stopped concurrently;
  cloudflared subprocess is sent SIGTERM via `processkit.Kill` with a
  20-second grace then SIGKILL. If any goroutine doesn't return within
  25 seconds total, the binary force-exits with code 1.

- **The four routes match the TS version exactly.** `/health`,
  `/status` (with permissive CORS for the playground), `GET /` (provider
  list + tunnel URL), `POST /hook/:provider/:workspaceId/:signalId`,
  `ALL /platform/:provider/:suffix?`. HTTP server uses Go stdlib
  `net/http` with Go 1.22 pattern routing — no third-party router needed
  for five routes.

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
  setup (delegated to `pkg/processkit`); the difference between quick
  tunnels and token tunnels.
- **Trust contract:** Callers ask "is the tunnel alive and what's its URL"
  via `Status()` and never need to know cloudflared exists. The package
  has the only place in the codebase that pattern-matches cloudflared log
  lines, so a future cloudflared release that changes its log format
  touches one file.

#### `provider` (internal to webhook-tunnel)

- **Interface:** `Get(name) → Handler`; `List() → []string`. `Handler`
  exposes `Verify(headers, body, secret) → error` and
  `Transform(headers, body) → (payload, description, error)`. Both methods
  take `[]byte` for the body and a `http.Header`-equivalent for headers.
- **Hides:** YAML mapping schema; dot-path extraction including array
  indexing notation; event-key resolution (header vs body field per
  provider); action filtering rules; HMAC-SHA256 verification details
  (sha256= prefix, timing-safe compare); the special-case raw-passthrough
  provider that bypasses HMAC.
- **Trust contract:** Callers pass already-buffered body bytes and
  headers and get back a normalized signal payload or an error. The
  caller doesn't know what "github" vs "bitbucket" mean structurally;
  adding a new provider is a YAML change, not a code change. The
  byte-slice signature pins the one-shot-body contract — there is no
  way for a handler to accidentally re-read.

#### `forwarder` (internal to webhook-tunnel)

- **Interface:** `Forward(workspaceID, signalID, payload) → (sessionID,
  error)`; `ProxyHandler(provider) → http.Handler` returning a per-provider
  reverse-proxy handler ready to mount on the route.
- **Hides:** atlasd URL formatting; status code conventions
  (`/api/workspaces/.../signals/...` for the signal route, the platform
  pass-through path layout); the `httputil.ReverseProxy` configuration
  (Director rewriting path + preserving query, default RFC 7230 hop-by-hop
  stripping behavior).
- **Trust contract:** Callers describe the user-facing intent ("forward
  this signal" / "give me a proxy for this provider") and the package
  handles the atlasd protocol details and proxy correctness rules.

#### `cloudflared` (internal to webhook-tunnel)

- **Interface:** `Resolve(ctx) → (path string, error)`. Implements the
  four-tier discovery + atomic, sidecar-verified download fallback
  described above.
- **Hides:** Discovery order; the per-platform cloudflared release URL
  pattern; the `.sha256` sidecar fetch + comparison; the cache layout
  under `~/.atlas/bin/`; the atomic-write protocol (`tmp.<pid> → fsync →
  verify → rename` plus best-effort `.tmp` cleanup on failure); download
  progress reporting; concurrent-call coalescing (if two goroutines call
  `Resolve` simultaneously on a missing-binary machine, only one
  download fires).
- **Trust contract:** Caller asks for "a usable cloudflared binary" and
  gets back a path it can hand to `exec.Command` immediately — the
  binary is fully written, executable bit set, and sha256-verified
  against upstream before `Resolve` returns. The pinned cloudflared
  *version* (a single constant) is the only thing to change on a bump;
  the per-platform sha256 hashes come from upstream at download time and
  need no maintenance.

#### `passphrase` (internal to webhook-tunnel)

- **Interface:** `Generate() → string`.
- **Hides:** The embedded wordlist; the cryptographically-secure word
  selection logic (uses `crypto/rand`, not `math/rand`).
- **Trust contract:** Pure function. Output is a hyphenated 4-word
  diceware-style passphrase. Same shape as the TS `random-words` output
  it replaces, but with stronger entropy.

#### `pkg/processkit` (root module — shared across Go binaries)

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

#### `pkg/logger` (root module — shared across Go binaries)

- **Interface:** `New(component string) *Logger`; level methods
  `Trace/Debug/Info/Warn/Error/Fatal(msg string, kv ...any)`;
  `Child(kv ...any) *Logger` for sub-loggers with merged context.
  `kv ...any` is the slog idiom — paired key/value variadic args
  (`logger.Info("webhook received", "provider", name, "workspace", id)`)
  rather than a context-map type. Approximate symmetry with the TS
  `@atlas/logger` shape (both add structured fields) but with the
  idiomatic Go syntax that gets autocomplete and zero per-call
  allocations.
- **Hides:** Choice of underlying logger (today: `log/slog`); JSON
  output formatting; level-from-env parsing (`ATLAS_LOG_LEVEL`); the
  `Fatal` helper's logs-then-`os.Exit(1)` behavior; component-name
  prefixing on every log line.
- **Trust contract:** Callers `New("their-binary-name")` once, log
  everywhere, and trust that output is uniform JSON in
  `~/.friday/local/logs/<binary-name>.log` (via process-compose stderr
  capture) with consistent field names across every Go binary on the
  platform. Swapping the underlying logger (e.g. to `slog` v2 someday)
  is a one-package change.

### Cutover

- The TS `apps/webhook-tunnel/` directory is deleted in the same commit
  that introduces the Go binary, alongside its workspace-list entries.
  Tests cover the Go binary; the TS tests don't carry over (they'd be
  testing code we're removing).
- The friday-launcher's process spec for webhook-tunnel needs no change —
  same binary name, same listening port (9090), same `/health` endpoint,
  same install layout. The launcher discovers and supervises the new
  binary identically.
- Codesigning: webhook-tunnel slots into the existing codesign loop in
  the studio-build CI workflow alongside friday-launcher and pty-server.
  No workflow change required.
- Logger migration of launcher and pty-server is a behavior change in
  one specific way: log-line shape changes (zerolog's `time` field name,
  level encoding, etc., differ from slog). The output is still JSON to
  stderr, still captured by process-compose into the same log files —
  but anyone parsing those logs by field-name needs to update. There are
  no in-tree consumers of those logs (process-compose treats them as
  opaque text); external log aggregators (if any) need a heads-up.

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
    body bytes, and method are all preserved. Explicit hop-by-hop
    header-stripping test (request includes `Connection: keep-alive` and
    `Transfer-Encoding: chunked`; mock asserts neither header arrives).
  - `cloudflared`: per-platform release URL formatting; sidecar-mismatch
    rejection (point at a fake URL that returns wrong sha256, assert
    `Resolve` rejects); discovery tier ordering (fake all four locations,
    prove the right one wins); concurrent `Resolve` calls coalesce to a
    single download; **interrupted-download recovery test** (start a
    download against a server that closes the connection mid-body, assert
    the `.tmp` file is removed and the final path is untouched, then
    re-run `Resolve` against a working server and assert success).
  - `passphrase`: generates 4 hyphenated lowercase words; doesn't repeat
    within a single generation (statistical, large sample).
  - `processkit` (in pkg): per-platform unit tests for kill grace-period
    behavior; orphan sweep behavior (write a PID file with a synthetic
    leftover, run sweep, assert killed count). Job Object behavior is
    Windows-only and verified in CI's Windows runner via integration.
  - `logger` (in pkg): output-shape test (JSON has expected fields);
    level filtering from `ATLAS_LOG_LEVEL`; `Child(kv...)` merges
    context; `Fatal` exits with code 1.

- **Body-size cap test.** Send a POST > 25 MB to `/hook/raw/...`; assert
  413 response and that no provider handler was invoked.

- **Contract test for `/status` JSON shape.** A standalone test starts
  the webhook-tunnel HTTP server in `NO_TUNNEL=true` mode, GETs `/status`,
  and asserts the JSON has exactly the 7 expected fields with their
  expected types. Field rename or addition trips this test in CI before
  it ships. Same shape of contract test for `/health`.

- **End-to-end smoke:** webhook-tunnel binary started in `NO_TUNNEL=true`
  mode, fake provider POST with valid HMAC, assert atlasd-mock received
  the expected normalized payload. Doesn't run cloudflared.

- **Test ports.** Every test that binds an HTTP listener uses port 0
  (OS-assigned ephemeral) and discovers the actual port via the
  `net.Listener.Addr()` after `Listen`. No hardcoded ports — same pattern
  the existing launcher integration tests use.

- **Prior art for the test shapes:** The existing
  `apps/webhook-tunnel/src/*.test.ts` files (providers.test.ts, routes.
  test.ts, passphrase.test.ts) describe the intended surface with good
  fixture coverage. The Go tests preserve the same input/expected-output
  pairs — the test descriptions translate directly. `tools/friday-launcher/integration_test.go`
  is the closest prior art for binary-level integration tests in Go.

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
- Changes to the playground's `/status` consumer code. The Go binary
  preserves the JSON response shape exactly, so the playground requires
  no changes.
- Changes to atlasd's signal API.
- Embedding cloudflared as a Go library (evaluated and rejected — see
  Implementation Decisions).
- Migrating other Deno-compiled binaries to Go (separate efforts).
- Re-architecting the launcher's process matrix (webhook-tunnel slots
  into the existing slot identically).
- Extending `pkg/logger` beyond what `slog` offers (no custom sinks, no
  log rotation, no remote shipping). Process-compose handles capture and
  rotation.
- Adding a `pkg/logger` adapter for `@atlas/logger` TS (the wrapper just
  *mirrors* the API shape; there's no IPC bridge or shared schema).
- A maximum-attempts cap on the cloudflared reconnect loop. The TS
  version has no cap and faithful 1:1 port wins; if the network is
  permanently broken, the launcher's `/health` probe still returns 200
  (HTTP server is up, only the downstream is dead) so the launcher
  doesn't restart-storm webhook-tunnel.

## Further Notes

- The studio bundle currently ships cloudflared as a separate executable
  in the same install directory. Webhook-tunnel discovers it as a sibling
  of its own executable path, which means the launcher doesn't need to
  pass the path through env vars or arguments. This keeps the launcher's
  process spec for webhook-tunnel unchanged.

- The in-Go cloudflared download fallback exists for the dev-machine case
  only. In production / studio installs, cloudflared is shipped as a
  sibling binary so the fallback never fires. Bumping the pinned
  cloudflared version in webhook-tunnel is a one-constant change because
  the per-platform hashes come from the official sidecar at runtime.

- The `creack/pty` v1.1.21 → v1.1.24 bump in the consolidation commit is
  the only behavior-affecting change in the refactor. The release notes
  show no breaking changes; root callers were grep-verified to use only
  the stable `pty.Open`/`pty.Start` surface. If a regression surfaces, a
  `go.mod` constraint can pin v1.1.21 while we investigate.

- Future Go-binary work (e.g. if we ever rewrite link or any other
  service) inherits this layout for free: drop a `package main` directory
  under `tools/`, add a Go-binaries entry in the build script, import
  `pkg/logger` for log uniformity, import `pkg/processkit` if it spawns
  children. No new module, no `go.work` edit, no `replace` directive.

- The HMAC-body-once contract has a subtle implementation hazard: HTTP/1.1
  chunked transfer encoding means the body isn't necessarily fully
  available when the headers arrive. The handler must use
  `io.ReadAll(req.Body)` (wrapped in `http.MaxBytesReader` for the size
  cap) and only proceed once the read completes — not stream the body to
  the HMAC writer in parallel with parsing, which would re-introduce the
  double-read problem in a more subtle form.

- `httputil.ReverseProxy` strips hop-by-hop headers on the *request* side
  by default (`removeConnectionHeaders` + the `hopHeaders` list in the
  stdlib). It does not strip them on the *response* side automatically;
  the Go proxy does the right thing on responses too via its
  `ModifyResponse` hook if needed, but for our single-shot webhook
  responses there's no Connection-tied state to strip. Worth a unit-test
  to confirm response headers reach the original webhook caller cleanly.

- The atomic cloudflared download protocol (`.tmp.<pid> → fsync → verify
  → rename`) uses the PID suffix on the `.tmp` filename so two
  simultaneously-running webhook-tunnel processes (e.g. dev machine
  running both the `deno task dev` and a launcher-installed binary) can't
  collide on the same `.tmp` path. The concurrent-call coalescing
  *within* a single process is handled by a `sync.Once`-guarded map keyed
  on the cloudflared version constant.
