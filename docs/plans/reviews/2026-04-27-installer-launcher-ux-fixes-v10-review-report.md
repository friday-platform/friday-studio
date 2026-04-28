# Review report: 2026-04-27-installer-launcher-ux-fixes (v10)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v11.md`

## Summary

v10 closed all four gaps from the v9 review. v11 picks up three
narrower spec-tightenings the prior reviews missed — one real spec
gap (HTTP shutdown response handling), one decision refinement
(probe path for auth-walled services), one cleanup completeness
fix (`.bak` orphan).

A fourth candidate — a layout-version marker file at
`~/.friday/local/.layout-version` to make future migrations easier
— was rejected by the user. Rationale: "no backwards compatibility
needed, nobody is using this yet". Recorded here so future review
passes don't re-raise it.

## Three new ideas, all baked in

### 1. HTTP shutdown POST: response-handling semantics table

v10 said "Try `POST /api/launcher-shutdown` first; fall back to
SIGTERM-and-poll" — but never specified which HTTP outcomes
trigger fallback. The implementer is left to invent a policy. Two
implementers will pick two different policies; one will be subtly
wrong (e.g. waiting 35s on a 500 response, or falling through on
a 409).

**Fix in v11:** the cross-cutting § now contains a response →
action table:

| HTTP outcome | Caller action |
|--------------|---------------|
| connection refused / EOF before headers | Fall through to SIGTERM |
| 202 Accepted | Poll `launcher.pid` for removal up to 35s |
| 409 Conflict | Same as 202 (already shutting down — wait it out) |
| 4xx other | Log + fall through to SIGTERM |
| 5xx | Log + fall through to SIGTERM |
| Read timeout (>5s for POST itself) | Cancel + fall through to SIGTERM |

Issue 6's flow-text and §Files-to-change references are updated
to point at the table rather than re-paraphrase the policy. Test
matrix gains a unit test that drives a mock server through each
row.

### 2. Decision #32 caveat for auth-walled probe paths

v10 said probes target user-facing paths, not sidecar `/health`.
Today playground's `/` is a public landing page, so this works.
But the contract breaks the moment a future service has auth on
`/`: `/` returns 302/401, never 200, never `healthy`. Implementers
might be tempted to revert to `/health` — re-introducing the bug
v10 was fixing.

**Fix in v11:** Decision #32 refined. The principle is "probe
exercises the real handler stack at a publicly-reachable path".
For services with auth-walled root paths, probe a *different*
publicly-reachable path that still drives the real router (login
page, public landing, public version endpoint) — NOT a sidecar.
The same handler stack must be exercised; the path just needs to
be reachable.

Cross-cutting state-machine doc + CLAUDE.md additions updated to
match.

### 3. Pre-extract cleanup also wipes `Friday Studio.app.bak`

v10's Decision #31 wipes `bin.new/` and `Friday Studio.app.new`
at the start of extract. But migration step 6 ALSO creates
`Friday Studio.app.bak` (renaming the live `.app` aside before
the swap); step 7 normally removes it. A crash between step 6 and
step 7 leaves a stale `.bak`. Spotlight indexes both paths;
`Cmd+Space → "Friday"` returns two results; the user can launch
either.

**Fix in v11:** Decision #31 extended. Pre-extract cleanup now
wipes all three paths in one block:

```rust
let _ = fs::remove_dir_all("/Applications/Friday Studio.app.new");
let _ = fs::remove_dir_all("/Applications/Friday Studio.app.bak");
let _ = fs::remove_dir_all(home.join(".friday/local/bin.new"));
```

Migration step 4 inline matches. New negative test in §Test
before shipping seeds a `.bak` orphan and asserts post-install
state has exactly one `.app` per `mdfind`.

## Issues considered and discarded

### "Layout-version marker file at `~/.friday/local/.layout-version`"

**User decision:** rejected. "No backwards compatibility needed,
nobody is using this yet."

Recorded for future review passes: a `.layout-version` file would
let future migrations skip Mach-O sniffing and read the layout
version directly. Strong forward-looking improvement — but not
this product's problem, since the fleet is one user (lcf) who
will see exactly one migration (v0.0.8 → v0.0.9) and never
another fragile detection step. Future review passes that re-
raise this should be reminded of the user's constraint.

### "License URL retry/backoff for CI flakiness"

Considered: CI builds occasionally hit transient 503s from
GitHub raw URLs. Adding 3 retries with exponential backoff in
`scripts/build-studio.ts` would harden against this.

