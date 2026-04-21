# Workspace Bundles — Portable, Verifiable Workspaces

## Problem Statement

Today a workspace is a single `workspace.yml` file with skills, agents, and
jobs defined inline. This makes workspaces hard to move, hard to share, and
hard to reproduce.

There are two weak modes of sharing today: sharing a **skill** (an ingredient
— a file you paste into a workspace), and sharing a **workspace export** (a
loose recipe — similar to n8n). Neither gives a **guaranteed, repeatable
outcome**: a recipient on another Atlas instance cannot receive a workspace
and be confident they are running the same thing the author was running —
same primitives, same state, same integrity, no surprises.

The goal of this design is to make a workspace movable **1:1 between Atlas
instances**, including its memory and history, so that someone can pick up
exactly where their teammate left off. Publishing a workspace as shareable IP
is the same mechanism with runtime state stripped. Both modes produce a
single self-contained zip artifact.

As a workspace author, I want to hand someone a self-contained bundle that
represents my workspace — skills, agents, jobs, models, communicators,
resources, and optionally memory and history — so they can install it on
their Atlas instance and run it exactly as I was running it. As a publisher
sharing IP, I want the same mechanism to produce a cleaner artifact that
strips runtime state but keeps every definitional piece. As a security
reviewer, I want every primitive in the bundle hashed and recorded in a
lockfile so tampering is detectable.

## Solution

Treat a workspace as a **bundle**: a zip containing a human-readable
directory layout with a `workspace.yml` composition manifest, a
`workspace.lock` integrity lockfile, and subdirectories for each kind of
content the workspace owns.

Bundles come in two modes, selected by an export flag:

- **Definition-only** (default, for sharing IP). Skills, agents, jobs,
  model configs, communicators, resource schemas, platform config, metadata.
  No runtime state.
- **Full migration** (for moving a workspace 1:1 between instances). The
  above plus memory, resource data, and optionally execution history and
  chat transcripts.

Within the bundle, skills and agents are **content-addressed primitives**,
identified by `sha256` of a normalized file manifest. The lockfile pins
every primitive's hash and every state-snapshot digest so the consumer can
verify on import that nothing was tampered with.

Primitives are materialized **directly inside the workspace directory** —
no global cache, no override layer. Editing a primitive is editing a file;
the daemon re-hashes on save and updates the lockfile. "What you see in the
workspace dir is what you get" replaces the fork/unfork ceremony from
earlier drafts.

Cross-workspace dedup via a machine-wide primitive cache is **deferred to
v2**. The bundle format is stable under a future cache addition: the cache
is purely an optimization layered underneath the workspace loader.

Jobs, model configs, and communicators remain workspace-scoped compositions
— they are not packaged as standalone primitives. Bundled "atlas" agents
(like `slack`) also remain platform-provided: the daemon ships them,
bundles only reference them by id and daemon version range.

External skill references (pulled from remote sources at author time) are
**resolved at export**: the skill content is materialized into the bundle.
Bundles are always self-contained; import never requires network access.

## User Stories

### Authoring a bundle

1. As a workspace author, I want to build a workspace from files (skills
   and agents as separate file trees, not inline YAML), so that I can
   organize and edit my workspace like a normal project.
2. As a workspace author, I want to publish my workspace as a zip bundle
   with one command, so that I can hand it to a colleague or customer.
3. As a workspace author, I want the bundle to be human-readable when
   unzipped (flat directory layout, named primitives), so that reviewers
   can inspect what they are about to install.
4. As a workspace author, I want primitives referenced by stable labels
   like `@acme/linear-details@3`, so that my deps are legible and diffable
   in git.
5. As a workspace author, I want multi-file primitives (a skill is a
   directory with a main file plus scripts, templates, assets) to travel
   as a unit.
6. As a workspace author, I want externally-referenced skills to be
   materialized into the bundle at export time, so that the resulting zip
   is self-contained and the consumer never needs network access to import.
7. As a workspace author, I want `workspace.lock` to live alongside
   `workspace.yml` and be committable to git, so that collaborators who
   clone my repo reproduce the exact same primitive set.

### Moving a workspace 1:1 (full-migration mode)

8. As a workspace author, I want to include my workspace's memory in the
   bundle, so that a teammate can pick up exactly where I left off.
9. As a workspace author, I want to include resource data (document
   contents) in the bundle, so that the workspace arrives with its state,
   not just its schema.
