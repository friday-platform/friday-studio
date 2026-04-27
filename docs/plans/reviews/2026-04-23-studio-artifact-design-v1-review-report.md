# Review Report — studio-artifact-design v1

**Date:** 2026-04-23
**Reviewer:** /improving-plans
**Output:** docs/plans/2026-04-23-studio-artifact-design.v2.md

---

## Context Gathered

- Read `apps/cortex/service/storage.go`: cortex uses `NewReader` (not `NewRangeReader`) — no range read precedent in existing code. Range reads will be new for this codebase.
- Read `apps/gist/service/storage.go` and handler: gist loads full byte slices into memory (no streaming), sets `Cache-Control: public, max-age=31536000, immutable`. Good precedent for Cache-Control on immutable assets.
- Read `apps/studio-installer/src-tauri/src/commands/download.rs`: installer **already sends `Range: bytes={existing_size}-`** for resume and handles `206 Partial Content`. No installer changes needed for range support — confirmed the service design is correct and needed.
- Read `apps/studio-installer/src/lib/installer.ts`: `MANIFEST_URL = "https://releases.hellofriday.ai/studio/manifest.json"` — one constant to update post-deploy.
- Read `pkg/server/server.go`: `Listen()` takes a `Config` with `WriteTimeout` field. Default is configurable, not hardcoded to zero.
- Read `apps/gist/main.go`: confirmed exact startup pattern (godotenv → env.Parse → service.New → profiler → Init → TLS → metrics → Serve → signal wait → 30s shutdown).
- Root `go.mod`: Go 1.25.4, `cloud.google.com/go/storage v1.62.1`.
- Dockerfile Go image: `golang:1.26.2-alpine3.23` — slight discrepancy with go.mod version; implementer should verify against other services at build time.

---

## Issues Raised and Resolved

### Issue 1 — HTTP write timeout kills large downloads ✅ RESOLVED

**Finding:** The standard `pkg/server` pattern applies a `WriteTimeout` to the HTTP server. For a 1 GB download over a slow connection (10–30 min), any finite write timeout terminates the transfer mid-stream.

**Decision:** `WriteTimeout: 0` on the download port's `http.Server`. Idle and read-header timeouts remain. Metrics server retains standard timeouts on its own port. Go's net/http detects client disconnects via request context, so goroutines do not leak.

**Alternatives considered:**
- B: Large `DOWNLOAD_WRITE_TIMEOUT` config field — rejected (fragile, creates config surface for no benefit)
- C: Per-request `http.ResponseController` deadlines — rejected (unnecessary complexity)

**Impact on v2:** Added explicit section "HTTP write timeout" in Implementation Decisions. Updated package layout comment to note `WriteTimeout:0`. Updated Out of Scope to exclude per-request timeout tuning. Updated Config struct note explaining that `pkg/server`'s `Listen()` is used only for the metrics port.

---

### Issue 2 — HEAD requests open a GCS reader unnecessarily ✅ RESOLVED

**Finding:** Go's `net/http` handles `HEAD` by calling the `GET` handler and discarding the body — but the handler still runs fully. For this service that means `Stat` + `Open` (opens a GCS `NewRangeReader`) + `io.Copy` starts + body discarded + reader closed. Wasted GCS API call on every CDN prefetch.

**Decision:** In the handler, check `r.Method == http.MethodHead` immediately after `Stat`. Write response headers and return without calling `Open`. One GCS API call instead of two.

**Alternatives considered:**
- B: Explicit `r.Head("/*", ...)` chi route — rejected (duplication of header-writing logic)

**Impact on v2:** Added HEAD row to HTTP semantics table. Added "HEAD request handling" section to Implementation Decisions. Updated handler.go module boundary description to mention HEAD short-circuit. Added HEAD test case to Testing Decisions.

---

### Issue 3 — No Cache-Control headers ✅ RESOLVED

**Finding:** The plan recommended a CDN but specified no `Cache-Control` headers. Without them the CDN either won't cache or will use heuristics — stale manifests or full cache bypass.

**Decision:** Path suffix check in handler:
- `.json` → `Cache-Control: public, max-age=60` (manifest, short TTL for release propagation)
- Everything else → `Cache-Control: public, max-age=31536000, immutable` (versioned binaries, cache forever)

No configuration needed. Matches gist's immutable policy for artifacts.

**Alternatives considered:**
- B: `MANIFEST_CACHE_TTL` / `ARTIFACT_CACHE_TTL` config fields — rejected (unnecessary config surface for a fixed policy)

**Impact on v2:** Added user story #12. Added "Cache-Control strategy" section. Updated response headers table to include `Cache-Control`. Updated handler.go module boundary description. Added `Cache-Control` assertion to Testing Decisions. Expanded Further Notes on CDN interaction.

---

## Additional Observations (Not Raised With User)

- **Installer already has range support**: `download.rs` sends `Range: bytes={existing_size}-` and handles `206`. This was confirmed during context gathering and added to Further Notes in v2 — no installer changes needed for range support.
- **Go version discrepancy**: go.mod says 1.25.4, plan Dockerfile says `golang:1.26.2-alpine3.23`. Added a note to verify at implementation time.
- **`NewRangeReader` is new in this codebase**: Neither cortex nor gist uses it. Implementers should be aware they are introducing a new GCS API call pattern — the test seam (fakeStorage interface) is critical for verifying correct offset/length handling without live GCS.
- **Multi-range rejection**: Responding `200` to multi-range requests is correct per RFC 9110 and is already in Out of Scope. No change needed.
- **Path traversal**: GCS object names are not filesystem paths; `..` is a literal character in a GCS key name. Chi normalises URL paths via `cleanPath` before routing, which eliminates `../` sequences. No explicit action needed.

---

## Unresolved Questions

None — all issues were resolved with explicit user decisions.
