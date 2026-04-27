# Review report — webhook-tunnel-go-rewrite-design v2

**Date:** 2026-04-26
**Reviewer:** Claude (self-review via /improving-plans)
**Plan reviewed:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v2.md`
**Output plan:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v3.md`

---

## Summary

v2 was already a strong plan. v3 changes are additive — four real gaps
surfaced in the second review, all related to runtime behavior the v1 +
v2 reviews didn't probe. The biggest addition is a new shared
`pkg/logger` package that fixes a pre-existing inconsistency (launcher
on zerolog, pty-server on slog) by introducing a thin Go wrapper that
mirrors the TS `@atlas/logger` shape, with mechanical migration of the
two existing Go binaries baked into the same commit stack.

## Findings

### 1. Logger inconsistency across Go binaries

**Severity:** Cleanliness / consistency

**Where in v2:** Not addressed. v2 specified the four new internal
sub-packages (tunnel/provider/forwarder/cloudflared/passphrase) but said
nothing about which logger webhook-tunnel would use.

**Why it matters:** Verified by grep — launcher uses `github.com/rs/
zerolog` (`tools/friday-launcher/main.go`), pty-server uses stdlib
`log/slog` (`tools/pty-server/main.go`). Both write to the same
`~/.friday/local/logs/` directory via process-compose stderr capture.
Two log shapes in one place makes log-aggregation tooling harder and
gives every new Go binary author a coin-flip choice. Webhook-tunnel
would be the third Go binary; without a decision, it'd compound the
problem.

**Resolution in v3:** New `pkg/logger` package added as commit 3 in the
stack. Wraps `log/slog` (stdlib substrate, no extra dep) with an API
that mirrors the TS `@atlas/logger` shape (level methods + `Child(kv...)`).
Launcher and pty-server are migrated to it in the same commit, removing
`rs/zerolog` from `go.mod`. Webhook-tunnel uses it from day one. New
module-boundary section documents what the package hides and the trust
contract. New user stories #14 and #24 cover the dev-side benefit.
Out-of-Scope explicitly forbids overgrowth (no rotation, no remote
shipping — process-compose handles capture).

### 2. No body size limit — small but real DoS gap

**Severity:** Production hardening

**Where in v2:** Not addressed. The Hono TS code has no body limit
either; `io.ReadAll(req.Body)` in Go also has none.

**Why it matters:** A malicious or buggy caller could POST an arbitrarily
large body to `/hook/...` or `/platform/...` and OOM the binary. Webhook
providers in practice cap their payloads (GitHub at 25 MB, most others
at 1–5 MB), so a real cap is straightforward.

**Resolution in v3:** New user story #10. New "Body size cap: 25 MB"
architectural decision. Tests section adds an explicit body-size cap
test. Implementation: `http.MaxBytesReader` wrapping the body on the
two webhook routes. Returns 413 before any handler runs.

### 3. /platform proxy hop-by-hop header bug exists in TS, fix it for free

**Severity:** Correctness / RFC compliance

**Where in v2:** Forwarder boundary said it strips Host, Content-Length,
"hop-by-hop headers per RFC 7230" — but only mentioned this in the
"hides" section without specifying the implementation.

**Why it matters:** Verified — current TS only strips `host` and
`content-length` (`apps/webhook-tunnel/src/routes.ts:48-50`). RFC 7230
hop-by-hop list (`Connection`, `Keep-Alive`, `Proxy-*`, `TE`, `Trailers`,
`Transfer-Encoding`, `Upgrade`) is not stripped. Most webhook providers
don't send these so the bug hides — but a faithful 1:1 port would
preserve the bug, while a tiny implementation choice (use
`httputil.ReverseProxy` instead of hand-rolled forward) fixes it for
free.

**Resolution in v3:** Architectural decision pinned: `/platform` proxy
uses `httputil.NewSingleHostReverseProxy` with a custom Director. This
fixes the latent TS bug as a side effect. Forwarder boundary updated to
return `http.Handler` per provider rather than imperative method calls.
User story #7 expanded to call out the RFC 7230 fix. Tests section adds
an explicit hop-by-hop stripping test (request with
`Connection: keep-alive` + `Transfer-Encoding: chunked`; mock asserts
neither header arrives).

### 4. SHA-256 pinning was unnecessarily brittle; use upstream sidecar

