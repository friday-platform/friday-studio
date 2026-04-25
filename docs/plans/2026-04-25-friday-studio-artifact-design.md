# Friday Studio Artifact Pipeline — Design

**Date:** 2026-04-25
**Status:** Drafted — pending implementation

## Problem Statement

Friday Studio (the platform binaries: `atlas` daemon, `link` auth service,
`agent-playground` UI, `webhook-tunnel`) currently ships only as a Docker
image (`Dockerfile-platform`). The studio-installer wizard expects to fetch a
native tarball from `https://download.fridayplatform.io/studio/manifest.json`,
extract it to `~/.friday/local/`, and spawn the binaries directly — but no
producer-side pipeline exists today, so the installer downloads a placeholder
manifest pointing at a tiny dummy file.

Result: the installer wizard runs to completion locally but the actual
"download Friday Studio" step has no real artifact behind it.

## Solution

A new GitHub Actions workflow `studio-build.yml` that mirrors the
`studio-installer-build.yml` shape:

- One `version` job auto-bumps the patch from the published
  `studio/manifest.json`.
- A 3-row build matrix (`macOS arm64`, `macOS x64`, `Windows x64`) compiles
  the 4 Deno binaries with `deno compile --target=...`, bundles 3 external
  CLIs (`claude`, `gh`, `cloudflared`), notarizes on macOS, packs into a
  per-target archive (`tar.gz` on macOS, `zip` on Windows), uploads to GCS at
  `studio/friday-studio_<version>_<target>.<ext>`, and emits a per-platform
  manifest entry.
- A `publish-manifest` job aggregates the three entries into
  `studio/manifest.json` and uploads it.

The installer is updated to (a) detect the running arch and pick the right
manifest entry by key (`macos-arm` / `macos-intel` / `windows`), and (b)
verify the SHA-256 of the downloaded archive before extraction.

End-to-end QA: the installer wizard, run on a fresh machine, downloads the
real platform tarball, verifies the checksum, extracts to
`~/.friday/local/`, and launches `atlas` + `link` + `playground` +
`webhook-tunnel` successfully.

## User Stories

1. As a Friday Studio end-user on macOS Apple Silicon, I want the installer
   to download a real platform tarball (signed and notarized for my arch) so
   that Gatekeeper does not block any binary on first run.

2. As a Friday Studio end-user on macOS Intel, I want the installer to pick
   the `x86_64-apple-darwin` archive (not the arm64 one) so the binaries can
   actually execute on my CPU.

3. As a Friday Studio end-user on Windows, I want the installer to extract a
   `.zip` (not a `.tar.gz`), so it works without third-party tools.

4. As a Friday Studio end-user, I want the installer to verify the SHA-256 of
   the downloaded archive before extracting, so a corrupted or tampered
   download is rejected loudly rather than producing a broken install.

5. As a Friday Studio end-user, I want the install to include `claude`, `gh`,
   and `cloudflared` so agents that depend on them work out of the box.

6. As a release engineer, I want the platform version to auto-bump from the
   published manifest, so I don't have to remember to edit a version string
   anywhere.

7. As a release engineer, I want every release filename to contain the
   version (`friday-studio_0.0.5_aarch64-apple-darwin.tar.gz`), so each URL
   is content-addressable and CDN cache can mark it `immutable` forever
   without poisoning risk.

8. As a release engineer, I want a manifest at `studio/manifest.json` whose
   shape matches `installer/manifest.json` (same `{version, platforms{...}}`
   schema), so the same `Manifest` Rust struct in `fetch_manifest.rs`
   deserializes either one.

9. As a release engineer, I want every CI build to update the manifest
   atomically (publish artifacts first, then manifest), so a CDN that fetches
   the manifest mid-deploy never sees URLs that 404.

10. As a release engineer, I want CI to fail loudly if any build target's
    archive is missing or its SHA-256 doesn't compute, so a half-broken
    manifest never gets published.

11. As an installer developer, I want to QA the full chain (build → upload →
    manifest publish → CDN cache → installer download → SHA verify → extract
    → launch) end-to-end before each phase is considered done.

12. As an installer developer, I want to be able to run the chain in
    sandbox first (different GCS bucket, different domain) before touching
    production, so first-run mistakes don't pollute the live download host.

13. As a Friday Studio user, I want the install to be idempotent — running
    the installer again with the same version installed should be a no-op
    (or update if a newer version is published), so I can re-run safely.

14. As an end-user, I want any update to overwrite the four platform
    binaries cleanly without leaving stale ones, so each install is a
    consistent snapshot.

## Implementation Decisions

### Build pipeline

- **Workflow file:** `.github/workflows/studio-build.yml`. Triggered on push
  to main with paths under `apps/atlasd/**`, `apps/link/**`,
  `apps/webhook-tunnel/**`, `tools/agent-playground/**`, `packages/**`,
  `deno.json`, `deno.lock` — plus `workflow_dispatch`.