10. As a workspace author, I want to optionally include execution history
    and chat transcripts, so that migration to a new instance preserves
    context.
11. As a workspace author, I want to include model configs and
    communicators in the bundle, so that the recipient's workspace
    behaves identically end-to-end.
12. As a workspace author, I want to choose between a definition-only
    publish (for sharing IP) and a full migration (for moving instances),
    so that I pick the right artifact for the use case.

### Consuming a bundle

13. As a workspace consumer, I want to import a bundle zip with one
    command, so that I can run someone else's workspace without manual
    setup.
14. As a workspace consumer, I want the import step to verify integrity
    (hashes match declared values), so that I know the zip wasn't
    tampered with.
15. As a workspace consumer, I want a clear report of credentials I need
    to wire up after import, so that I know what's missing before I try
    to run a job.
16. As a workspace consumer inspecting a received bundle before installing,
    I want to see standard metadata (author, tags, description, license,
    homepage) at both the workspace and primitive level, so that I can
    assess provenance and fit at a glance.

### Security and platform

17. As a security reviewer, I want every primitive in a bundle to be
    hashed and those hashes recorded in the lockfile, so that I can verify
    the bundle contents haven't changed since it was packaged.
18. As a platform operator, I want bundles to declare required daemon
    version ranges, required bundled atlas agents (with ranges), and
    required model providers, so that importing against an incompatible
    instance fails clearly.

### Publishing discipline

19. As a bundle publisher, I want to set standard metadata (author, tags,
    license, homepage) in `workspace.yml` and in each primitive's source,
    so that consumers have the context they need without contacting me
    out-of-band.
20. As a bundle publisher, I want `atlas bundle` to enforce a workspace
    version bump between publishes, so that I don't accidentally ship
    two distinct artifacts under the same version string.
21. As a primitive author, I want editing any metadata field to produce a
    new primitive hash (and thus a new publishable version), so that the
    hash remains a complete fingerprint of what someone is running.

### Migration from today

22. As a user migrating from today's inline model, I want inline skills
    and agents in `workspace.yml` to continue working during transition,
    so that my existing workspaces don't break on daemon upgrade.

## Implementation Decisions

### System model

- **Two classes of entity.**
  - *Primitives* (skills, agents): content-addressed packages.
  - *Compositions* (workspaces, jobs, model configs, communicators, resource
    schemas, platform config): not packaged; live in the workspace
    manifest and travel with it.

- **Runtime state** (memory, resource data, execution history) travels with
  the bundle in full-migration mode. It is **not part of any primitive
  hash**. State lives in distinct directories inside the bundle
  (`memory/`, `resources/<slug>/data.ndjson`, `history/`) and is pinned in
  the lockfile by opaque content digests.

- **State export goes through the adapter.** Every backing corpus / store
  that needs to travel in migration-mode bundles implements a
  `Snapshottable` contract in `@atlas/agent-sdk`:

  ```ts
  export interface Snapshottable {
    /** Stable backend id pinned into workspace.lock; routes import
     *  back to a compatible implementation on the receiving daemon. */
    readonly backendId: string;
    /** Full content of this corpus/store as opaque bytes.
     *  Format is owned by the backend; no guarantees about contents. */
    exportSnapshot(): Promise<Uint8Array>;
    /** Replace current content with the given snapshot. Bytes produced
     *  by exportSnapshot() of the same backendId must round-trip. */
    importSnapshot(bytes: Uint8Array): Promise<void>;
  }
  ```

  The v1 bundle scope: **MemoryAdapter corpora** implement
  `Snapshottable`. Skills are primitives (read directly from
  `skills/<name>/` by the bundle layer — no snapshot needed). Scratchpad
  is session-scoped and excluded from migration. Resource data travels
  as NDJSON via the existing ledger path, not via this interface.

  **Concrete backend ids:**
  - `md-narrative` (`packages/adapters-md/src/md-narrative-corpus.ts`) —
    bytes = tar of backing directory.
  - `sqlite-kv` (`packages/agent-sdk/src/backends/sqlite-kv-corpus.ts`) —
    bytes = raw `.db` file contents.
  - `sqlite-dedup` (`…/sqlite-dedup-corpus.ts`) — bytes = raw `.db`.
  - `sqlite-rag` (`…/backends/sqlite-rag/`) — bytes = raw `.db`.

  The bundle layer is format-agnostic: it records
  `{backend, digest: "sha256:<hex>"}` per snapshot in the lockfile.
  Import verifies (a) the receiving daemon has that backend available,
  and (b) the digest matches the snapshot bytes, before calling
  `adapter.importSnapshot()`. Cross-backend migration (e.g. `md-narrative`
  → `sqlite-narrative`) is out of scope — a separate migration tool if
  demand ever surfaces.

