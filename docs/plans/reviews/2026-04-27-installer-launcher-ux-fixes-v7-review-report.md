# Review report: 2026-04-27-installer-launcher-ux-fixes (v7)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v8.md`

## Why v8 happened

v7 review concluded "plan converged, stop reviewing, write
code". User then added two new product requirements that v7
hadn't anticipated:

1. Supervised binaries should live in `~/.friday/local/bin/`,
   not directly in `~/.friday/local/`.
2. Bundle nats-server LICENSE alongside the binary.

These are real product changes (not document polish) that
cascade through the design, so v8 is a real version bump, not
a touch-up.

## Three new ideas, all baked in

### 1. `~/.friday/local/bin/` subdir for all supervised binaries

**User request:** "I also want all binaries to be in
~/.friday/local/bin/ not directly in local folder".

**Cascade impact:**
- `binDir` default changes from
  `filepath.Dir(os.Executable())` to
  `~/.friday/local/bin/` (with dev fallback to launcher's own
  dir if bin/ doesn't exist)
- `processkit.SweepByBinaryPath(binDir)` now points at
  `~/.friday/local/bin` (was `~/.friday/local`); doesn't
  accidentally sweep state files
- Pre-flight check looks under `bin/` for missing supervised
  binaries
- Migration step's "remove old binaries" list grows: explicitly
  remove all 8 supervised binaries from the v0.0.8 flat layout,
  not just the launcher
- Tarball staging in `scripts/build-studio.ts`: emit `bin/`
  subdir; macOS tarball has TWO top-level entries
  (`Friday Studio.app/` and `bin/`) instead of N flat binaries
- Installer extract dispatches by top-level component (`.app/`
  → /Applications, `bin/` → ~/.friday/local/bin/)

### 2. License files for third-party + own binaries

**User request:** "I need to include nats-server LICENSE
maybe as ~/.friday/local/bin/nats-server-license file".

**User decision (asked):** bundle all three third-party
LICENSE files (nats-server, cloudflared, gh) plus our own
BSL 1.1 LICENSE for legal completeness.

**Cascade impact:**
- `bin/nats-server-license` (Apache 2.0)
- `bin/cloudflared-license` (Apache 2.0)
- `bin/gh-license` (MIT)
- `bin/LICENSE` (BSL 1.1, our own)
- `scripts/build-studio.ts` extracts the LICENSE files from
  the same release archives it already downloads for the
  binaries — for nats-server the path is
  `nats-server-vX.Y.Z-platform/LICENSE` inside the .tar.gz,
  for cloudflared it's `LICENSE` at archive root, for gh it's
  `LICENSE` at archive root. New build assertion: each LICENSE
  file must exist post-extract; otherwise build fails loudly.

### 3. Drop v0.1.15 cutover compatibility

**User decision (asked):** "No need to keep any backward
compatibility, nobody is using this yet".

**Cascade impact:**
- v0.0.9 tarball drops the duplicate `friday-launcher` at
  tarball root (was Decision #11 in v6/v7).
- Build sequence now requires v0.1.16 to ship BEFORE v0.0.9
  platform manifest goes live. Without the duplicate, v0.1.15
  installers can't extract v0.0.9's bin/ layout.
- Trade-off accepted because today's fleet is ~1 user (lcf).
- Decision #11 isn't deleted from the plan — kept as a
  "superseded" callout so future readers see the lineage.

## Issues considered and discarded

### "Add a `friday/` symlink at `~/.friday/local/` pointing at `bin/friday`"

Considered: for users who like to type `~/.friday/local/friday`
in shell. Rejected: launcher does the discovery; users don't
invoke binaries directly. PATH-style symlinks are a feature for
later if ever requested.

### "Symlink `~/.local/bin/friday` → `~/.friday/local/bin/friday` so it's on the user's PATH"

Considered: makes `friday` invokable as a CLI from any shell.
Rejected: out-of-scope. The friday CLI today is invoked via
`deno task atlas` from the repo root; no user-facing
`friday` command is exposed. Future feature.

### "Make `bin/` versioned: `bin/v0.0.9/`"

Considered: side-by-side install of multiple platform versions.
Rejected: the launcher is single-instance + supervises a single
version; versioned bin/ adds complexity for no use case.

### "Bundle process-compose's LICENSE too (it's vendored Go
dependency)"

Considered: process-compose is Apache 2.0. Rejected: it's a
Go-module dependency that gets compiled into our launcher
binary, not redistributed as a separate executable. Standard
Go-attribution patterns (licenses bundled into the launcher
binary's metadata, surfaced via `--licenses` flag if/when we
add one) cover this. Different from CLI binaries we ship
verbatim.

### "Move ~/.friday/local/.env into ~/.friday/local/bin/.env or
similar"

Considered: keep all "platform-owned" files in bin/. Rejected:
.env is user state (API keys), not a binary. The bin/ split is
specifically about isolating binaries from user-mutable state.

## Unresolved questions

None. v8 is implementation-ready.

Verification items carried forward (all have documented
fallbacks if they fail):

1. Spotlight + LSUIElement on macOS Sonoma+
2. EventSource on Windows WebView2
3. codesign --deep on the .app bundle
4. osascript availability under MDM-restricted macOS
5. xattr -dr behavior on signed .apps

New verification item from v8:

6. **LICENSE file presence in pinned third-party releases.**
   Verify pre-merge that `nats-server-vX.Y.Z-<platform>.tar.gz`
   contains `LICENSE` at the documented path. Same for
   cloudflared and gh. Build asserts but worth eyeballing the
   expected layout once.

## Overlap with v7

v8 keeps unchanged from v7:
- TLDR section structure (with content updates for new layout)
- Issue 1+2+3 wizard rewrite (unaffected by layout change —
  the wizard reads from `/api/launcher-health` which abstracts
  paths)
- Issue 4 tray fix
- Issue 6 Quit/uninstall sweep semantics (path target updates
  to `bin/` but the logic is identical)
- Cross-cutting `/api/launcher-health` design
- All concurrency, state machine, HTTP server lifecycle, SSE
  fan-out work
- Pre-flight via osascript + Quit confirmation via cgo NSAlert
  split
- Wait-healthy 60s/90s/+60s staged deadline
- "Open anyway" partial-success rule
- Cmd+Q + NSApp will-terminate semantics
- Quarantine xattr strip with admin-elevation chaining
- Test Matrix structure

v8 changes from v7:
- TLDR bullet 3 mentions bin/ + LICENSE files
- TLDR bullet 6 swapped from "rollout-order-agnostic" to
  "v0.1.16 ships first"
- Issue 5 tarball layout: bin/ subdir; LICENSE files;
  duplicate launcher at root removed
- Issue 5 binDir resolution: always `~/.friday/local/bin/`
  (with dev fallback)
- Issue 5 extract dispatch: split-destination over `.app/`
  and `bin/` only (no per-binary entries to handle)
- Issue 6 sweep target: `~/.friday/local/bin` (was
  `~/.friday/local`)
- Migration table: new rows for bin/ binaries + LICENSE files
- Migration step 4: remove ALL v0.0.8 flat-layout binaries,
  not just the launcher
- Build sequence: v0.1.16 installer must ship first
- CLAUDE.md additions: bin/ paths + LICENSE files
- New risk: upstream LICENSE-file-presence assertion in build
- Decisions #25 (bin/ layout) and #26 (license bundling) added
- Decision #11 reframed from "ship duplicate launcher" to "no
  cutover compat" (with lineage callout)
- Counts in TLDR footer: 26 decisions, 12 risks
