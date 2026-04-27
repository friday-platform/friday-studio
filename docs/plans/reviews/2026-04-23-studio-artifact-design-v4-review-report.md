# Review Report — studio-artifact-design v4

**Date:** 2026-04-24
**Reviewer:** /improving-plans
**Output:** docs/plans/2026-04-23-studio-artifact-design.v5.md

---

## Context Gathered

- Read `docs/plans/2026-04-23-studio-artifact-design.v4.md`: current plan under review.
- Read all prior review reports (v1, v2, v3): confirmed all previously covered issues excluded from new review.
- Grepped all `apps/*/service/*.go` for health endpoint patterns: **6/7 services use `/healthz` with `middleware.Heartbeat`**. Only cortex uses `/health`, with a custom handler that pings the DB. The plan followed cortex's `/health` pattern; this service has no DB, so `/healthz` is correct.
- Grepped entire codebase for `ObjectMeta` and `ObjectAttrs`: no existing `ObjectMeta` type anywhere. The struct will be new. Confirmed the plan never defined it despite referencing it in multiple places.
- Grepped for `Content-Range`, `parseRange`, `ParseRange`: no existing range parsing in the codebase. Confirmed studio-artifact is the first service to implement RFC 7233 ranges.
- Read `pkg/server/listener.go` and `config.go`: confirmed `WriteTimeout: 0` defaults to 30s in `Listen()` — construction of `http.Server` directly in `main.go` remains mandatory (previously documented in v4, confirmed still correct).

---

## Issues Raised and Resolved

### Issue 1 — `ObjectMeta` struct fields never defined ✅ RESOLVED

**Finding:** The plan referenced `ObjectMeta` in the `StorageClient` interface, module boundary trust contract, and Testing Decisions, but never defined the struct's fields. An implementer building `StorageClient` would have to reverse-engineer the required fields from context. The minimum fields needed are: `ETag` (from `attrs.Etag`), `Size` (from `attrs.Size`, needed for Content-Length, range arithmetic, Content-Range), `ContentType` (from `attrs.ContentType`), `LastModified` (from `attrs.Updated`).

**Decision:** Add `ObjectMeta` struct definition alongside the `Config` struct in the plan.

**Alternatives considered:**
- B: List fields only in the StorageClient boundary trust contract — rejected (harder to find, buries the struct definition)
- C: Leave to the implementer — rejected (forces guessing; cheap to make explicit)

**Impact on v5:** Renamed "Config struct" section to "Config and ObjectMeta structs". Added `ObjectMeta` struct with all four fields, each annotated with the source `storage.ObjectAttrs` field. Updated package layout comment to note `ObjectMeta` lives in `service.go`. Updated StorageClient module boundary trust contract to reference `ObjectMeta` fields by name.

---

### Issue 2 — `/health` vs `/healthz`: plan follows the cortex outlier, not codebase convention ✅ RESOLVED

**Finding:** The plan specified `GET /health` (matching cortex). Grep of all services confirmed: `bounce`, `cypher`, `gateway`, `gist`, `persona`, `signal-gateway` all use `middleware.Heartbeat("/healthz")`. Cortex is the sole outlier — it uses a custom `/health` handler because it performs a DB ping. studio-artifact has no DB.

**Decision:** Change to `/healthz` with `middleware.Heartbeat("/healthz")`.

**Alternatives considered:**
- B: Keep `/health` — rejected (cortex's custom health handler is not replicable here without a DB; consistency with 6/7 services outweighs following one outlier)

**Impact on v5:** Changed user story #7 to mention `/healthz`. Changed URL structure special route from `GET /health` to `GET /healthz`. Updated package layout bullet to say `middleware.Heartbeat("/healthz")`. Removed the standalone `/health` route note (middleware.Heartbeat handles exclusion from logs automatically).

---

### Issue 3 — Range clamping when M ≥ size not specified ✅ RESOLVED

**Finding:** The plan documented `bytes=N-M` (sub-range) but did not address the case where `M ≥ object size`. RFC 7233 §2.1 specifies this is a satisfiable range, but `Content-Range` must reflect the actual end byte (`size-1`), not the requested `M`. An implementer could easily write `Content-Range: bytes N-M/size` where M > size-1, which is invalid and will confuse CDNs.

**Decision:** Add a note to the handler module boundary specifying the clamping rule: `end = min(M, size-1)` when M ≥ size; `Content-Range` reflects actual end, not requested M.

**Alternatives considered:**
- B: New row in HTTP semantics table — rejected (slightly padded; the clamping is a sub-case of bytes=N-M, not a new scenario)
- C: Leave implicit — rejected (non-obvious enough to produce a real bug in the Content-Range header)

**Impact on v5:** Added clamped sub-range row to HTTP semantics table showing `Content-Range: bytes N-{size-1}/{size}`. Updated handler module boundary hidden responsibilities to include range clamping rule. Added clamped-range test case to Testing Decisions (assert Content-Range end = size-1 not M). Added "Suffix range requests (`Range: bytes=-N`)" to Out of Scope to close the related question.

---

## Additional Observations (Not Raised With User)

- **Suffix range `bytes=-N` gap**: Not raised because the installer never uses suffix ranges and adding support would be non-trivial (requires computing `offset = size - N` from `ObjectMeta.Size`). Added to Out of Scope in v5 with an explanation, so implementers don't wonder whether to support it.
- **ETag quoting**: GCS `ObjectAttrs.Etag` is documented as "the HTTP/1.1 Entity tag for the object" — this implies it includes surrounding quotes and is already a valid ETag string. The existing plan note ("already a valid HTTP ETag string") is correct. No action needed.
- **`middleware.Heartbeat` vs custom health handler**: `middleware.Heartbeat` from chi/v5 returns 200 OK and automatically excludes the path from request logs when passed to `httplog.RequestLogger`. This is the correct pattern for a stateless health check with no dependencies to ping.

---

## Unresolved Questions

None — all issues were resolved with explicit user decisions.