Rejected: implementation hygiene, not a design decision. Any Go
or Node developer will reach for `axios-retry` or equivalent
once they hit a flaky build. Not worth a v11 decision.

### "Build-time assertion: Info.plist's CFBundleExecutable matches binary name"

Considered: if the .app bundle's Info.plist `CFBundleExecutable`
field drifts from the actual binary filename inside
`Contents/MacOS/`, `open -a` fails with "the application can't
be opened". A build-time assertion (e.g. parse the Info.plist,
list `Contents/MacOS/`, compare) would catch this before
shipping.

Discarded as a v11-pass change because: (a) it's an
implementation detail, the build script is already responsible
for producing both files, (b) the smoke test "open -a 'Friday
Studio'" on the build artifact catches it post-hoc, and (c) the
CI pipeline already runs codesign --deep which fails if the
binary doesn't exist at the path Info.plist points at.

If the implementer hits this in practice, it surfaces as a
v12+ clarification. Premature spec.

### "Add `Restart all` test that asserts SSE event ordering"

Considered: the plan claims SSE subscribers see
`healthy → starting → healthy` during a `Restart all`. A test
could connect a mock SSE consumer, trigger restart-all, and
assert event sequence.

Rejected: marginal value for this product. The contract is
documented; the test would be slow (involves real process
restart) and brittle to scheduler timing.

### "SO_REUSEADDR on the launcher's port 5199 listener"

Considered: during update flow, the old launcher's port 5199
listener might linger in TIME_WAIT briefly after process exit;
the new launcher's bind would race against it. Setting
SO_REUSEADDR avoids the race.

Discarded: Go's `net.Listen("tcp", ...)` on Linux/macOS
defaults to setting SO_REUSEADDR via the `tcp` network type
internally. On Windows the behavior differs but the launcher
spawns serially (old must exit before new bind). Not a real
race in practice.

## Unresolved questions

None. v11 is implementation-ready.

Verification items carried forward (all have documented
fallbacks if they fail):

1. Spotlight + LSUIElement on macOS Sonoma+
2. EventSource on Windows WebView2
3. codesign --deep on the .app bundle
4. osascript availability under MDM-restricted macOS
5. xattr -dr behavior on signed .apps
6. LICENSE file presence in pinned third-party releases
7. `open -a` autostart end-to-end at boot (v9)
8. Pinned GitHub raw URL availability (v9)
9. Migration negative-path: extract failure recovery (v9)
10. Crash-recovery negative test (v10)
11. Playground probe path matches browser load (v10)

No new verification items in v11 — all three fixes are unit-
testable in CI without test-hardware verification.

## Overlap with v10

v11 keeps unchanged from v10:
- TLDR section structure (with v11 changelog header noting
  what changed; v10 changelog rolled into the "all v10
  decisions roll forward" line)
- All six problem statements
- All eight goals + four non-goals
- Cross-cutting `/api/launcher-health` endpoint surface — only
  addition is the §Caller response-handling table
- Service status state machine (one paragraph adjusted to
  reference Decision #32's auth-walled caveat)
- Issue 1+2+3 wizard rewrite (unchanged)
- Issue 4 tray fix (unchanged)
- Issue 5 .app bundling, /Applications-only with admin elevation,
  binDir resolution, pre-flight (unchanged)
- Issue 6 Quit/uninstall sweep semantics (flow-text adjusted to
  reference response table; semantics unchanged)
- Build sequence (unchanged; v0.1.16 still ships first)
- Stack 1/2/3 split + recommended order (unchanged)

v11 changes from v10:
- Cross-cutting §: new §Caller response-handling table
- State-machine doc: probe-path note refined for auth-walled
  services
- Migration §: step 4 also wipes `.app.bak`; new negative test
  for `.bak` orphan recovery
- §Issue 6 step 5 + step 6: prose updated to reference response
  table
- §CLAUDE.md additions: probe-path bullet refined for auth-
  walled services
- Test matrix: new row for response-table unit tests; existing
  pre-extract-cleanup row extended to include `.bak` fixture
- Decisions: #31 extended (`.bak` cleanup), #32 refined (auth-
  walled caveat). No new decision numbers added.
- TLDR counts unchanged (32 decisions, 14 risks, 9 verif items)

## Recommendation

**Stop reviewing the plan; start writing the code.** v11 is the
last useful /improving-plans output. Nine prior review passes +
v11's three spec-tightenings closed all the platform-parity,
failure-mode, and implementer-ambiguity edges that survived.
Stack 1 (launcher HTTP server + Issue 6) still ships the highest-
confidence fix with the smallest blast radius; implementation
should start there.
