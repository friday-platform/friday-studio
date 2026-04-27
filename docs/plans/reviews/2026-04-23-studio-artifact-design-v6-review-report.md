# Review Report — studio-artifact-design v6

**Date:** 2026-04-24
**Reviewer:** /improving-plans
**Output:** docs/plans/2026-04-23-studio-artifact-design.v7.md

---

## Context Gathered

- Read `docs/plans/2026-04-23-studio-artifact-design.v6.md`: current plan under review.
- Read all prior review reports (v1–v5): confirmed all previously covered issues excluded.
- Grepped `FROM alpine` + context in `apps/cortex/Dockerfile` and `apps/gist/Dockerfile`: both have `RUN apk --no-cache add ca-certificates` in the runtime stage. The v6 plan's Dockerfile section described the multi-stage build in prose without this line.
- Grepped `SetupTLS`, `TLSConfig`, `GetTLSConfig`, `ListenAndServeTLS` in `apps/cortex/main.go`:
  - Line 47: `cfg.TLSConfig.SetupTLS()` — called before constructing the server
  - Line 60: `TLSConfig: cfg.TLSConfig.GetTLSConfig()` — set on the `http.Server`
  - Lines 69–71: `if httpServer.TLSConfig != nil { ListenAndServeTLS("", "") }` — TLS branch
  - The v6 plan's `http.Server` literal omitted `TLSConfig`, the startup sequence omitted `SetupTLS()`, and the TLS branch was absent.

---

## Issues Raised and Resolved

### Issue 1 — Dockerfile missing `RUN apk --no-cache add ca-certificates` ✅ RESOLVED

**Finding:** Alpine Linux ships without root CA certificates. Without `apk add ca-certificates` in the runtime stage, Go's TLS client cannot verify GCS's certificate — every `storage.NewClient`, `Stat`, and `Open` call fails with `x509: certificate signed by unknown authority`. The service is completely non-functional in the container. Both cortex and gist Dockerfiles include this line; the v6 plan did not.

**Decision:** Add the complete Dockerfile as a literal block (matching cortex/gist structure) with `RUN apk --no-cache add ca-certificates` explicitly annotated as required for GCS HTTPS.

**Alternatives considered:**
- B: Note it as a requirement without the command — rejected (leaves room for implementer error on a service-breaking step)

**Impact on v7:** Replaced the Dockerfile prose description with a full Dockerfile literal. Added an explicit annotation: "`ca-certificates` is required — alpine ships without root CA certificates, and without them the GCS HTTPS client fails with `x509: certificate signed by unknown authority`."

---

### Issue 2 — TLS not wired in the `main.go` startup sequence ✅ RESOLVED

**Finding:** Three gaps relative to the cortex reference:
1. `cfg.TLSConfig.SetupTLS()` not in the startup sequence — without it, `GetTLSConfig()` returns nil even when cert/key paths are set.
2. `TLSConfig: cfg.TLSConfig.GetTLSConfig()` missing from the `http.Server` literal — without it, TLS is silently absent on the download port even if configured.
3. `ListenAndServeTLS("", "")` vs `ListenAndServe` branch not mentioned — `ListenAndServeTLS` is required when `TLSConfig != nil` to actually activate TLS.

**Decision:** Replace the partial `http.Server` literal with a complete code block showing `SetupTLS()`, the full `http.Server` struct (including `TLSConfig`), and the `ListenAndServeTLS`/`ListenAndServe` branch. Annotate `SetupTLS()` with an explanation of why it must run first.

**Alternatives considered:**
- B: Defer to "follow cortex TLS wiring" — rejected (plan should be self-contained; requiring implementers to look up cortex to get TLS right is a gap)

**Impact on v7:** HTTP write timeout section now contains a complete, annotated code block showing the full TLS-aware server construction. Package layout main.go startup description updated to include `SetupTLS →` and `ListenAndServe[TLS]`.

---

## Additional Observations (Not Raised With User)

- **`var GitCommit = "unknown"` declaration**: Both cortex and gist declare `var GitCommit = "unknown"` in `main.go` as the ldflags injection target. The plan references `GITHUB_SHA` in the Dockerfile; implementers should add this variable declaration to `main.go`. Trivial enough that it doesn't need to be in the plan — it's visible in both reference services and a standard Go ldflags pattern.
- **`analytics.Init` and `profiler.Start`**: Gist calls both in its startup sequence. Cortex does not. This service is a file proxy with no user events to track and no need for continuous profiling at launch — omitting both is correct.

---

## Unresolved Questions

None — all issues were resolved with explicit user decisions.