- **Platform primitives** (bundled atlas agents like `slack`): shipped with
  the daemon, referenced by id and daemon version range; never packaged.

- **Identity = content hash.** A primitive's identity is `sha256` of a
  canonical manifest of its directory. Labels like `@acme/linear-details@3`
  are human display metadata carried alongside the hash.

- **Hashing algorithm.**
  1. Walk the primitive directory, list all tracked files sorted by lexical
     path.
  2. For each file, compute `sha256` of its LF-normalized bytes.
  3. Build a newline-delimited text manifest: `<path> sha256:<hex>` per line.
  4. The primitive hash is `sha256` of that manifest.
  - Format-agnostic, inspectable, supports future file-level dedup.
  - Excluded from the manifest by convention: `.DS_Store`, `.git/`, `*.tmp`,
    entries matching an optional `.atlas-ignore` glob. Hidden files are
    included unless explicitly excluded.

- **Cross-primitive references are shallow.** An agent references skills by
  name, not by hash. Its own hash depends only on its own content. Pinning
  of the full transitive dependency tree happens at the composition layer,
  in `workspace.lock`. (Same split as npm `package.json` / `package-lock`.)

### Bundle format

- **Directory layout** (authoring-oriented, human-readable; identical
  whether zipped or unpacked):
  - `workspace.yml` — composition manifest. **Jobs stay inline in this
    file for v1.** Extraction to `jobs/<name>.yml` is an additive v2
    path once spaces hit the "my workspace.yml is too big" threshold.
  - `workspace.lock` — integrity lockfile.
  - `skills/<name>/` — one subdirectory per skill primitive. This is the
    only supported layout; the singular `skill/` convention used today
    in `workspaces/fast-improvements-source/` migrates to
    `skills/parity-plan-context/` in the same PR that lands the loader.
  - `agents/<name>/` — one subdirectory or file per agent primitive.
  - `resources/<slug>/schema.yml` — document schema.
  - `config.yml` — optional platform settings.
  - **Full-migration only:**
    - `resources/<slug>/data.ndjson` — document contents.
    - `memory/<corpus>/snapshot.bin` — per-corpus snapshot bytes, format
      owned by the backend that produced them.
    - `history/` — execution history and chat transcripts (optional within
      full-migration mode; `--with-history` opts in).

- **Two files serve two distinct roles.** `workspace.yml` is authored (job
  definitions, declared deps by label, model configs, communicators,
  resource schemas, platform deps, metadata). `workspace.lock` is derived
  (per-primitive hashes, state-snapshot digests, schema version).

- **Lockfile schema (v1).** Concrete YAML shape:

  ```yaml
  schemaVersion: 1
  mode: definition            # or: migration
  workspace:
    name: fast-improvements-source
    version: 1.2.0
  platformDeps:
    daemon: ">=1.0.0"
    atlasAgents:
      slack: ">=1.0.0"
    modelProviders: [anthropic, openai]
  primitives:
    skills:
      "@tempest/parity-plan-context":
        hash: sha256:abc123...
        path: skills/parity-plan-context
    agents: {}
  snapshots:                  # present only when mode: migration
    memory:
      dispatch-log:
        backend: md-narrative
        digest: sha256:def456...
        path: memory/dispatch-log/snapshot.bin
      autopilot-backlog:
        backend: md-narrative
        digest: sha256:ghi789...
        path: memory/autopilot-backlog/snapshot.bin
      processed-tickets:
        backend: sqlite-dedup
        digest: sha256:jkl012...
        path: memory/processed-tickets/snapshot.bin
    resources:
      leads:
        digest: sha256:mno345...
        path: resources/leads/data.ndjson
    history: null             # or an object when --with-history
  ```

  `primitives.*.hash` is the canonical directory hash produced by the
  Hasher. `snapshots.*.digest` is `sha256` of the opaque snapshot bytes
  produced by the matching backend. `snapshots.*.backend` pins the
  backend implementation that produced the bytes — import refuses when
  the receiving daemon doesn't have that backend available.

