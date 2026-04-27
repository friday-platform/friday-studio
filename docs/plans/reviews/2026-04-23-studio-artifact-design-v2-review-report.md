# Review Report — studio-artifact-design v2

**Date:** 2026-04-23
**Reviewer:** /improving-plans
**Output:** docs/plans/2026-04-23-studio-artifact-design.v3.md

---

## Context Gathered

- Read `docs/plans/2026-04-23-studio-artifact-design.v2.md`: current plan under review.
- Read `docs/plans/reviews/2026-04-23-studio-artifact-design-v1-review-report.md`: confirmed issues already covered in v1 (write timeout, HEAD optimisation, Cache-Control) — excluded from new issues.
- Read `apps/studio-installer/src-tauri/src/commands/download.rs`: confirmed `Range: bytes={existing_size}-` resume logic and `206 Partial Content` handling — relevant to graceful shutdown analysis.
- Read `apps/cortex/service/storage.go` and `apps/gist/service/storage.go`: confirmed `attrs.Generation` is used for ETag in neither (gist doesn't set ETag at all; cortex is key-value, no GCS object). GCS ETag source decision is new ground.
- Root `go.mod`: confirms `cloud.google.com/go/storage v1.62.1` — `ObjectAttrs.Etag` field available.
- Reviewed GCS Go client docs for `ObjectAttrs`: `Etag` field is the base64-encoded MD5 of object content, already formatted as a valid HTTP ETag string. `Generation` is a monotonically increasing int64 version counter.

---

## Issues Raised and Resolved

### Issue 1 — ETag source: generation number vs GCS-provided ETag ✅ RESOLVED

**Finding:** The v2 plan listed `ETag: (GCS generation number, formatted as "<generation>")` in the response headers table. The generation number is a version counter, not a content fingerprint. Using it as an ETag is technically valid but semantically wrong: if an object is re-uploaded with identical content, the ETag changes (generation increments) even though the content is the same — CDN `If-None-Match` validation would unnecessarily revalidate.

GCS provides `storage.ObjectAttrs.Etag` as a base64-encoded MD5 of the object content. This is already a valid HTTP ETag string requiring no further formatting.

**Decision:** Use `storage.ObjectAttrs.Etag` directly. Content-based ETag is correct per HTTP semantics. No formatting needed — the field is already a valid ETag string.

**Alternatives considered:**
- B: Keep generation-based ETag (`"<generation>"`) — rejected (version-identity breaks CDN cache validation for identical re-uploads; adds unnecessary format wrapping)
- C: Compute MD5 on-the-fly during streaming — rejected (requires buffering or two-pass read, defeats no-memory-buffering design goal)

**Impact on v3:** Added "ETag source" section explaining content-identity vs version-identity and the correct `attrs.Etag` field. Updated response headers table ETag row. Updated `StorageClient` module boundary to note `ObjectMeta.ETag` is already a valid HTTP ETag string. Updated Testing Decisions to note `fakeStorage` should return realistic base64-MD5 format strings in `ObjectMeta`.

---

### Issue 2 — Graceful shutdown vs in-flight large downloads ✅ RESOLVED

**Finding:** The v2 plan stated graceful shutdown with a 30-second drain. `http.Server.Shutdown()` waits for active connections, but the drain context expires after 30 seconds and kills connections still sending response bodies. A 1 GB download in progress during a pod replacement will be dropped mid-transfer after 30 seconds.

The v2 plan mentioned this was the standard 30-second drain but did not explain the operational consequence or why it was acceptable.

**Decision:** Keep the 30-second drain. Document explicitly that:
1. The installer's `download.rs` already sends `Range: bytes={received}-` on reconnect and handles `206 Partial Content` — mid-transfer pod replacement is handled seamlessly by the installer.
2. The user loses at most a few seconds of transfer progress (bytes in-flight at kill time), not the full download.
3. Extending the drain timeout to accommodate the longest possible download (10–30 min) would make deployments unpredictable and slow under load.

**Alternatives considered:**
- B: Extend drain timeout to 30 minutes — rejected (unpredictable deployment time; Kubernetes rolling updates would stall; no benefit since installer resumes anyway)
- C: Signal active download connections to reconnect before shutdown (custom `Connection: close` or SSE drain message) — rejected (unnecessary complexity for a proxy; the range-resume path already handles this cleanly)

**Impact on v3:** Added "Graceful shutdown and in-flight downloads" section documenting 30s drain behaviour, why it is intentional and safe, and the installer's range-resume behaviour. Updated user story #10 to say "in-flight small requests complete" (not misleadingly implying large downloads complete within the window). Added "Extended shutdown drain for large downloads" to Out of Scope.

---

## Additional Observations (Not Raised With User)

- **`STORAGE_EMULATOR_HOST` local dev path**: GCS client checks this env var automatically — no code change needed to point at a local emulator. Added to Further Notes in v3 under GCS access section.
- **`ObjectMeta.ETag` format in tests**: The `fakeStorage` in handler tests should return a realistic base64-MD5 string (e.g. `"d41d8cd98f00b204e9800998ecf8427e"`) rather than a placeholder like `"etag-123"` to confirm the handler passes it through unmodified. Added to Testing Decisions in v3.
- **GCS generation not used anywhere**: Neither cortex nor gist uses the generation number in HTTP responses. The v2 ETag specification was inconsistent with existing codebase practice (which sets no ETag from GCS) as well as HTTP best practice. The v3 correction aligns with both.

---

## Unresolved Questions

None — all issues were resolved with explicit user decisions.
