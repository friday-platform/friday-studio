# Workspace Bundles — Existing Export Machinery (Research)

**Date:** 2026-04-20
**Companion to:** `2026-04-14-workspace-bundles-design.md`
**Purpose:** Map what already exists on `declaw` around workspace
export/import, so the bundles POC extends existing surfaces rather than
reinvents them. Also aligns the design doc's vocabulary with FAST's
terminology.

## Terminology alignment (from `2026-04-13-openclaw-parity-plan.md`)

- **FAST** — Friday Agent Studio & Toolkit (shipped product).
- **Friday** — the brand; future CLI name (rename from `atlas` deferred).
- **Space** — user-facing term for a workspace. File is still
  `workspace.yml`; API still `/api/workspaces/{id}`; CLI/UX prose says
  "space." This doc follows that convention.
- **Daemon** on port **8080** today. The `18080` seen in the parity
  plan is the aspirational Friday-branded port; the current code at
  `apps/atlasd/src/atlas-daemon.ts:1692` still defaults to 8080.

## What exists today

### 1. Single-file YAML export

**Endpoint:** `GET /api/workspaces/:workspaceId/export`
**File:** `apps/atlasd/routes/workspaces/index.ts` (lines ~829–945)

Produces one YAML file (the whole space as `text/yaml` attachment). It
already does the hard parts bundles will need:

- Loads the composed config via `WorkspaceManager.getWorkspaceConfig()`.
- Fetches resource **declarations** from Ledger and inlines them (schemas
  only — no data).
- Injects credential refs for bundled agents that the user never
  configured via `injectBundledAgentRefs()`.
- Extracts every credential reference with `extractCredentials()` (from
  `packages/config/src/mutations/credentials.ts`).
- Resolves legacy credential IDs → provider refs with
  `toProviderRefs()`. Strips unresolvable refs with
  `stripCredentialRefs()`.
- Drops `workspace.id` so import regenerates it.

Tests: `apps/atlasd/routes/workspaces/export.test.ts` (~569 lines) —
the reference for round-trip-style integration tests.

**Gap to bundle format:** YAML is a single file. Bundles need a
directory layout (`skills/`, `agents/`, `jobs/`, `resources/`),
multi-file primitives, a lockfile with integrity hashes, and optional
state snapshots (memory, resource data, history).

### 2. Adapter surface for state (Phase 1a on declaw)

The parity plan's Phase 1a has landed partial adapter interfaces in
`@atlas/agent-sdk`:

- **`MemoryAdapter`** (`packages/agent-sdk/src/memory-adapter.ts`) —
  corpus-typed router for narrative, retrieval, dedup, kv stores.
- **`SkillAdapter`** (`packages/agent-sdk/src/skill-adapter.ts`) —
  versioned CRUD with `list/get/create/update/history/rollback`.
  Shape already matches what a bundle needs to import from.
- **`ScratchpadAdapter`** (inferred from `packages/adapters-memory/`) —
  `scratchpad-in-memory.ts` is the default.

### 3. Backend implementations

- **`packages/adapters-md/`** — file-based backends:
  - `md-memory-adapter.ts` + `md-narrative-corpus.ts` (markdown files
    with YAML frontmatter).
  - `md-skill-adapter.ts` (markdown + frontmatter per skill, versioned
    history on disk).
- **`packages/adapters-memory/`** — inmemory scratchpad.

Both store state as plain files on disk, which is the bundle's happy
path — **zipping their directory trees is already a valid export
format**, no serialization layer required. Sqlite backends
(`sqlite-rag`, `sqlite-ttl`, `sqlite-kv`) are next to land; they'll
need a distinct "dump this .db" path, but `md` is sufficient for POC.

### 4. Real FAST spaces on `declaw`

Two real-world spaces that serve as POC test subjects:

- **`workspaces/fast-improvements-source/`** (620-line `workspace.yml`,
  plus `skill/SKILL.md`). Drives the OpenClaw parity plan —
  architect → coder → reviewer FSM, `run-task` signal. Has one skill
  already extracted to a file; other primitives still inline. Good POC
  subject: non-trivial, already partially file-based.
- **`workspaces/chat-unify-exec/`** (1127-line `workspace.yml`, plus
  `scripts/seed-backlog.py`). Bigger, more agents, exercises more of
  the config surface.

Existing skill layout convention on `fast-improvements-source`:
`workspaces/<space>/skill/SKILL.md` (singular dir, one `SKILL.md`). The
bundle design calls for `skills/<name>/`; we'll need to decide whether
to migrate the existing convention or support both during transition.

