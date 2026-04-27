# Review Report — studio-artifact-design v5

**Date:** 2026-04-24
**Reviewer:** /improving-plans
**Output:** docs/plans/2026-04-23-studio-artifact-design.v6.md

---

## Context Gathered

- Read `docs/plans/2026-04-23-studio-artifact-design.v5.md`: current plan under review.
- Read all prior review reports (v1–v4): confirmed all previously covered issues excluded from new review.
- Grepped `ReadHeaderTimeout`, `ReadTimeout`, `IdleTimeout`, `WriteTimeout` across `apps/cortex/main.go`, `apps/gist/service/serve.go`, `pkg/server/listener.go`:
  - `pkg/server/listener.go`: sets `ReadHeaderTimeout: 10s`, `ReadTimeout: 30s`, `WriteTimeout: defaulted` — but NOT used for the download port
  - `apps/cortex/main.go`: sets only `ReadHeaderTimeout: 10 * time.Second` — no ReadTimeout, no IdleTimeout. This is the reference for the download port.
- Grepped error logging patterns in `apps/cortex/service/download.go` and `apps/gist/service/serve.go`: both explicitly call `log.Error(...)` before every `http.Error(..., 500)`. Confirmed pattern is standard.
- Analyzed `If-Modified-Since` precision: `storage.ObjectAttrs.Updated` is nanosecond-precision `time.Time`; HTTP `Last-Modified` header is RFC1123 (second precision); `http.ParseTime` returns zero nanoseconds; without truncation, `meta.LastModified.Equal(ifModSince)` is always false → every conditional GET returns 200 instead of 304.

---

## Issues Raised and Resolved

### Issue 1 — "Idle and read-header timeouts remain in place" is inaccurate ✅ RESOLVED

**Finding:** The plan's HTTP write timeout section said "Idle and read-header timeouts remain in place to defend against slow-loris attacks." This implies both idle and read-header timeouts are set. But the cortex pattern (the reference for the download port's `http.Server`) sets only `ReadHeaderTimeout: 10 * time.Second` — no `ReadTimeout`, no `IdleTimeout`. The claim of "idle timeout in place" is false.

**Decision:** Replace the vague description with the exact `http.Server` literal, explicitly showing `ReadHeaderTimeout: 10 * time.Second` and `WriteTimeout: 0`. Makes it unambiguous what gets set and what doesn't.

**Alternatives considered:**
- B: Rewrite to "read-header timeout only, no idle timeout" — rejected (accurate but doesn't give the value, still requires consulting cortex)
- C: Keep as-is — rejected (inaccurate; "idle timeout in place" is false)

**Impact on v6:** Replaced prose description with an explicit `http.Server` struct literal showing `ReadHeaderTimeout: 10 * time.Second`, `WriteTimeout: 0`, no other fields. Updated package layout comment: `WriteTimeout:0, ReadHeaderTimeout:10s`.

---

### Issue 2 — `If-Modified-Since` comparison needs second-precision truncation ✅ RESOLVED

**Finding:** `ObjectMeta.LastModified` comes from `storage.ObjectAttrs.Updated` with nanosecond precision. The `Last-Modified` response header is RFC1123 (second precision only). When a CDN revalidates with `If-Modified-Since`, the value has zero nanoseconds (parsed by `http.ParseTime`). Without truncation, `meta.LastModified.Equal(ifModSince)` is always false — the handler returns 200 instead of 304 on every conditional GET, permanently defeating CDN revalidation for unchanged files.

**Decision:** Document in the handler module boundary that `If-Modified-Since` comparisons must use `meta.LastModified.Truncate(time.Second)`.

**Alternatives considered:**
- B: Pre-truncate in StorageClient — rejected (leaks HTTP header precision knowledge into the storage layer; HTTP format is the handler's responsibility)
- C: Leave to implementer — rejected (silent 200-instead-of-304 in production; would go undetected in tests since test times typically round to seconds)

**Impact on v6:** Added `If-Modified-Since` precision handling to handler module boundary hidden responsibilities. Added a test note: use a `LastModified` with sub-second precision to confirm truncation works correctly.

---

### Issue 3 — GCS error logging missing from handler module boundary ✅ RESOLVED

**Finding:** Both cortex and gist explicitly log the underlying error before returning 500: `log.Error("failed to download from GCS", "error", err)`. The `httplog` request middleware logs status codes but not the underlying cause. Without explicit `log.Error` in the handler, a GCS outage produces a stream of 500s with no diagnosable cause. The plan's handler module boundary was silent on this.

**Decision:** Add to the trust contract: "Non-ErrNotFound errors from `Stat`/`Open` are logged at error level (with the underlying error) before returning 500."

**Alternatives considered:**
- B: Separate logging section — rejected (adds plan weight for one line of code; the boundary trust contract is the right place)
- C: Leave implicit — rejected (consistent logging on 500s is a production requirement; explicit is better than implicit)

**Impact on v6:** Added logging requirement to handler module boundary trust contract. Updated package layout `handler.go` comment to include "error logging".

---

## Additional Observations (Not Raised With User)

- **`ReadTimeout` vs `ReadHeaderTimeout`**: `pkg/server/listener.go` sets both `ReadHeaderTimeout: 10s` and `ReadTimeout: 30s`. Cortex only sets `ReadHeaderTimeout: 10s`. For an artifact server, not setting `ReadTimeout` is intentional — a large upload body (if this ever got one) should not be subject to a 30s read timeout. But since this service is read-only (no upload), the difference is academic. Following cortex's minimal pattern is correct.
- **`io.Copy` error handling after headers sent**: Once the handler calls `w.WriteHeader(200)` and begins `io.Copy`, headers are committed. If the GCS reader fails mid-stream, the handler can't return 500 — the response code is already sent. The correct behavior is to close the connection (which `io.Copy` returning an error achieves), not to log a 500-level error. This is standard behavior for streaming servers. Not worth raising in the plan — it's a Go HTTP server guarantee.

---

## Unresolved Questions

None — all issues were resolved with explicit user decisions.