- **Three jobs:** `version`, `build` (matrix x3), `publish-manifest`.

- **Build matrix:** uses native runners (`macos-latest-xlarge`,
  `macos-latest-large`, `windows-latest`) so codesigning + notarization can
  use the existing Apple Developer creds the installer build already has
  wired up.

- **Cross-package builds inside the matrix:**
  - `deno compile --target=<target> --output=bin/<name> ...` for
    `atlas`, `link`, `webhook-tunnel`.
  - For `playground`: first `npx svelte-kit build` produces
    `tools/agent-playground/build/` (static SvelteKit output via
    `adapter-static`). Then a tiny Deno HTTP server source file (new —
    `tools/agent-playground/static-server.ts`) is `deno compile`'d with
    `--include` of the build dir, producing a single `playground` binary
    that statics-serves the embedded files on a fixed port.

- **External CLI bundling:**
  - `claude`: `npm pack @anthropic-ai/claude-code` → embed in
    `claude/` subdir as `cli.js` + `package.json`. Plus a tiny Node
    runtime (`node` binary for the target platform, downloaded from
    nodejs.org). Bundled at a known version pinned in the workflow.
  - `gh`: download official tarball for target arch from GitHub releases
    (e.g. `gh_2.x.x_macOS_arm64.tar.gz`). Pinned version.
  - `cloudflared`: download official binary for target arch
    (`cloudflared-darwin-arm64`, etc.). Pinned version.

- **Codesign + notarize (macOS only):** every Mach-O binary in the archive
  (`atlas`, `link`, `playground`, `webhook-tunnel`, `claude`'s embedded
  Node, `gh`, `cloudflared`) gets signed with the same Apple Developer ID
  cert the installer uses, then the whole archive is notarized via
  `notarytool submit` and stapled.

- **Packing:**
  - macOS: `tar -czvf friday-studio_<version>_<target>.tar.gz <staging>/`
    where `<staging>/` contains all binaries + `claude/` subdir.
  - Windows: `Compress-Archive` to `.zip`.

- **SHA-256:** `shasum -a 256 <archive>` on macOS, `Get-FileHash` on
  Windows. Emitted in the per-platform manifest entry.

- **Upload:** versioned filename only (no `-latest` redirect at the
  studio/ level for now — the installer reads the manifest directly to
  resolve the URL, so no redirect indirection needed). Path:
  `gs://friday-production-studio-artifact/studio/friday-studio_<version>_<target>.<ext>`.

### Manifest

- **Path:** `gs://friday-production-studio-artifact/studio/manifest.json`.
- **Schema:** identical to `installer/manifest.json` (same Manifest /
  PlatformEntry shape consumed by `fetch_manifest.rs`):
  ```json
  {
    "version": "0.0.5",
    "platforms": {
      "macos-arm":   {"url": "https://download.fridayplatform.io/studio/...", "sha256": "...", "size": ...},
      "macos-intel": {"url": "...", "sha256": "...", "size": ...},
      "windows":     {"url": "...", "sha256": "...", "size": ...}
    }
  }
  ```
- **Cache-Control on the manifest** is governed by studio-artifact's
  existing handler: `.json` files get `max-age=60, must-revalidate`.
  Versioned filenames get `immutable`. Identical to installer manifest
  behavior.

### Installer changes

- **New helper** `current_platform()` in `apps/studio-installer/src-tauri/src/`
  that returns the platform key string. `cfg!(target_os)` +
  `cfg!(target_arch)` → `"macos-arm"` / `"macos-intel"` / `"windows"`.

- **Update `detectInstallState()` / Download.svelte**: replace the
  hardcoded `manifest.platforms["macos"]` (or whatever the current
  placeholder is) with `manifest.platforms[await current_platform()]`.
  Emits a clear error if the manifest doesn't have an entry for the
  current platform.

