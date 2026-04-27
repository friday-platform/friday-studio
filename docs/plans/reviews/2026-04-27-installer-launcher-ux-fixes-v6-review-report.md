# Review report: 2026-04-27-installer-launcher-ux-fixes (v6)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v7.md`
**Verdict:** **Plan converged on design.** No new design ideas
worth promoting. v7 carries three document-organization
improvements (TLDR, Recommended Implementation Order, Test
Matrix) but no new design content.

## Honest assessment

Six review passes is enough. Each prior cycle found legitimately
new design issues:

- **v1 → v2:** routing manifest through download.fridayplatform.io;
  retryDownload re-fetches manifest; 416 handling; tray title-text;
  workflow no-cache header (5 ideas).
- **v2 → v3:** /api/launcher-health endpoint; drop Setpgid;
  extract running count; /Applications-only; v0.0.8→v0.0.9
  migration (5 ideas).
- **v3 → v4:** async POST /api/launcher-shutdown; backwards-
  compatible v0.0.9 tarball; pre-flight check + NSAlert;
  Cmd+Q sync vs detached; LaunchAgent label decision (5 ideas).
- **v4 → v5:** osascript for pre-flight (NSApp ordering);
  staged 60s/90s/+60s deadline; "Open anyway" partial-success
  rule; HealthCache state machine + HTTP server lifecycle docs
  (5 ideas).
- **v5 → v6:** SSE early-connect backoff; quarantine xattr
  strip; CLI mode pre-flight skip; CLAUDE.md additions
  (4 ideas).
- **v6 → v7:** xattr admin elevation chaining; integration
  test needs real binary (2 ideas — implementation gotchas,
  not design).

Each cycle found progressively smaller issues. v7's review
turned up nothing new.

## What I checked this pass (just to be sure)

- The wait_health.rs backoff math: 200+400+800+1600+2000+2000+
  2000 ≈ 9000ms, hits the 10s deadline cleanly with 5 retries.
  Correct.
- The /api/launcher-shutdown 409 path: behaviour spec'd, no
  caller question. Concrete callers (wizard update flow, future
  tools) call this once per session; second-call-during-active-
  shutdown is unrealistic. Skip.
- HTTP server bind-fail handling: the plan says "launcher
  startup fails with a clear error". Implementation detail —
  a competent Go programmer will Listen-then-Serve and check
  the bind error. Not a v7-level addition.
- macOS NSApp will-terminate cgo thread-binding: implementation
  convention covered by `runtime.LockOSThread` and any cgo+
  AppKit reference. Not a v7-level addition.
- The wait deadline UX micro-decisions: "Wait again" semantics,
  one-shot vs unlimited. Bikeshed; either works.
- Document length: 600+ lines of plan with 5 review reports
  alongside. Future reader needs a path through. Hence the
  TLDR + Recommended Implementation Order + Test Matrix
  additions in v7.

## What v7 changes from v6

**Document polish only — no design changes:**

1. **TLDR section at the top** (~40 lines): six-bullet
   summary + pointer to §Decisions and §Risks. A
   future-Claude or new contributor can read the TLDR and
   know what's coming without parsing 600 lines.

2. **Recommended Implementation Order section** (just before
   §Decisions): the 3-stack split I've been giving in chat
   each cycle, now in the document. Stack 1 (launcher HTTP
   server + Issue 6) → Stack 2 (wizard UX) → Stack 3 (.app +
   migration). Each stack lists the files it touches.

3. **Test Matrix table**: which tests get added/extended
   where, by stack. Forces the implementer to think about
   coverage up-front rather than treating tests as "extend
   the existing thing". Includes the explicit
   "tests skipped" list (Spotlight indexing, WebView2 SSE,
   Cmd+Q during system shutdown) so future maintainers don't
   wonder why CI has no coverage for those.

These additions don't change a single design decision. They
make the document usable as an implementation spec rather than
a design discussion log.

## Issues considered and discarded

### "Add a 'design rationale' section explaining why each
decision was made"

The decisions list is already in the plan. Each decision has a
short rationale baked into its bullet. A separate "rationale"
section would duplicate content.

Skipped.

### "Move Migration to its own document"

The v0.0.8 → v0.0.9 migration sequence is 1.5 screens long.
Could split out into `2026-04-27-installer-launcher-ux-fixes-migration.md`.

Rejected: migration is intrinsically tied to the layout change
in Issue 5. Splitting it pretends they're separate concerns.

### "Add ASCII diagrams of the .app structure / install layout"

Considered: visual aid for the file-tree-style structures already
in §Issue 5 step 2. Rejected: the existing fenced-code-block
indented tree already conveys the structure clearly.

### "Tag each file in the file lists with the stack it belongs
to (Stack 1 / 2 / 3)"

Considered: cross-reference the per-issue file lists with the
Recommended Implementation Order. Rejected: redundant with the
new Implementation Order section, which already lists files by
stack. The per-issue lists stay grouped by issue (which is how
implementers reading the issue think about them).

## Unresolved questions

None. Plan is implementation-ready.

Verification items carried forward (all have documented
fallbacks if they fail):

1. Spotlight + LSUIElement on macOS Sonoma+
2. EventSource on Windows WebView2
3. codesign --deep with the duplicate flat binary at tarball root
4. osascript availability under MDM-restricted macOS
5. xattr -dr behavior on signed .apps (post-strip Gatekeeper
   silence)

## Overlap with v6

v7 keeps unchanged from v6:
- Everything. Every problem statement, goal, non-goal, design
  section, decision (1–24), risk callout, file list, migration
  step, build sequence.

v7 changes from v6:
- TLDR section added at the top
- Recommended Implementation Order section added before
  §Decisions
- Test Matrix table added
- Header status updated to "design converged after 5 passes; v7
  is document polish only"
- Convergence note rewritten to clarify v7 is the last useful
  /improving-plans output

## Recommendation

**Stop reviewing the plan; start writing the code.**

Stack 1 (launcher HTTP server + Issue 6) is self-contained and
ships in v0.0.9 platform tarball — lowest blast radius and
addresses the user's most-painful confirmed bug
(`--uninstall` leaves orphans). Implementation surfaces
real-world feedback that would inform the design of Stacks 2
and 3 better than another review pass.