- **Two export modes.** The default is definition-only. Opt in to state
  inclusion explicitly (`--with-state`, `--with-history`). Rationale: state
  may contain PII and proprietary content; opt-in is the safe default even
  when the intent is migration.

- **Credentials are never in bundles.** Only credential references (provider
  and key name) appear in exported files. Bundle import returns a
  `credsNeeded: [{provider, keyName, path}]` array in its response; the
  consumer wires creds through the existing
  `POST /workspaces/:id/credentials/import` path. Bundle import does not
  touch credential storage — separation of concerns.

- **API surface: two endpoints, not one.**
  - `GET /api/workspaces/:id/export` — existing single-file YAML export;
    kept unchanged as a compatibility path.
  - `GET /api/workspaces/:id/bundle?mode=definition|migration` — new
    endpoint returning `application/zip`. Migration mode additionally
    accepts `--with-history` semantics as a query flag.

  Different content types, different error surfaces, different tests.
  One endpoint with a format param would mix concerns.

- **Platform deps are declared explicitly.** `workspace.yml` names required
  daemon version ranges, required bundled atlas agents (with version
  ranges), and required model providers. Import fails if the receiving
  instance can't satisfy them.

### Local machine layout

- **Workspace dir is authoritative.** It holds `workspace.yml`,
  `workspace.lock`, and the materialized `skills/`, `agents/`, `jobs/`,
  `resources/` trees. Imported workspaces also have `memory/` and optionally
  `history/`.
- **No global cache, no overrides layer.** Primitives live directly inside
  the workspace dir. Editing a primitive is editing its file; the daemon
  re-hashes on save and updates `workspace.lock`.
- **Resolution is trivial.** A primitive lookup is `./skills/<name>/` or
  `./agents/<name>/`. There is no priority logic, no cache fallback.
- **State lives where Friday already stores it.** `memory/` and
  `resources/*/data.ndjson` in the bundle are serialization formats; on
  import they populate the receiving instance's regular storage (same
  tables, same RLS). The workspace dir does not become a live database —
  it just carries the snapshot.

### Editing primitives

- Editing a primitive in place updates its content and its hash;
  `workspace.lock` updates on save.
- There is no separate fork concept. The workspace dir is authoritative.
- When publishing a bundle derived from another bundle, the author may
  rename primitives before publish to avoid label collisions with the
  original. `atlas bundle` auto-suggests names in the user's configured
  namespace (`atlas config set user.namespace @odk`), which the user can
  accept in one keystroke or override. This is a publish-time rename, not
  a runtime ceremony.

### Metadata schema

Standard descriptive fields for sharing. Two levels carry metadata; the
distinction matters for hash semantics.

- **Workspace bundle metadata** lives in `workspace.yml`. It describes the
  bundle as a whole, is mutable between publishes, and does not
  participate in any primitive hash.
- **Primitive metadata** lives in the primitive's own source (YAML
  frontmatter in `skill.md`, a top-level block in `agent.yml`). It is part
  of the primitive's file content, therefore part of the primitive hash.
  Editing any metadata field on a published primitive produces a new hash
  and thus a new publishable version — same immutability discipline as a
  published npm package.

**Fields** (same shape at both levels unless noted):

- `name`: already present at both levels (workspace name; primitive label).
- `version`: freeform string. Workspace-level publish enforces a bump.
  Primitive-level version is the segment of the label.
- `description`: short human description. Already required on skills.
- `author`: optional, structured — `name`, optional `email`, optional
  `url`. Distinct from namespace: namespace encodes the publishing org;
  `author` can name the individual.
- `tags`: array of kebab-case strings, 0–10 entries. Descriptive only;
  not used for resolution.
- `license`: optional SPDX identifier. No enforcement; informational.
- `homepage`, `repository`: optional URLs.

**Non-behaviors (explicit).** Metadata is descriptive. It is never input to
dependency resolution, version-range matching, or pinning decisions. No
"require author X" or "version ≥ Y" logic anywhere in the resolver.

**Workspace version bump enforcement.** `atlas bundle` refuses to produce a
bundle whose workspace `version` equals the version of the last
successfully produced bundle for the same workspace (tracked in a small
local state file alongside the lockfile). Override with
`--allow-unchanged-version` for explicitly-idempotent dry runs.

### Module Boundaries

Four modules. Each has a narrow interface hiding non-trivial implementation.