**Severity:** Maintenance friction

**Where in v2:** "Pinned hash table embedded in the binary (one entry
per supported platform per pinned cloudflared version)."

**Why it matters:** Every cloudflared version bump = a code change in
webhook-tunnel and a rebuild of every studio binary, with hashes
copy-pasted from cloudflared's release page. Easy to get wrong, easy
to forget. Cloudflared publishes per-asset `.sha256` sidecar files on
the same GitHub release page; downloading the sidecar alongside the
binary and comparing is zero-maintenance and uses the same trust chain
(github.com release hosting via TLS) that we already trust for the
binary itself.

**Resolution in v3:** "In-Go HTTPS fallback download" tier 4 now
fetches the official `.sha256` sidecar from the same release at download
time. The pinned cloudflared *version* is one constant; the per-platform
hashes are not maintained in our codebase. User story #27 updated to
reflect the trust model. `cloudflared` package boundary updated. Tests
updated to verify sidecar-mismatch rejection.

### 5. Graceful shutdown deadline was unspecified

**Severity:** Correctness / matches TS behavior

**Where in v2:** Not addressed.

**Why it matters:** TS code has a hard 25-second `setTimeout` in
`index.ts:92` that force-exits if shutdown doesn't complete. Without
an explicit Go equivalent, an implementer might leave shutdown
unbounded, and a stuck cloudflared could hold the launcher's stop-loop
past its 30-second `ShutDownTimeout` — surfaced as launcher-side
SIGKILL noise.

**Resolution in v3:** New user story #21 specifies the 25 s drain.
New "Graceful shutdown deadline" architectural decision pins the
implementation: HTTP server `Shutdown(ctx)` with a 25 s context;
cloudflared subprocess via `processkit.Kill` with 20 s grace then
SIGKILL; force-exit if any goroutine doesn't return within 25 s total.

## Discarded ideas (low value, not worth a v3 change)

- **CORS exposure of `secret` field on `/status`.** Wide-open
  `cors({ origin: "*" })` returns the webhook signing secret to any
  origin via fetch. The exposure is fine because the playground is a
  same-machine dev tool and the secret only authenticates outbound
  webhook callers (anyone on the same machine can read the binary anyway).
  Worth no action.
- **Nested restart loop risk** — launcher restarts webhook-tunnel up to
  5x with 2s backoff; webhook-tunnel reconnects cloudflared with 1s→30s
  exponential. If cloudflared keeps failing AND webhook-tunnel itself
  crashes from those failures, the loops could compound. In practice
  cloudflared failures don't crash webhook-tunnel (subprocess isolation
  was the whole point), so this is theoretical. No action.
- **`/health` returns 200 with `status: degraded` even when tunnel is
  dead.** Launcher's HTTP probe accepts any 200 as healthy. This is
  correct behavior — the HTTP server IS up; only the downstream is dead.
  If we wanted "tunnel-dead = unhealthy" semantics it'd require coordinated
  changes in the launcher's probe config. Out of scope.
- **First-install with no `$HOME` (some Windows configurations).**
  `~/.atlas/bin/` assumes a writable home dir. On a misconfigured Windows
  user profile this could fail. Real but rare; the discovery error
  message is clear enough that the user can set `HOME` or
  `USERPROFILE` and retry. No design change.
- **Test fixtures live where?** Implementation detail. Inline `[]byte`
  literals in test files matches both the TS prior art and pty-server's
  pattern. No design change.

## Unresolved questions

None remaining. All four AskUserQuestion choices answered. Logger choice
(`@atlas/logger`-style wrapper) implies a new `pkg/logger` package and
migration of two existing binaries — both baked into v3 explicitly.

## Notes for future reviews of this plan

- The plan is now fully concrete. v4 should focus on issues surfaced
  during implementation, not on speculative additions.
- Don't re-ask about logger choice — the wrapper exists, period.
- Don't re-ask about body size limit — 25 MB.
- Don't re-ask about `/platform` proxy correctness — uses
  `httputil.ReverseProxy`.
- Don't re-ask about cloudflared SHA-256 verification — sidecar fetch.
- Don't re-ask about graceful shutdown — 25 seconds.
- Don't re-ask about embedding cloudflared as a library — settled in v1.
- Don't re-ask about multi-PR phasing — declaw-only, settled in v1.
