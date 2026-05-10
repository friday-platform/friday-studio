# Updating the friday-agent-sdk pin

Audience: a coding agent told to "bump the agent-sdk pin to X.Y.Z".
This doc names every step and every failure mode. Read it end-to-end
before editing.

## Pin sites — all three must agree

| # | File | Line | Form |
|---|---|---|---|
| 1 | `tools/friday-launcher/paths.go` | 37 | `const bundledAgentSDKVersion = "X.Y.Z"` ← **source of truth** |
| 2 | `Dockerfile` | 144 | `ENV FRIDAY_AGENT_SDK_VERSION=X.Y.Z \` |
| 3 | `apps/studio-installer/src-tauri/src/commands/prewarm_agent_sdk.rs` | 53 | `const BUNDLED_AGENT_SDK_VERSION: &str = "X.Y.Z";` |

Drift across these three is enforced by
`scripts/check-sdk-pin-sync.ts` (CI workflow
`.github/workflows/sdk-skill-drift.yml` + husky lint-staged when any
of the three pin files is staged). Failure mode prints:

```
✗ SDK version pin drift detected:
  launcher (paths.go): X.Y.Z
  Dockerfile: A.B.C
  installer (prewarm_agent_sdk.rs): X.Y.Z
```

## Auto-derived consumer — do **not** edit

`scripts/setup-dev-env.sh:49–53` greps `bundledAgentSDKVersion` out of
`paths.go` at script-run time and reuses it for the dev envfile + uv
pre-warm. The grep is the single derivation; editing the script for a
version bump is a wasted turn.

## Procedure

### 1. Confirm the target version exists

- PyPI: <https://pypi.org/project/friday-agent-sdk/>
- Git tag: `v<X.Y.Z>` on `friday-platform/agent-sdk`

If the tag is missing, `scripts/sync-sdk-skill.ts` (step 4) will fail
with:

```
Resolving tag v<X.Y.Z>: git ls-remote failed (Tag v<X.Y.Z> not found
at https://github.com/friday-platform/agent-sdk); GitHub API also
failed (404 Not Found).
```

If the wheel is not on PyPI, the daemon's `uv run --with
friday-agent-sdk==<X.Y.Z>` spawn (`apps/atlasd/src/agent-spawn.ts`)
will fail at first user-agent run, not at build time. Don't ship a
pin to a version that isn't on PyPI yet.

### 2. Edit the three pin sites

Update sites 1, 2, 3 from the table above to `X.Y.Z`. The bytes
themselves are the only edit — no other rewrites needed.

### 3. Verify pin sync

```sh
deno run --allow-read scripts/check-sdk-pin-sync.ts
```

Expected output: `✓ All sites pinned to X.Y.Z`. Any other output is a
typo in step 2.

### 4. Re-vendor the Python skill

```sh
deno run -A scripts/sync-sdk-skill.ts
```

Pulls
`friday-platform/agent-sdk@v<pinned>:packages/python/skills/writing-friday-python-agents/`
into `packages/system/skills/writing-friday-python-agents/`. Affects:

- `SKILL.md` — frontmatter `vendored-from: <repo>@<sha>` and
  `vendored-version: <X.Y.Z>` get rewritten on every run; body +
  description copied verbatim from upstream.
- `references/api.md`, `references/constraints.md`,
  `references/examples.md` — copied verbatim, only updated when
  upstream actually changed them.

The script is idempotent: re-running prints `✓ in sync` per file when
nothing drifted. CI runs it with `--check` (no-write) and fails on
drift.

### 5. Commit

```
chore: bump friday-agent-sdk to X.Y.Z
```

Pre-commit hook runs lint-staged + the pin-sync check. Both must
pass.

### 6. Open a PR

The bump is a coordinated launcher-release decision (the daemon is
tested against the pinned SDK), so it always goes through review.

## Don't

- Don't edit `scripts/setup-dev-env.sh` for the version — it greps
  `paths.go` at runtime.
- Don't add a pin site that isn't in `scripts/check-sdk-pin-sync.ts`'s
  `SITES` array — drift detection won't cover it.
- Don't hand-edit
  `packages/system/skills/writing-friday-python-agents/`. Upstream
  (`friday-platform/agent-sdk`) is the only source of truth;
  `sync-sdk-skill.ts` is the only writer.
- Don't bump to a version that isn't on PyPI + tagged on the SDK
  repo. The two scripts above will fail loudly, but installs in the
  wild fail silently at first user-agent spawn.
