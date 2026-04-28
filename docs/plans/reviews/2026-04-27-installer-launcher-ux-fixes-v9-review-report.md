# Review report: 2026-04-27-installer-launcher-ux-fixes (v9)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v10.md`

## Summary

v9 closed all five gaps from the v8 review (license URLs, port
bind, autostart via `open -a`, staging+swap migration, 20s SSE).
v10 fills four narrower gaps that the v9 design left exposed —
mostly around failure modes the new staging + autostart paths
introduced.

## Four new ideas, all baked in

### 1. Pre-extract cleanup of stale `.new` staging dirs (Decision #31)

v9's Decision #30 (staging-then-swap) covers Rust error paths:
"if extraction fails partway, remove the half-written `.new`
dirs". But it doesn't cover `kill -9`, power loss, OS crash. After
such a crash, `~/.friday/local/bin.new/` and `/Applications/Friday
Studio.app.new` survive on disk. Next installer run could either
collide on `mkdir`-then-write or silently use stale partial
contents.

**Fix in v10 (Decision #31):** insert a defensive
`fs::remove_dir_all` of both staging paths at the *start* of
extraction (new step 4 in the migration sequence; old steps 4-9
become 5-10). Errors ignored — NotFound is the common case;
removing partial content is the only safe action otherwise.
Combined with Decision #30, the only states observable on disk
after any failure are "v0.0.8 layout intact" or "v0.0.9 layout
live" — never a half-written hybrid.

### 2. `open -a "Friday Studio" --args` second-launch arg drop (Decision #29 limitation)

v9's Decision #29 routes autostart through `open -a` with `--args
--no-browser`. Verified in this pass that `open -a` against an
already-running app brings the existing instance to the front via
Apple Events; the `--args` are silently dropped (LaunchServices
behavior, not configurable). At autostart this is fine — the
launcher isn't running yet by definition. But future code that
tries to deliver runtime args via `open -a` will hit a confusing
silent no-op.

**Fix in v10:** documented limitation on Decision #29 + a CLAUDE.md
note. No code change needed (autostart is the only call site).
Future runtime arg delivery should route through the HTTP server
on port 5199.

### 3. License URL interpolation tied to version constants (Decision #27 tightening)

v9's Decision #27 said "pin to the same version tag as the binary"
— an instruction without enforcement. A future maintainer who
bumps `NATS_SERVER_VERSION` could easily forget to update a
manually-typed URL string, shipping mismatched license text.

**Fix in v10:** Decision #27 tightened to require literal
interpolation:

```ts
const LICENSE_URLS = {
  "nats-server":  `https://raw.githubusercontent.com/nats-io/nats-server/v${NATS_SERVER_VERSION}/LICENSE`,
  "cloudflared":  `https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED_VERSION}/LICENSE`,
  "gh":           `https://raw.githubusercontent.com/cli/cli/v${GH_VERSION}/LICENSE`,
} as const;
```

A version bump can no longer drift between binary and license.
Test matrix updated to assert the URL strings literally contain
the substituted version values.

Also moved `LICENSE-CHECKLIST.md` from `bin/` (where it would ship
to users) to `dist/<target>/` (build artifact only — release
auditors need it, users don't).

### 4. Readiness probes target user-facing paths (Decision #32)

v9 said "the wizard enables Open in Browser when every service
reports healthy". A service is `healthy` once its probe returns
200. v9 didn't specify the probe *path*. If playground's probe is
a sidecar `/health` but the browser loads `/`, there's a window
where `/health` is up but `/` 502s — exactly the v0.1.15
connection-refused bug at smaller scale.

**Fix in v10 (Decision #32):** probes target the user-facing path
for each service. Playground probes `/` (root, what the browser
hits). Cost: heavier probe payload than `/health`. At 500ms poll
cadence post-startup that's once per service every 500ms —
acceptable for a dev-machine surface; would be unacceptable for
high-traffic prod, but Friday Studio runs locally for one user.

Cross-cutting state-machine doc updated to reference Decision #32.
Test matrix adds an assertion against `project.go` so a future
refactor can't quietly revert to a sidecar probe.

## Issues considered and discarded

### "Add `--no-browser` and other runtime args via env vars in the plist instead"

Considered: instead of `--args --no-browser`, set
`FRIDAY_NO_BROWSER=1` in the plist's `EnvironmentVariables` and
read the env var in main.go. This bypasses the `open -a` arg-
delivery limitation entirely.

Rejected: the env-var approach works for autostart but doesn't
help the "deliver args to an already-running launcher" case
(env vars are set at process spawn, not delivered at runtime).
HTTP on port 5199 is the right channel for that case. For
autostart specifically, `--args` works fine because the launcher
isn't running yet. The status quo (`--args --no-browser`) is
already correct; the gap was documentation, not design.

### "Add `--launcher-config` flag and read everything from a JSON file"

Considered: replace CLI args entirely with a config file at
`~/.friday/local/launcher.config.json`. Solves the arg-drop
limitation by sidestepping it.

Rejected: massive scope creep for a non-problem. The launcher
takes one CLI flag (`--no-browser`); a whole config-file system
is overkill. Revisit if/when the args list grows past 3.

### "Probe `/` AND `/health` separately, surface both in the API"

Considered: track both readiness probes. The API exposes which
specific check passed. Useful for debugging "playground is up
but the SvelteKit handler isn't bound yet" cases.

Rejected: the wizard only needs one bit ("can the user click
Open?"). Two probes per service doubles complexity for marginal
debugging value. If we ever need finer granularity, expose it
through structured logging, not the health API.

### "Make staging cleanup explicit at end-of-extract (not start)"

Considered: clean up `.new` dirs at the END of extraction
(after a successful swap), not the start. Symmetric with
"create at start, destroy at end".

Rejected: that doesn't cover the crash-mid-extract case at all
(if extract crashes, end-of-extract code never runs). Cleanup
at start, BEFORE writing anything, is the only ordering that
makes the operation crash-recoverable.

### "Add a watchdog that monitors disk space + aborts extract early"

Considered: pre-flight check disk space; surface a clear error
if the platform tarball won't fit. Avoids "ran out of space
mid-extract" failures.

Rejected: the staging+swap pattern + pre-extract cleanup
already makes "ran out of space mid-extract" recoverable. The
user re-runs after freeing space; no manual cleanup. A space
pre-flight is gold-plating — installer .zip is ~540 MB; modern
Macs have free GB.

## Unresolved questions

None. v10 is implementation-ready.

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

New verification items from v10:

10. **Crash-recovery negative test.** Kill the installer mid-
    extract (`kill -9`); confirm next run cleans `bin.new/`
    cruft and produces a correct final layout.
11. **Playground probe path matches browser load.** Confirm the
    probe URL configured in `project.go` is the same path the
    user-facing surface answers — not a `/health` sidecar that
    might lead the wizard.

## Overlap with v9

v10 keeps unchanged from v9:
- TLDR section structure (with v10-specific changelog header
  noting what changed; v9 changelog rolled into the "all v9
  decisions roll forward" line)
- All six problem statements
- All eight goals + four non-goals
- Cross-cutting `/api/launcher-health` endpoint surface (HTTP +
  SSE + shutdown + bind-failure dialog)
- Service status state machine (extended to reference Decision
  #32 for probe path)
- Issue 1+2+3 wizard rewrite (unchanged)
- Issue 4 tray fix (unchanged)
- Issue 5 .app bundling, /Applications-only with admin elevation,
  binDir resolution, pre-flight (unchanged)
- Issue 6 Quit/uninstall sweep semantics (unchanged)
- Build sequence (unchanged; v0.1.16 still ships first)
- Stack 1/2/3 split + recommended order (unchanged)

v10 changes from v9:
- TLDR §: 4 new gap-fixes documented
- Cross-cutting state-machine doc: probe-path note added
- Migration §: new step 4 (pre-extract cleanup); steps 4-9
  renumbered to 5-10; new "crash recovery" negative test in
  §Test before shipping
- §Risks: migration recoverability strengthened to cover crash
  case; `open -a` arg-drop trade-off documented; readiness
  probe cost vs accuracy noted
- CLAUDE.md additions: `--args` limitation note on LaunchAgent
  bullet; new readiness-probe-path bullet; migration bullet
  updated to v10 + crash-recovery
- Test matrix: 3 new tests (pre-extract cleanup, license URL
  interpolation assertion, project.go probe path)
- Decisions: #27 tightened (literal version interpolation +
  checklist moved out of bin/), #29 amended (`--args` second-
  launch limitation), #31 (pre-extract cleanup) and #32 (probe
  path) added
- TLDR counts: 30 → 32 decisions, 13 → 14 risks, 6 → 9 verif
  items

## Recommendation

**Stop reviewing the plan; start writing the code.** v10 is the
last useful /improving-plans output. Eight prior review passes +
v10's four new gaps closed all the platform-parity and failure-
mode edges that survived. Stack 1 (launcher HTTP server + Issue 6)
still ships the highest-confidence fix with the smallest blast
radius; implementation should start there.
