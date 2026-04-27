# Review report — webhook-tunnel-go-rewrite-design v4

**Date:** 2026-04-26
**Reviewer:** Claude (self-review via /improving-plans)
**Plan reviewed:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v4.md`
**Output plan:** **None — no v5 produced.** See "Decision" below.

---

## Decision

**v4 is ready for implementation. No v5 was produced.**

The skill's explicit guidance: "You do not NEED to come up with 5
ideas. Do not try to gold plate the plan." Three prior review cycles
(v1→v2, v2→v3, v3→v4) surfaced and resolved every meaningful design
gap. A fresh fourth-pass read found no genuinely new architectural,
correctness, or contract-shape issue worth raising. The remaining
candidates are all implementation details that the implementer will
recognize and resolve naturally on first contact.

Producing a v5 in this state would either be a verbatim copy of v4 (a
no-op that obscures the actual stability of the document) or include
gold-plated micro-edits (which adds churn without value). Neither is
the right output.

The deliverable for this review cycle is this report, concluding the
review chain.

## Findings investigated and discarded

These items were considered on a fresh pass and discarded. They are
documented here so a future reviewer can confirm they were considered
rather than missed.

### `/health` JSON shape isn't pinned with a contract test (only `/status` is)

`/health` returns `{ status: "ok" | "degraded", service: "webhook-tunnel",
tunnelAlive: boolean }` — a 3-field response with a discriminated string.
v4's testing section actually does mention "Same shape of contract test
for `/health`" in passing under the `/status` test bullet. The
implementer will see this. Not worth elevating to a separate explicit
spec.

### `forwarder.ProxyHandler(provider) → http.Handler` is over-parameterized

The `/platform/:provider/:suffix?` route is one mux entry that dispatches
on the URL parameter — one handler per binary lifecycle, not one per
provider. The interface in v4 takes a `provider` arg as if it were
per-provider. The implementer will hit this immediately when wiring the
route and either (a) drop the arg, or (b) realize there's no benefit to
caching per-provider proxies. Either way it's a 30-second decision at
implementation time, not a design-doc concern.

### "All 4 targets" reference in commit 1's verify step is stale

The studio build matrix is currently 3 targets (macOS-intel was disabled
in earlier work). v4 says "launcher binary builds for all 4 targets" in
the verify checklist. Cosmetic doc inaccuracy. Doesn't affect
implementation — the implementer will look at `scripts/build-studio.ts`
for the actual matrix.

### Paired-kv `kv ...any` loses TS `LogContext` schema enforcement

TypeScript's `@atlas/logger` exposes a `LogContext` interface with
known fields (`workspaceId`, `sessionId`, `agentId`, etc.) that the
TypeScript compiler can autocomplete and warn on. The Go wrapper's
paired-kv signature accepts any string as a key — no schema enforcement,
no autocomplete. This is a fundamental difference in how the two
languages express structured context, not a fixable design gap. v3
review (logger choice question) already settled paired-kv as the right
trade.

### `crypto/rand` may block at very early system boot

Real corner case on Linux systems where the entropy pool isn't yet
seeded. Webhook-tunnel runs inside an interactive user session (via the
launcher), not at system boot, so the entropy pool is well-seeded by
the time it starts. Non-issue in practice.

### Tier-1 "sibling of own binary path" doesn't address symlinks

`os.Executable()` resolves symlinks. If a dev symlinks the binary into
`~/bin`, sibling discovery looks at the real install location, not the
symlink dir. The 3 fallback tiers (PATH, `~/.atlas/bin`, in-Go download)
cover this. No design change needed.

### Plan has 28 user stories — some are duplicative

User stories #15 ("one logger library across every Go binary") and #25
("stable pkg/logger API") are the same idea from different angles.
Cosmetic redundancy. Some implementers like the redundancy because each
phrasing helps a different reader.

### `WEBHOOK_MAPPINGS_PATH` malformed-file behavior unspecified

Should fail-fast at startup with a clear error. Implementation detail,
not a design decision. Same for `ATLAS_LOG_LEVEL` invalid value
handling.

## What changed across the four review cycles

For posterity, the design progression:

- **v1 → v2:** Multi-PR phasing dropped (declaw-only). HMAC body-once
  contract pinned via byte-slice signature. `/status` 7-field contract
  locked with test. Cloudflared in-Go download fallback added.
  build-studio.ts dead-code cleanup made explicit.
- **v2 → v3:** `pkg/logger` (slog wrapper) added with launcher +
  pty-server migration. 25 MB body cap via `http.MaxBytesReader`.
  `/platform` proxy switched to `httputil.ReverseProxy` (fixes RFC 7230
  hop-by-hop bug). Cloudflared SHA-256 verification via official
  sidecar fetch (zero-maintenance). 25 s graceful shutdown deadline.
- **v3 → v4:** Cloudflared download made atomic
  (`tmp.<pid> → fsync → verify → rename`). Logger API rationale
  documented (slog idiom paired-kv). Reconnect-cap policy made explicit
  in Out-of-Scope.

## Unresolved questions

None.

## Notes for any future review of this plan

- **Don't run another /improving-plans cycle on this document.** The
  cycle has run to completion. If implementation surfaces a real issue,
  fix the implementation; don't iterate the design doc unless the
  problem is genuinely architectural.
- **Don't re-ask anything in the v1, v2, v3, or v4 review reports' "do
  not re-ask" lists.** Specifically: multi-PR phasing, HMAC body-once,
  /status field count, cloudflared dev-machine UX, pkg/logger
  introduction, body size limit, hop-by-hop header handling, SHA-256
  sidecar fetch, graceful shutdown deadline, embedding cloudflared as
  a library, cloudflared download atomicity, logger API shape, reconnect
  cap.
- **If the implementer wants to deviate from v4 on something specific,
  that's fine — code beats spec.** Update the doc *after* the deviation
  is committed so the doc tracks reality, not the other way around.