#### Hasher
- **Interface:** given a primitive directory path, return a hash plus a
  manifest plus the file list. Also hashes state snapshots (memory,
  resource data, history) as opaque blobs for lockfile entries.
- **Hides:** filesystem walking, LF normalization, exclusion rules,
  manifest construction, hash chaining.
- **Trust contract:** identical directory contents (by inclusion rules)
  always produce identical output, regardless of filesystem, OS, or editor.
- **Why separate:** reused by validators, pre-commit hooks, CI checks,
  and tests without pulling in any storage layer.

#### Lockfile
- **Interface:** typed read and write of the lockfile format; typed
  getters and setters for primitive pins and state-snapshot digests.
- **Hides:** YAML schema version, per-entry field layout (sha256, path,
  cross-primitive wiring, state-snapshot digests, metadata), schema
  evolution logic.
- **Trust contract:** this is the only module that parses or produces
  lockfile YAML. All other modules consume typed `LockFile` objects.

#### Workspace loader
- **Interface:** load a workspace by directory path, returning a validated
  workspace object with the lockfile attached and a map of which state
  snapshots are present.
- **Hides:** coexistence of inline and file-based primitive definitions
  during migration, lockfile-against-manifest consistency checks,
  schema validation.
- **Trust contract:** a returned workspace object is fully validated; its
  declared deps and lockfile pins are mutually consistent; state
  snapshots referenced in the lockfile match on-disk digests.

#### Bundle
- **Interface:** export a workspace to a zip path (with mode flags:
  definition-only | with-state | with-history); import a zip into a target
  workspace directory, returning a report (installed primitives,
  materialized state, missing creds, platform mismatches).
- **Hides:** zip format details, integrity verification on import
  (sha256 checks against lockfile for both primitives and state digests),
  staging directory management, state-snapshot deserialization into the
  receiving instance's storage, credential-ref rewriting.
- **Trust contract:** import is atomic — either the workspace is fully
  installed, all primitives on disk, all state imported into storage, or
  nothing persists.

### Data isolation

The workspace directory is filesystem-level state owned by the user
running the daemon. No new RLS policies are needed for on-disk layout.

Memory, resource data, and history imported from a bundle populate the
receiving instance's workspace-scoped storage, which is already covered
by existing RLS rules (memory and resources are workspace-scoped; there
is no cross-user access path introduced by this feature).

Import enforces that state-snapshot format matches the receiving daemon's
storage schema version; mismatch fails import with a clear message rather
than writing partial or malformed state.

Because there is no machine-wide cache in v1, there is no shared
primitive store to isolate between users of the same machine. A future
cache addition will need to revisit this.

## Testing Decisions

Good tests verify externally observable behavior: given a bundle, what does
the workspace look like after import? Given a full-migration bundle, does
the receiving workspace have the same memory and resource data? They do
not assert on internal helper calls, cache layout details (there is no
cache), or YAML field ordering beyond what's specified.

Modules to test:

- **Hasher.** Property tests: reordering files on disk (same set) produces
  the same hash. Changing one byte in one file changes the primitive hash.
  LF vs CRLF in text files produces the same hash. Excluded files have no
  effect. Multi-file primitives hash stably across runs.

- **Lockfile.** Schema parsing accepts valid lockfiles, rejects invalid
  ones with clear errors. Round-trip (read → write) is stable.
  Schema-version upgrades produce equivalent pinned state. State-snapshot
  digests are independent of primitive hashes.

- **Workspace loader.** A workspace dir with manifest + lockfile loads to a
  validated object. Inconsistencies between manifest and lockfile surface
  as specific errors. Inline primitives (transitional) continue to load.
  A workspace with state snapshots surfaces them as present; missing
  snapshots referenced in the lockfile fail load cleanly.

- **Bundle.** Round-trip: export a workspace in each mode, import into a
  fresh dir, result is functionally identical. Tampered zip (hash
  mismatch) fails import cleanly with no partial state. Cred refs are
  stripped of resolved values in export, preserved as refs. Full-migration
  round-trip preserves memory and resource data byte-for-byte. A
  definition-only bundle produces the same workspace (modulo state) on
  both author and consumer machines.

