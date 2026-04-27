# Review report — webhook-tunnel-go-rewrite-design v1

**Date:** 2026-04-26
**Reviewer:** Claude (self-review via /improving-plans)
**Plan reviewed:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.md`
**Output plan:** `docs/plans/2026-04-26-webhook-tunnel-go-rewrite-design.v2.md`

---

## Summary

v1 was structurally sound — module boundaries are correct, scope (faithful
1:1 port) is well-justified, and the cloudflared-subprocess-not-library
decision is backed by real evidence. Five gaps were identified and
addressed in v2. The biggest correction was process-shaped, not
technical: v1 proposed splitting work into three PRs, which violates the
project's declaw-only commit policy that had already been stated twice.

## Findings

### 1. Multi-PR phasing violates declaw-only policy

**Severity:** Process / project-policy violation

**Where in v1:** "Updated 3-PR plan" header and the Phase 1 / 2 / 3 sub-
sections framed each phase as a separate PR.

**Why it matters:** The user has been explicit (twice) that all atlas
work goes on the `declaw` branch as a stack of commits, not as separate
PRs. Proposing a multi-PR plan is a re-violation of an established rule.

**Resolution in v2:** Replaced the 3-PR framing with a "Commit ordering
on `declaw`" section that lists the three logical commits in order. Each
commit still has a clean responsibility and is bisect-friendly, but
there's no PR-per-phase implication. Memory file
`feedback_atlas_branch_declaw.md` was strengthened to explicitly forbid
proposing multi-PR plans.

### 2. HMAC body re-read is a real Go-vs-Hono trap

**Severity:** Implementation correctness

**Where in v1:** Implicit. The `provider` module boundary said it takes
"raw HTTP request" with no mention of body-handling semantics.

**Why it matters:** The current TS code calls `c.req.text()` in verify
(for HMAC over raw bytes) and `c.req.json()` in transform (for parsing).
Hono's request abstraction transparently buffers, so both calls succeed
on the same request. Go's `net/http` does NOT buffer — `req.Body` is a
one-shot stream. A naive port that translates "verify reads body, then
transform reads body" line-for-line into Go would have the second read
return EOF, and the failure mode is silent: HMAC succeeds, JSON parse
returns empty, the transform produces a meaningless payload.

**Resolution in v2:** The `provider.Handler` interface now takes
`(headers, body []byte)` rather than `*http.Request`. The route handler
is documented to read the body once, HMAC it, then `json.Unmarshal` from
the same bytes. The byte-slice signature pins the contract — there is
no API path through which a handler can accidentally re-read. Added a
"Further Notes" item warning about the chunked-transfer subtlety
(streaming the body to HMAC in parallel with parsing re-introduces the
problem in a subtler form).

### 3. `/status` JSON shape is a public contract; v1 didn't lock it

**Severity:** Risk of breaking the playground silently

**Where in v1:** Out-of-Scope mentioned "preserves the JSON response
shape exactly" but the testing section had no contract test.

**Why it matters:** Verified by grep that the agent-playground
(`tools/agent-playground/src/lib/components/workspace/signal-row.svelte:152`)
fetches `/status` and reads `data.url` + `data.secret`. Other consumers
(CLI tools, ops runbooks) might exist that I can't verify exhaustively.
The TS version exposes 7 fields in `/status` (url, secret, providers,
pattern, active, tunnelAlive, restartCount, lastProbeAt). A faithful
port should preserve all 7, and that contract should be enforced by a
test that trips CI before a field rename or addition can ship.

**Resolution in v2:** New user story #8 calls out the 7-field contract.
Implementation Decisions note the contract explicitly. Testing Decisions
add a "Contract test for `/status` JSON shape" that asserts the exact
field set and types.

### 4. cloudflared dev UX regresses without npm-install fallback

**Severity:** Dev-experience regression

**Where in v1:** "Cloudflared discovery order" stopped at three tiers
(sibling, $PATH, /opt/homebrew, /usr/local/bin) with the comment "the
npm-install fallback from the TS version is dropped — studio bundles
ship cloudflared, dev devs install via Homebrew."

**Why it matters:** "Dev devs install via Homebrew" assumes every atlas
contributor has cloudflared. They don't — the npm `cloudflared` package
auto-installs the binary to `node_modules/.bin/cloudflared` on first use,
which means new contributors get the dev experience for free. Dropping
that means a new contributor's first `deno task dev` of the platform
silently fails to start a tunnel, and the error is "cloudflared not
found in PATH" with no remediation hint inline.

**Resolution in v2:** Added a fourth discovery tier: an in-Go HTTPS
download fallback to `~/.atlas/bin/cloudflared` triggered only when none
of sibling/$PATH/Homebrew succeed. SHA-256 verification against a pinned
hash table embedded in the binary (one entry per supported platform per
pinned cloudflared version). Concurrent-call coalescing so two
goroutines on a missing-binary machine don't both fire the download.
Added a new internal `cloudflared` package in the module boundaries
section with its own trust contract. Added user story #23 for the
checksum verification. Added cloudflared package tests in Testing
Decisions.

### 5. `compileGo()` dead-code cleanup not explicitly called out

**Severity:** Cleanup hygiene

**Where in v1:** Phase 1 said "Update `scripts/build-studio.ts`
`compileGo()` so the launcher entry builds the same way pty-server does"
but didn't explicitly say to delete the `hasOwnModule` branch (lines
292–316 of build-studio.ts) that special-cased the launcher's separate
`go.mod`.

**Why it matters:** Without explicit removal direction, the implementer
might leave the dead branch "just in case" — which lingers as dead code
in a build script that's already getting hard to read.

**Resolution in v2:** First commit's bullet list explicitly says "delete
the `hasOwnModule` branch that special-cased the launcher's separate
`go.mod`. Both code paths now collapse to 'build from repo root with the
package import path'."

## Discarded ideas (low value, not worth a v2 change)

- **`creack/pty` v1.1.21 → v1.1.24 risk audit.** v1 already covered this
  with "API stable; root callers verified" — no action needed beyond what
  v1 said.
- **`go mod tidy` from root pulls in 80 indirect deps from process-compose.**
  v1 noted this in passing. The cosmetic concern (longer `go.mod` file)
  doesn't outweigh the structural benefit (single module, single test
  command, free shared imports).
- **CGO build flag handling per binary.** Verified that
  `scripts/build-studio.ts` already has per-binary `cgo:true` opt-in via
  the `GoBinary` interface (line 137). Mixed CGO requirements across
  binaries in one module is the existing pattern (pty-server is CGO=0,
  launcher is CGO=1). No design change needed.
- **Provider config migration path for ops users with custom YAML.** v1
  already documented `WEBHOOK_MAPPINGS_PATH` env var as the override
  mechanism — fully backward-compatible.

## Unresolved questions

None remaining. All four AskUserQuestion choices got user answers. The
fifth idea (build-studio dead-code cleanup) was baked in directly without
asking because the right call was unambiguous.

## Notes for future reviews of this plan

- The plan is now fully concrete. v3 should focus on issues surfaced
  during implementation (e.g. unexpected dep conflicts during
  consolidation, unexpected cloudflared log-format edge cases), not on
  speculative additions.
- Don't re-ask about multi-PR phasing. The declaw-only rule is fixed.
- Don't re-ask about /status field count — locked at 7 with a contract
  test.
- Don't re-ask about embedding cloudflared as a library — decision and
  reasoning are documented; revisiting would be re-litigating settled
  ground.
