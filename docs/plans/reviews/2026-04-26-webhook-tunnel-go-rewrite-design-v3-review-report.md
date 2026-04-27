# Review report — webhook-tunnel-go-rewrite-design v3

**Date:** 2026-04-26
**Reviewer:** Claude (self-review via /improving-plans)
**Plan reviewed:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v3.md`
**Output plan:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v4.md`

---

## Summary

v3 is mature. This review found two genuinely new issues — one
correctness gap (cloudflared download atomicity) and one ergonomic
design choice (logger API shape) — and explicitly held the line on
gold-plating. v4 is therefore a focused, small delta from v3.

The skill explicitly says "you do not NEED to come up with 5 ideas. Do
not try to gold plate." Honored. Several plausible findings were
investigated and discarded; see "Discarded ideas" below.

## Findings

### 1. Cloudflared download is not specified as atomic — partial-write hazard

**Severity:** Correctness gap

**Where in v3:** "Cache for next run" in the cloudflared discovery tier 4
description. Implementation detail unspecified.

**Why it matters:** The download path is `~/.atlas/bin/cloudflared`. If
the download is interrupted (network drop, SIGTERM mid-write), the next
`Resolve()` call hits tier 3 (`~/.atlas/bin/cloudflared` exists), takes
the partial file as cached, and `exec.Command` fails with a confusing
`exec format error`. The user then has to know to manually delete the
cached file. Cheap to prevent: download to a `.tmp` path, fsync, verify
sha256, then `os.Rename` to the final path. Standard Unix atomic-write
pattern.

**Resolution in v4:**
- New architectural decision "Cloudflared download is atomic" pinning
  the `tmp.<pid> → fsync → verify → rename` protocol with cleanup-on-
  failure, plus the executable-bit set before rename, plus the
  Windows-renamed-on-same-volume case.
- New user story #10 covers the user-facing requirement.
- `cloudflared` module-boundary "Hides" updated to include the atomic-
  write protocol.
- `cloudflared` module-boundary "Trust contract" tightened: caller
  receives a binary that is "fully written, executable bit set, and
  sha256-verified before `Resolve` returns."
- Testing Decisions add an interrupted-download recovery test:
  start a download against a server that closes the connection
  mid-body, assert the `.tmp` file is removed and the final path is
  untouched, then re-run `Resolve` against a working server and assert
  success.
- Further Notes adds the PID-suffix-on-tmp rationale (prevents
  collisions between simultaneous webhook-tunnel processes — `deno task
  dev` + launcher-installed binary on a dev box).

### 2. Logger API shape — paired-kv (slog idiom) confirmed

**Severity:** Design clarity

**Where in v3:** `pkg/logger` interface specified as
`Trace/Debug/Info/Warn/Error/Fatal(msg string, kv ...any)` and
`Child(kv ...any) *Logger`. The shape is correct (paired-kv, slog
idiom) but the rationale wasn't documented and a future reviewer might
misread "mirrors `@atlas/logger` shape" as meaning "takes a context
map" (which is the TS shape).

**Why it matters:** Affects every Go log line in every Go binary going
forward. Wrong choice now is hard to undo. The user explicitly chose
paired-kv on review. Without the rationale captured in-plan, the v4 is
the same as v3 on the surface but the next reviewer might re-litigate.

**Resolution in v4:** `pkg/logger` interface section now explicitly
calls out: "`kv ...any` is the slog idiom — paired key/value variadic
args (`logger.Info("webhook received", "provider", name, "workspace",
id)`) rather than a context-map type. Approximate symmetry with the TS
`@atlas/logger` shape (both add structured fields) but with the
idiomatic Go syntax that gets autocomplete and zero per-call
allocations." The next reviewer reads this and doesn't re-ask.

### 3. (Bonus, no question asked) Reconnect-cap policy made explicit

The TS code has no max-attempt cap on the cloudflared runtime reconnect
loop (only on initial-connect retries). v3 implicitly preserved this via
"faithful 1:1 port" but the absence of a cap might look like an
oversight to a future reviewer. v4 Out-of-Scope section now explicitly
says "A maximum-attempts cap on the cloudflared reconnect loop. The TS
version has no cap and faithful 1:1 port wins; if the network is
permanently broken, the launcher's `/health` probe still returns 200
(HTTP server is up, only the downstream is dead) so the launcher
doesn't restart-storm webhook-tunnel."

## Discarded ideas (investigated, not worth a v4 change)

- **macOS .app bundle path resolution.** Webhook-tunnel is not bundled
  inside any `.app` (only the Tauri studio installer is). `os.Executable()`
  returns `~/.friday/local/webhook-tunnel`, sibling discovery resolves
  `~/.friday/local/cloudflared` correctly. Verified against
  `apps/studio-installer/src-tauri/tauri.conf.json` — the installer is
  the .app, the supervised binaries are not.
- **Vulnerability-scanner false positives** from `process-compose`'s 80
  transitive deps (gin, swag, tcell, mongo-driver, quic-go, etc.) being
  pulled into root `go.mod`. Verified: no `.github/dependabot.yml`, no
  CodeQL workflow. The repo doesn't run module-level dep scanning today,
  so the noise concern is hypothetical.
- **Logger-migration commit changes log shape AND is in the same commit
  as a feature.** Considered splitting commit 3 into "introduce
  pkg/logger" and "migrate launcher + pty-server" but the second half is
  trivial enough (mechanical translation, ~50 LoC) that splitting adds
  ceremony without bisection benefit.
- **`pkg/logger.Info(msg, F{...})` second-shape support** for users who
  want the TS-style context-map syntax. Adds API surface and a "two
  ways to do the same thing" trap. Slog idiom alone is enough.
- **Config-validation timing at startup.** Implicit in user story #18
  ("override the bundled `webhook-mappings.yml`") and the provider
  package's `loadMappings()` doing schema parsing — failure aborts the
  binary at startup. Not worth a separate decision.
- **`go mod tidy` cache-invalidation cost on first CI run after
  consolidation.** One-time cost of a few minutes. Not worth design-doc
  attention.
- **Sidecar fetch sync vs async during startup.** Tier-4 download
  blocks the tunnel.Manager.Start() call (which is itself called once
  at server boot). HTTP server starts AFTER the tunnel manager — same
  shape as TS. No change needed.

## Unresolved questions

None remaining. Both AskUserQuestion choices answered as recommended.

## Notes for future reviews of this plan

- The plan is now fully concrete enough to start implementation. v5
  should focus on issues surfaced *during* implementation, not on
  speculative additions.
- Don't re-ask about cloudflared download atomicity — settled, atomic
  rename pattern.
- Don't re-ask about logger API shape — settled, paired-kv slog idiom.
- Don't re-ask about reconnect-cap — explicitly out-of-scope.
- Don't re-ask about anything covered in v1 or v2 reviews:
  multi-PR phasing, HMAC body-once, /status field count, cloudflared
  dev-machine UX, pkg/logger introduction, body size limit,
  hop-by-hop header handling, SHA-256 sidecar fetch, graceful shutdown
  deadline, embedding cloudflared as a library.
- If a v5 review surfaces "I think we should reconsider X" where X
  appears in any of the v1/v2/v3 review reports' "don't re-ask" lists,
  that's a signal to read the prior reviews before re-litigating.
