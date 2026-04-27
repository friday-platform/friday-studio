# Review Report — studio-artifact-design v3

**Date:** 2026-04-24
**Reviewer:** /improving-plans
**Output:** docs/plans/2026-04-23-studio-artifact-design.v4.md

---

## Context Gathered

- Read `docs/plans/2026-04-23-studio-artifact-design.v3.md`: current plan under review.
- Read all prior review reports (v1, v2): confirmed all previously covered issues (WriteTimeout, HEAD optimization, Cache-Control, ETag source, graceful shutdown 30s drain).
- Read `apps/cortex/main.go`: confirmed pattern for constructing `http.Server` directly with `ReadHeaderTimeout: 10s` but no `WriteTimeout` field — matches the plan's WriteTimeout:0 approach.
- Read `apps/gist/main.go` and `apps/gist/service/serve.go`: confirmed Cache-Control: immutable pattern; gist loads full content into memory (no streaming precedent for NewRangeReader).
- Read `apps/cortex/service/storage.go` and `apps/gist/service/storage.go`: confirmed neither uses `NewRangeReader`. Both have `ServiceAccountKeyFile` credential path (not WIF) — studio-artifact will be first service with pure ADC/WIF-only auth.
- Read `pkg/server/listener.go`: **Critical finding** — `Listen()` defaults `WriteTimeout: 0` to `30 * time.Second` at line 21. Confirmed that constructing `http.Server` directly in `main.go` (as the plan specifies) is mandatory, not optional — `pkg/server`'s `Listen()` cannot produce `WriteTimeout: 0`.
- Read `pkg/server/config.go`: `Config.WriteTimeout` is `time.Duration`; zero value maps to 30s default in listener.
- Read cortex and gist `Dockerfile`: both use `golang:1.26.2-alpine3.23` — confirmed Dockerfile version in the plan is correct and matches the repo.
- Investigated `http.ServeContent` stdlib function: requires `io.ReadSeeker`; GCS `storage.NewRangeReader` returns a streaming `io.ReadCloser` that is not seekable. Confirmed ServeContent is incompatible with the no-buffering design.

---

## Issues Raised and Resolved

### Issue 1 — Leading slash in URL path not stripped before GCS key lookup ✅ RESOLVED

**Finding:** The plan stated "URL path maps 1:1 to GCS object key" but did not mention stripping the leading `/`. Chi delivers paths as `/studio/manifest.json`. GCS object keys do not start with `/` — a key of `/studio/manifest.json` is distinct from (and typically non-existent compared to) `studio/manifest.json`. Without explicit stripping, every request would produce a GCS 404.

**Decision:** Strip in the handler with `strings.TrimPrefix(r.URL.Path, "/")` before passing to `StorageClient`. The handler owns the URL→key translation; the storage layer receives clean keys.

**Alternatives considered:**
- B: Strip inside `StorageClient.Stat`/`Open` — rejected (leaks URL knowledge into the storage layer, violates the "callers never see GCS internals" trust contract)
- C: Use `chi.URLParam(r, "*")` which strips the slash — rejected (relies on undocumented chi stripping behaviour, creates a subtle dependency)

**Impact on v4:** Updated URL structure section to note that chi delivers paths with a leading `/` and the handler strips it. Added `strings.TrimPrefix(r.URL.Path, "/")` code snippet. Updated `StorageClient` trust contract to state "path must not start with `/`". Updated handler module boundary description to list "leading-slash stripping" as a hidden responsibility. Updated package layout comment for `handler.go` to include "slash-strip".

---

### Issue 2 — `http.ServeContent` is the obvious stdlib alternative; the plan should explain why it isn't used ✅ RESOLVED

**Finding:** Go's `http.ServeContent(w, r, name, modtime, content io.ReadSeeker)` handles Range requests, conditional GET (If-None-Match, If-Modified-Since), HEAD, and Content-Type — exactly what this handler needs. An implementer will find it immediately and spend time trying to make it work. The plan was silent on the reason it can't be used.

**Decision:** Add a note to the handler module boundary: `http.ServeContent` requires `io.ReadSeeker`; GCS streaming readers are not seekable; using it would require `io.ReadAll` (full buffering), defeating the no-buffering design goal. The handler hand-rolls RFC 7233 range parsing.

**Alternatives considered:**
- B: Add to Out of Scope — rejected (Out of Scope is for features not built, not architectural reasons)
- C: Leave undocumented — rejected (implementers will waste time discovering the incompatibility)

**Impact on v4:** Added "Note" paragraph to `service/handler.go` module boundary explicitly stating why `http.ServeContent` is not used.

---

### Issue 3 — Conditional GET + Range interaction: RFC 7233 §6 evaluation order not specified ✅ RESOLVED

**Finding:** The plan listed conditional GET (`If-None-Match`, `If-Modified-Since`) and Range requests as separate features in the HTTP semantics table, but said nothing about how they interact. RFC 7233 §6 specifies that preconditions are evaluated before Range — a matching `If-None-Match` must return `304 Not Modified` even when a `Range` header is also present. An implementer who evaluates Range first (returning `206`) and then checks conditionals would implement this incorrectly, causing CDN cache validation to break.

**Decision:** Add a row to the HTTP semantics table for the combined case (matching conditional + Range → 304), and add a note to the handler module boundary listing precondition evaluation as a hidden responsibility with a reference to RFC 7233 §6. Add a corresponding test case to Testing Decisions.

**Alternatives considered:**
- B: Table row only — rejected (captures the behaviour but doesn't tell the implementer about the ordering requirement or why)
- C: Leave implicit — rejected (RFC 7233 §6 is non-obvious; cheap to make explicit, dangerous to omit)

**Impact on v4:** Added "Unchanged resource + Range" row to HTTP semantics table (304 wins). Updated handler module boundary to list "precondition evaluation order (If-None-Match / If-Modified-Since evaluated before Range per RFC 7233 §6 — a matching ETag returns 304 even if a Range header is present)" as a hidden responsibility. Added "conditional GET + Range (assert 304 returned, not 206)" to Testing Decisions test case list.

---

## Additional Observations (Not Raised With User)

- **`pkg/server/listener.go` WriteTimeout default**: Confirmed at line 21 that `Listen()` converts `WriteTimeout: 0` to `30 * time.Second`. The plan's instruction to construct `http.Server` directly in `main.go` is mandatory, not a style preference. Added an explanatory note to the "HTTP write timeout" section in v4 pointing at `pkg/server/listener.go`.
- **No existing WIF-only service**: Both cortex and gist use `ServiceAccountKeyFile` credential path with ADC fallback. studio-artifact will be the first service with ADC/WIF-only (no key file path). This is correct per the design decision — not a problem, just worth noting for implementers.
- **GCS `NewRangeReader` still new to codebase**: Noted in v1 report; still true. The `fakeStorage` test seam remains the primary way to verify correct offset/length handling without live GCS.

---

## Unresolved Questions

None — all issues were resolved with explicit user decisions.