## Gap analysis

| Need | Exists on declaw | Reuse? |
|---|---|---|
| Load composed space config | `WorkspaceManager.getWorkspaceConfig()` | yes |
| Credential → provider-ref stripping | `toProviderRefs()`, `stripCredentialRefs()` | yes |
| Bundled-agent credential injection | `injectBundledAgentRefs()` | yes |
| Resource schema inlining | ledger `listResources` + `toConfigResourceDeclaration()` | yes |
| Drop workspace.id at export | done | yes |
| Versioned skill storage | `SkillAdapter` + `md-skill-adapter` | yes |
| Memory export | `MemoryAdapter` md backends (files on disk) | yes — zip the tree |
| Canonical primitive hashing | — | **new (Hasher)** |
| Lockfile with integrity pins | — | **new (Lockfile)** |
| Directory-based bundle layout (skills/, agents/, jobs/) | — | **new (Bundle)** |
| Zip archive format | — | **new (Bundle)** |
| Resource **data** export (not just schema) | — | **new** |
| State-snapshot digests + verify on import | — | **new** |

## Integration points for the POC

- **Extend, don't replace** `/api/workspaces/:id/export`. Add a second
  endpoint `/api/workspaces/:id/bundle?mode=definition|migration`
  returning `application/zip`. Keeps the YAML export as a compatibility
  path.
- **Reuse the credential-stripping chain verbatim.** Bundles face the
  same "never ship credentials" problem, solved identically.
- **Materialize adapter content directly.** For POC, `md` adapters are
  file-on-disk already; the bundle's `memory/`, `skills/`, etc. trees
  are just `cp -r` from the adapter's backing dir, plus hashing.
- **Skill extraction ordering.** Existing inline skills in `workspace.yml`
  stay readable; file-based skills (like `fast-improvements-source`'s
  `skill/SKILL.md`) export as-is. The `SkillAdapter` already lists both
  worlds.
- **Import path.** On import, write files into the target space dir,
  verify every hash against the lockfile, then register the space with
  `WorkspaceManager.create()` using the provided `workspace.yml`. State
  snapshots land as the md adapters' backing files; the daemon picks
  them up on next load.

## Alignment with other declaw plans

- **"Workspace-as-cwd containment"** (parity plan) — the bundle, when
  unzipped, **is** the space's cwd. No `~/.atlas/` home dir for
  primitives, consistent with FAST's move to CWD-as-home.
- **Phase 3 FridayHub (registry)** — deferred in the parity plan;
  orthogonal to bundles. Registry layers on top of bundles later; the
  bundle format does not depend on a registry.
- **Tier 6 source modification** — irrelevant. Bundles are about
  sharing spaces; source modification is about FAST modifying its own
  code.

## Decisions (settled 2026-04-20)

1. **Skill layout:** `skills/<name>/` only. No dual-format reader. The
   singular `skill/` convention in `workspaces/fast-improvements-source/`
   migrates to `skills/parity-plan-context/` in the same PR that lands
   the loader.
2. **Jobs:** inline in `workspace.yml` for v1. Extraction to
   `jobs/<name>.yml` is an additive v2 change once space sizes warrant
   it.
3. **State export across backends:** both `md` and `sqlite` work in v1.
   Every backing corpus/store gets `exportSnapshot()` and
   `importSnapshot()` methods on its adapter interface. Bytes are
   adapter-private (md → tar of backing dir; sqlite → raw `.db`). The
   bundle layer records `{backend, digest}` per snapshot in the
   lockfile and routes import to the matching backend. Cross-backend
   migration is out of scope.
4. **Two endpoints.** `/export` (YAML, unchanged) + `/bundle` (zip,
   with `mode=definition|migration` query flag).
5. **Credential wiring post-import:** bundle-import returns a
   `credsNeeded` report; consumer uses the existing
   `POST /workspaces/:id/credentials/import` path. Bundle-import does
   not touch credential storage.

## Test subjects for the POC

- **Milestone 1 (shape proof):** export `fast-improvements-source` as a
  definition-only bundle → import into a fresh dir → fire the
  `run-task` signal → architect → coder → reviewer pipeline runs
  identically to the source space.
- **Milestone 2 (state proof):** add narrative memory entries via the
  `md` memory adapter on the source space → export as
  full-migration → import → memory entries are readable on the target.