- **SHA-256 verification:** after download completes,
  `download.rs` computes the SHA-256 of the downloaded file and compares
  against the manifest's `sha256` field. Mismatch → delete the file,
  surface a clear error in the UI ("Downloaded file is corrupted —
  please retry"), block extraction.

- **Extract path:** unchanged (`~/.friday/local/`). The archive expands
  flat — binaries at the top level, `claude/` subdir for the Node-bundled
  CLI.

### GCS layout

```
gs://friday-production-studio-artifact/
├── installer/                              (already exists)
│   ├── manifest.json
│   ├── macos-arm/...
│   ├── macos-intel/...
│   └── windows/...
└── studio/                                 (new)
    ├── manifest.json
    ├── friday-studio_0.0.1_aarch64-apple-darwin.tar.gz
    ├── friday-studio_0.0.1_x86_64-apple-darwin.tar.gz
    └── friday-studio_0.0.1_x86_64-pc-windows-msvc.zip
```

No `-latest.*` redirects on the studio side — the installer fetches
`studio/manifest.json` and resolves the platform URL directly. (We could
add redirects later if a marketing-page download link ever needs them.)

### Module Boundaries

#### `studio-build.yml` workflow

- **Interface:** event triggers (push, manual dispatch); reads source repo
  + GCS manifest; writes versioned artifacts + new manifest to GCS.
- **Hides:** Deno compile flags + targets, codesign + notarization mechanics,
  CLI bundling specifics, archive format choice per platform, version
  computation, manifest aggregation.
- **Trust contract:** if the workflow returns success, every entry in the
  newly-published `studio/manifest.json` resolves to a downloadable
  versioned archive whose SHA-256 matches the manifest's claim.

#### `playground` static-server binary (new)

- **Interface:** `playground` binary. Run with `--port <N>` (default 5200).
  Serves `index.html` + assets from embedded `dist/`.
- **Hides:** SvelteKit's static-output structure, MIME-type detection,
  embedded-asset lookup. Caller doesn't need to know whether the assets
  are on disk or compiled-in.
- **Trust contract:** GET requests for files in the SvelteKit dist return
  the right bytes with the right content-type and `200`. Unknown paths
  return `index.html` (SPA fallback).

#### `current_platform()` in installer

- **Interface:** zero-arg Rust function returning `&'static str`.
- **Hides:** the mapping from `cfg!(...)` to manifest-key conventions.
  If we ever rename platform keys, this is the only place that changes.
- **Trust contract:** the returned key matches a key the build pipeline
  emits. (Compile-time guaranteed: only the three known values are
  reachable.)

#### Manifest file contract (cross-language)

- **Interface:** JSON file at fixed URL. Schema = `{version, platforms{...}}`
  with PlatformEntry `{url, sha256, size}`.
- **Hides:** which version is current, which CDN/origin serves the
  artifact, which arch a given URL targets (from the producer side).
- **Trust contract:** same Rust `Manifest` struct deserializes both
  `studio/manifest.json` and `installer/manifest.json`. Adding new fields
  must be backward-compatible (Rust struct uses `#[serde(default)]` for
  any optional additions).

## Testing Decisions

### What makes a good test here

The deploy chain has three layers — each gets a different test class:

1. **Producer (CI workflow)** — assert at the workflow level via real
   end-to-end runs. No mock-the-GCS-API style; we just dispatch the
   workflow and verify the artifacts + manifest are in GCS with correct
   shapes.

2. **Manifest fetch (installer Rust side)** — unit tests in Rust against a
   mock manifest with various shapes (current-platform present, missing,
   malformed JSON, etc.). Existing `fetch_manifest.rs` tests model.

3. **End-to-end smoke** — install on a real Mac and a real Windows machine
   (or VM) and assert:
   - Download progresses
   - SHA-256 verification passes
   - Extract creates the expected directory layout
   - All four binaries launch and are reachable on their expected ports
   - Quitting the installer cleanly stops all spawned processes

### Modules tested

- `studio-build.yml` — tested via dispatch + outcome inspection.
- `playground` static-server — Go-style table tests against the embedded
  asset resolver.
- `current_platform()` — trivial test (cfg-gated) that asserts we return
  one of the three expected strings.
- `download.rs` SHA verification — unit test with a known-good blob and a
  known-tampered blob.

### Prior art

- `apps/studio-artifact/service/handler_test.go` — pattern for testing
  the manifest-handling Go service.
- `apps/studio-installer/src-tauri/src/commands/*.rs` — existing Rust
  command tests in this app.
- `studio-installer-build.yml` — same workflow shape, recent and
  battle-tested.

## Out of Scope

- **Linux platform target.** Only Mac arm/intel + Windows. If anyone
  wants a self-hostable Linux build, that's a follow-up.
- **Auto-update inside Friday Studio.** The installer detects newer
  versions and the user manually re-runs install. No background updater.
- **Code signing for Windows binaries.** Same as the installer's current
  approach — self-signed cert at build time, no EV cert. SmartScreen
  warning expected on first run.
- **Bundling Python toolchain.** No `componentize-py`, `uv`, `jco`. Server-
  side concerns; can be added later if desktop agent-builds are needed.
- **`-latest.*` redirect URLs at the studio/ level.** Installer reads the
  manifest directly. Add redirects only if a non-installer client wants
  them.
- **Notification of new versions to running Friday Studio instances.**
  Out of scope for v0.0.1.
- **Rollback to a previous version from the installer.** The wizard can
  install whatever version the manifest currently advertises; rolling back
  requires republishing an older manifest manually.

## Further Notes

- The `claude` CLI bundle is the heaviest piece (~50-150 MB depending on
  the Node runtime). If archive size is a concern, we can switch to having
  the installer download `claude` separately on first launch.

- macOS notarization adds latency to every release (~3-15 minutes per
  archive while Apple's service processes it). Each platform is notarized
  in parallel within the build matrix, so wall-clock time stays bounded
  by the slowest one.

- We will deliberately NOT add a `-latest.tar.gz` redirect on the studio
  side until there's a real consumer asking for one. The installer reads
  the manifest, so it always finds the current version without indirection.