- **Metadata.** Schema validation accepts well-formed fields (structured
  author, bounded tag list, SPDX-shaped license) and rejects malformed
  input with specific errors. Editing a primitive's metadata produces a
  different primitive hash than the unedited source. Workspace-level
  metadata changes do not affect any primitive hash. `atlas bundle` fails
  when the workspace `version` has not been bumped since the last publish,
  and succeeds once it has (or when `--allow-unchanged-version` is
  passed).

- **External skill materialization.** A workspace referencing a skill from
  a remote source exports a bundle in which that skill is present as a
  local directory under `skills/`, with a matching lockfile pin. Import of
  the resulting bundle does not attempt network access.

Prior art for these test styles: the existing export test in
`apps/atlasd/routes/workspaces/export.test.ts` for integration-style
input-to-output assertions; `packages/config` test suites for schema
validation patterns; `packages/storage` test suites for filesystem-backed
store semantics.

## Out of Scope

- **Central package registry.** No server, no search, no publish to a
  remote index. Bundles travel out-of-band (file transfer, URL fetch,
  signed S3, whatever). A registry could be added later layered on this
  design without changing the on-disk formats.
- **Cryptographic signing.** Hashes provide tamper detection relative to
  the lockfile, but the lockfile itself is not signed. Authenticity of a
  bundle's origin is out of scope; detached signatures over the lockfile
  can be added later.
- **Machine-wide primitive cache (v2).** Cross-workspace dedup via a
  `~/.atlas/primitives/` content-addressed store is deferred. The bundle
  format is stable under a future cache addition: the cache becomes an
  optimization layered underneath the workspace loader, changing nothing
  about what a bundle looks like. Multi-user machine isolation for that
  future cache is a v2 concern.
- **Semver ranges for primitives.** Deps are pinned to exact versions by
  hash. No range resolution, no "upgrade to latest compatible" logic.
  Upgrades are explicit: receive a new bundle, import.
- **Semantic YAML canonicalization.** Hashing normalizes line endings
  only; it does not reformat YAML. Authors committing to stable hashes
  across editors should use consistent formatting.
- **Migration tooling for inline-primitive workspaces.** Both forms work
  during transition; explicit migration commands are deferred.
- **Shareable jobs as packages.** Jobs remain workspace-scoped
  compositions. Shareable job templates are an additive change on top of
  this design.
- **Metadata-driven resolution.** Tags, author, license, version strings,
  and all other metadata fields are descriptive. Nothing in the workspace
  loader, bundle import, or integrity check reads them to make decisions.
- **Import conflict resolution semantics.** When a user imports a bundle
  into a directory or workspace registry that already has conflicting
  state, the exact policy (overwrite, merge, refuse) is an implementation
  detail to settle during build-out, not in the design.
- **Fine-grained history selection.** Full-migration export either
  includes history wholesale (`--with-history`) or excludes it. Selecting
  subsets (e.g., "last 30 days of chat transcripts") is a later concern.

## Further Notes

- **Scope of the artifact** (from feedback): a bundle should encapsulate
  anything a user manages inside a workspace. Skills, agents, jobs for
  sure; memory, models, communicators as well. Communicators are distinct
  from agents — see `docs/plans/2026-03-31-chat-sdk-per-workspace.md` for
  the per-workspace chat feature. All of these travel inside the bundle.
- **FAST alignment.** FAST is moving the atlas home directory into CWD.
  That effort lines up with "workspace dir is authoritative": once home
  is CWD, importing a bundle into a fresh CWD is indistinguishable from
  cloning a FAST setup. The two efforts should stay coordinated so the
  on-disk conventions converge.
- **The positioning.** Sharing skills is sharing an ingredient. Sharing a
  workspace YAML as it exists today is sharing a loose recipe
  (n8n-shaped). Bundles are about sharing a guaranteed, repeatable
  outcome — the full thing the author was running, hash-verified and
  optionally state-complete. That framing matters when deciding what
  belongs in the artifact.
- **The analogy stack.** `workspace.yml` is to `deno.json` as
  `workspace.lock` is to `deno.lock`. Identity by content hash is
  Nix-like; authoring UX is npm-like. Full-migration mode resembles a
  database dump bundled alongside the schema — pg_dump philosophy applied
  to a workspace.
- **Credentials are already correct in today's export flow** (refs only,
  provider-based, no resolved values). This design inherits that
  behavior; the main addition is a structured post-import report so the
  consumer knows what to wire up.
- **Skills already have a numeric version field.** This design keeps that
  field as part of the human label. Agents gain the same label
  convention. Neither is semver.
