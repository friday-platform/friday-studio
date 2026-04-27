# Review report: 2026-04-27-installer-launcher-ux-fixes (v5)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v6.md`
**Verdict:** Plan converged. v6 is a small touch-up; further
review cycles past this are diminishing returns.

## Context gathered (residual threads)

After 4 prior review passes the codebase has been thoroughly
explored. v5 review re-checked:

- `pkg/processkit/orphans.go:scanProcessesByBinaryPath` — uses
  `ps -eo pid=,comm=` to scan the OS process table. Goroutines
  inside a Go test process do NOT appear in `ps`; only forked
  child processes do. This is the precise reason the
  integration test for orphan-sweep needs a real binary, not a
  goroutine.
- The existing `terminate_studio_processes` in `extract.rs` runs
  as the same Tauri process that calls `extract_archive`. Tauri
  itself is launched by the user (no admin). So when extract
  succeeds writing to `/Applications`, it was either (a) the
  /Applications dir is user-writable on this Mac, or (b) the
  cp went through osascript with admin elevation. v5 doesn't
  enumerate that the xattr strip needs to mirror this dispatch.
- macOS `xattr -dr` requires write permission on the target
  file's xattr namespace, which equates to file ownership. A
  root-owned file's xattrs cannot be modified by a non-root
  process even if the parent dir is user-writable.

## Two implementation gotchas baked in (no choice)

### 1. xattr strip privilege level must match cp's privilege level

**Problem in v5:** v5 says "after the .app is in place, run
`xattr -dr com.apple.quarantine`". When `/Applications` is
user-writable (common case), this works. When `/Applications`
is locked down and we needed osascript admin elevation for the
cp, the resulting `.app` is owned by root; a subsequent
non-elevated `xattr -dr` returns "Operation not permitted",
silently fails, and the user STILL gets a Gatekeeper prompt on
first launch — the exact case v5's "silent first launch" goal
was fixing.

**Fix (no choice):** dispatch on cp privilege level.

- User-writable case: `xattr -dr ...` runs as the current user.
- Admin-elevated case: chain cp + xattr in the **same** osascript
  invocation. One auth prompt, two commands.
  ```rust
  let script = format!(
      r#"do shell script "cp -R {src:?} {dst:?} && xattr -dr com.apple.quarantine {dst:?}" with administrator privileges"#);
  Command::new("osascript").args(["-e", &script]).output()?;
  ```

v6 adds this dispatch logic in §Issue 5 step 5, plus Decision
#23.

### 2. Orphan-sweep integration test needs an actual child process

**Problem in v5:** v5 says "extend `TestUninstall` to spawn a
stub supervised process". The existing test scaffolding (per
task #92) uses goroutine-stub HTTP servers — convenient for
health-probe testing but **invisible to `ps`** and therefore
invisible to `SweepByBinaryPath`. An implementer reading v5
might naturally extend `TestUninstall` with the existing
goroutine pattern, write a green test that doesn't exercise
the actual sweep path, and ship the same bug we caught on
2026-04-27.

**Fix (no choice):** explicit guidance.

- Test must spawn an actual binary as a child process (e.g. a
  small `sleep 60`-style stub copied to a test-temp install
  dir).
- Override `binDir` to point at the test-temp dir so the sweep
  finds the stub.
- After `--uninstall`, assert
  `processkit.ProcessAlive(stubPid) == false`.

v6 expands the file-list note for `integration_test.go` with the
actual recipe, plus Decision #24.

## Issues considered and discarded

### "Limit Cmd+Q teardown to fast-shutdown for UI responsiveness"

Considered: instead of Decision #13's "synchronous
performShutdown blocks the NSApp main thread for up to 30s
during interactive Cmd+Q", do a 2-second fast-shutdown that
SIGTERMs everything and returns, letting orphans linger and
get reaped on next startup.

Rejected: interactive Cmd+Q on a menubar app is rare (users
mostly use the tray Quit menu, which has the confirmation
modal + "Stopping…" feedback). The 30s freeze is rare-and-power-
user; orphans surviving Cmd+Q is also acceptable per the
existing system-shutdown failure mode. Splitting the shutdown
path adds code without clear ROI.

### "Make the wait deadline extension unlimited (no cap)"

Considered: simplify the "Wait 60s more" → "Wait again" → 210s
cap by allowing arbitrary extensions. User can keep waiting
indefinitely.

Rejected: bikeshed. Two extensions covering 30→210s is enough
real-world coverage; further refinement is post-deployment data.

### "Consolidate dialog files: one `dialog_darwin.go` for both
osascript and NSAlert"

Considered: combine
`tools/friday-launcher/preflight_dialog_darwin.go` and
`tools/friday-launcher/confirm_darwin.go` into one
`dialog_darwin.go` with two functions. Reduces file count.

Rejected: pre-flight (osascript, no NSApp) and confirmation
(cgo NSAlert, post-NSApp) are different mechanisms with
different pre-conditions. Splitting per-purpose makes it
obvious to readers when each function is appropriate.

### "Add NSApp will-terminate observer thread-binding spec"

Considered: cgo callbacks must execute on the main thread on
macOS. The plan says "register NSApplicationWillTerminate
observer" without specifying thread constraints. An implementer
could try to register the observer from a Go-spawned goroutine
and hit thread-affinity bugs.

Discarded as a v6-pass change because: (a) `runtime.LockOSThread`
+ register-on-main-thread is a well-known pattern and any
implementer working with cgo + NSApp will know to look it up;
(b) the actual cgo glue lives in `nsapp_terminate_darwin.m`
(implicit in v5's file list) where the convention is documented
inline by the wrapper's author.

If the implementer hits this in practice, it surfaces as a v7
clarification. Premature spec.

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

## Overlap with v5

v6 keeps unchanged from v5:
- All 6 problem statements
- All 8 goals
- The cross-cutting `/api/launcher-health` design (HTTP + SSE +
  shutdown handler, state machine, concurrency model, server
  lifecycle decoupled from RestartAll)
- Issue 1+2+3 (wizard rewrite with staged 60s/90s/+60s deadline,
  per-service checklist via SSE, "Open anyway" partial-success,
  capped-backoff connect retry, exit-on-Open-in-Browser)
- Issue 4 (tray title-text status, health-cache bucket logic)
- Issue 5 (.app bundle, /Applications-only with admin
  elevation, pre-flight via osascript, binDir resolution)
- Issue 6 (Quit confirmation modal, NSApp will-terminate hook,
  HTTP shutdown async, --uninstall sweep)
- v0.0.8 → v0.0.9 migration sequence
- Backwards-compatible v0.0.9 tarball with duplicate launcher
- Build+ship sequence + future-cleanup note
- All 11 risk callouts
- The first 22 decisions

v6 changes from v5:
- xattr strip dispatch on cp privilege level — single
  osascript invocation chains cp + xattr when admin elevation
  was needed (Decision #23)
- Integration test for orphan sweep uses an actual child
  process, not a goroutine — `ps` doesn't list goroutines
  (Decision #24)
- Convergence note in document header — v6 is a touch-up; the
  next step is implementation, not v7
