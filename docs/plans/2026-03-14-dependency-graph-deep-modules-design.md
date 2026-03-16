<!-- Consolidated 2026-03-15 — Move 1 complete, Moves 2-4 remain -->

## Problem Statement

The monorepo dependency graph has accumulated structural problems that cause real
breakage and slow development:

1. **Client bundle contamination**: Client code accidentally loads server code
   via barrel imports (e.g., `@atlas/core` barrel pulls `@db/sqlite` FFI),
   crashing at runtime due to missing globals. Vite also tries to preprocess
   entire modules when only types are needed, triggering the same failures.
2. **Shallow module proliferation**: A dozen packages exist with 150–400 lines
   of code, adding indirection without hiding complexity. Understanding a single
   concept often requires bouncing between 5–6 files across packages.
3. **Circular dependencies**: `config ↔ fsm-engine`, `hallucination ↔
   fsm-engine`, `atlasd ↔ mcp-server`, `core ↔ system`, and service apps
   (ledger, link) imported as packages create fragile resolution paths. Several
   indirect cycles (config→fsm-engine→mcp→config,
   config→fsm-engine→skills→config) compound the problem.
4. **No structural enforcement**: Client/server boundaries are maintained by
   convention (CLAUDE.md documentation) and developer knowledge, not by the
   module graph itself.
5. **SDK not publishable**: `@atlas/agent-sdk` depends on `@atlas/ledger` (a
   full service app with Postgres/SQLite/Hono) and `@atlas/logger`, making it
   impossible to open-source as a standalone package.

## Solution

Reorganize the dependency graph around deep module principles (Ousterhout, "A
Philosophy of Software Design"): each package should have a small interface
hiding a large implementation, with strict layering that makes the client/server
boundary structural rather than conventional.

The reorganization has four moves:

1. **Make `@atlas/agent-sdk` a true leaf node** — zero `@atlas/*` dependencies,
   publishable for external agent authors.
2. **Decompose `@atlas/core`** — split into focused domain packages
   (`@atlas/artifacts`, `@atlas/sessions`, `@atlas/mcp-registry`) with
   client-safe barrels and server subpaths. Rename the server-only remainder to
   `@atlas/runtime`. Relocate `SystemAgentAdapter` to atlasd. Provide a
   temporary compatibility barrel for incremental migration.
3. **Consolidate shallow modules** — absorb `hallucination`, `mcp`, and
   `document-store` into `fsm-engine`; absorb `fs-watch` into `signals`; absorb
   `cron` into `workspace`; absorb `oapi-client` into `client`.
4. **Break all circular dependencies** — move shared types to leaf packages,
   restrict service app exports to route types only.

## User Stories

1. As a web-client developer, I want importing `@atlas/artifacts` to be
   structurally incapable of pulling server code, so that barrel imports can't
   crash the client bundle.
2. As an external agent author, I want `@atlas/agent-sdk` to have zero internal
   dependencies, so that I can install it without pulling the entire platform.
3. As a developer navigating the codebase, I want each package to represent a
   coherent domain concept, so that I can understand a feature without bouncing
   between 6 small packages.
4. As a developer adding a new feature, I want the layer structure to tell me
   where code belongs, so that I don't accidentally create circular dependencies.
5. As a CI pipeline, I want architecture tests that fail when client code imports
   server-only packages, so that bundle contamination is caught before merge.
6. As the FSM engine, I want hallucination detection, MCP client management, and
   document persistence to be internal implementation details, so that my
   interface stays small while my capability grows.
7. As the signals package, I want filesystem watching to be an internal
   implementation detail, so that signal providers are self-contained.
8. As the client package, I want the OpenAPI→Hono RPC migration to be an
   internal concern, so that consumers have one import path regardless of
   transport.
9. As a developer, I want zero circular dependencies in the package graph, so
   that build order is deterministic and type checking is reliable.
10. As a developer, I want `@atlas/runtime` to be explicitly server-only with an
    architecture test banning it from client code, so that the boundary is
    machine-enforced.
11. As a developer, I want service apps (ledger, link) to only export route types
    for Hono RPC inference, so that importing a service app's types doesn't pull
    its runtime code.
12. As a developer, I want `@atlas/config` to not depend on `@atlas/fsm-engine`,
    so that the foundation layer has no upward dependencies.
13. As a developer, I want `@atlas/fsm-engine` to be a deep module — hiding
    hallucination detection, MCP client lifecycle, and document persistence
    behind a simple "run FSM, get events" interface.
14. As a developer running tests, I want to import domain types (artifacts,
    sessions) without triggering SQLite FFI loading, so that vitest doesn't crash
    in non-server contexts.
15. As a CI pipeline, I want a workspace-wide architecture test that fails when
    any package imports from a higher layer, so that the layer model is
    machine-enforced across the entire monorepo.

## Implementation Decisions

### Target Layer Architecture

Every package lives at exactly one layer. Packages may only depend on packages
at lower layers. No lateral dependencies within a layer unless explicitly noted.

**Layer 0 — Leaves (zero `@atlas/*` deps)**

| Package | Purpose |
|---------|---------|
| `@atlas/agent-sdk` | Agent contract: types, tool schemas, AI SDK helpers, error types, interfaces for ResourceStorage/CredentialProvider/Logger |
| `@atlas/utils` | Pure utility functions (absorbs `error-helpers` from core) |
| `@atlas/sentry` | Sentry integration |
| `@atlas/analytics` | Client tracking (GA4) |
| `@atlas/ui` | Svelte component library |

**Layer 1 — Foundation (depends only on Layer 0)**

| Package | Deps | Notes |
|---------|------|-------|
| `@atlas/logger` | utils, sentry | |
| `@atlas/config` | agent-sdk | Absorbs `@atlas/schemas/library` re-exports |

**Layer 2 — Domain (depends on Layer 0–1)**

| Package | Deps | Notes |
|---------|------|-------|
| `@atlas/llm` | logger | LLM provider wrappers |
| `@atlas/client` | utils | Absorbs `@atlas/oapi-client`. Type-only deps on atlasd/link/ledger for Hono RPC inference. Current type-only dep on schemas/library resolves once library types move to config |
| `@atlas/artifacts` | logger, utils | **New** — split from core. Client-safe barrel + `./server` subpath |
| `@atlas/sessions` | agent-sdk, utils | **New** — split from core. Client-safe barrel + `./server` subpath |
| `@atlas/mcp-registry` | config, logger | **New** — split from core. Client-safe barrel + `./server` subpath |
| `@atlas/schemas` | config | Workspace blueprint schemas. Kept separate (dependency inversion layer between config and workspace-builder) |
| `@atlas/signals` | logger, utils | Absorbs `@atlas/fs-watch` |
| `@atlas/resources` | activity, artifacts, logger, schemas | Type-only dep on ledger for Hono RPC. `./ledger-client` subpath uses hono RPC |
| `@atlas/skills` | config, logger | |
| `@atlas/activity` | llm, logger, utils | Activity feed: schemas, storage, title generation |

**Layer 3 — Engine (depends on Layer 0–2)**

| Package | Deps | Notes |
|---------|------|-------|
| `@atlas/fsm-engine` | agent-sdk, config, llm, logger, artifacts, sessions, mcp-registry, resources, skills | Absorbs `@atlas/hallucination`, `@atlas/mcp`, `@atlas/document-store`. Config dep comes from absorbed mcp package |
| `@atlas/bundled-agents` | agent-sdk, config, schemas, llm, logger | |
| `@atlas/storage` | config, logger, utils | |
| `@atlas/workspace-builder` | bundled-agents, resources, schemas | Planner pipeline, FSM compiler, workspace assembler |

**Layer 4 — Runtime (depends on Layer 0–3)**

| Package | Deps | Notes |
|---------|------|-------|
| `@atlas/runtime` | agent-sdk, bundled-agents, config, fsm-engine, logger, artifacts, sessions, mcp-registry | **Renamed from `@atlas/core`** — server-only agent execution infrastructure. `SystemAgentAdapter` relocated to atlasd (see Move 2) |
| `@atlas/workspace` | agent-sdk, analytics, config, fsm-engine, llm, logger, resources, signals, storage, utils | Absorbs `@atlas/cron`. Lateral dep on system (noted exception — see below). Type-only dep on ledger |
| `@atlas/mcp-server` | client, llm | Platform MCP server. Type-only dep on atlasd for Hono RPC route types (runtime dep on `getAtlasDaemonUrl` resolved by Move 3's oapi-client→client absorption) |
| `@atlas/system` | agent-sdk, utils, client, config, logger, llm, artifacts, sessions, mcp-registry, resources, schemas, skills, bundled-agents, fsm-engine, runtime, workspace-builder | Type-only deps on ledger, link. Full decomposition is out of scope (see Out of Scope) |

**Lateral dependency exception:** `@atlas/workspace` → `@atlas/system` is a
same-layer (Layer 4) lateral dependency. Workspace uses system for agent type
registration. This is a known exception — eliminating it requires extracting an
agent type registry to a lower layer, which is out of scope for this work.

**Layer 5 — Apps (not importable as packages)**

| Package | Notes |
|---------|-------|
| `@atlas/atlasd` | Main daemon. Depends on everything server-side. Provides `SystemAgentAdapter` (wires system agents into runtime's agent loader) |
| `@atlas/cli` | CLI interface. Depends on client, config, storage |
| `@atlas/web-client` | Web UI. Imports only from Layers 0–2: analytics, artifacts, sessions, client, config, ui, system/agent-types |
| `@atlas/ledger` | Service app. Exports route types only (for Hono RPC) |
| `@atlas/link` | Service app. Exports route types only (for Hono RPC) |

### Move 1: Make `@atlas/agent-sdk` a True Leaf — COMPLETED

Shipped on `dependency-graph` branch. All `@atlas/*` deps removed:
- Internalized `stringifyError` from `@atlas/utils`
- Defined `Logger`/`LogContext` interfaces locally (removed `@atlas/logger`)
- Internalized `ResourceToolkit`, defined `ResourceStorageAdapter` interface locally (removed `@atlas/ledger`)
- Inlined minimal `ArtifactSchema` (removed `@atlas/core/artifacts`)
- Added logger parameter to `extractArtifactRefsFromToolResults` callers
- Architecture test enforces zero `@atlas/*` imports

SDK dependency tree is now: `zod`, `ai` (Vercel AI SDK), `jsonrepair`.

### Move 2: Decompose `@atlas/core`

**`@atlas/artifacts`** — split from `core/src/artifacts/`

```
@atlas/artifacts/
├── mod.ts              — CLIENT-SAFE: types, model, primitives, json-schema, html
├── src/
│   ├── types.ts             — Zod schemas, TypeScript types
│   ├── model.ts             — Artifact model schemas
│   ├── primitives.ts        — Data primitives
│   ├── json-schema.ts       — JSON schema transforms
│   ├── html.ts              — HTML utilities
│   ├── server.ts            — SERVER barrel: storage, adapters, converters
│   ├── storage.ts           — Storage interface + implementation
│   ├── local-adapter.ts     — @db/sqlite adapter
│   ├── cortex-adapter.ts    — Cortex API adapter
│   ├── file-upload.ts       — Chunked upload handling
│   └── converters/          — CSV→SQLite, PDF, DOCX, etc.
└── deno.json exports:
    ".": "./mod.ts"                          ← client-safe
    "./server": "./src/server.ts"            ← server-only
    "./file-upload": "./src/file-upload.ts"
    "./converters": "./src/converters/mod.ts"
```

**`@atlas/sessions`** — split from `core/src/session/` + `core/src/constants/`

```
@atlas/sessions/
├── mod.ts              — CLIENT-SAFE: events, reducer, planned-steps, status constants
├── src/
│   ├── session-events.ts           — Event schemas (Zod)
│   ├── session-reducer.ts          — Pure state reducer
│   ├── planned-steps.ts            — Step tracking types
│   ├── fsm-event-mapper.ts         — FSM→session event mapping
│   ├── event-emission-mapper.ts    — FSM→history event mapping
│   ├── supervisor-status.ts        — Status constants (from core/constants/)
│   ├── server.ts                   — SERVER barrel
│   ├── history-storage.ts          — Persistence layer
│   ├── local-adapter.ts            — File-based storage
│   └── cortex-adapter.ts           — API-based storage
└── deno.json exports:
    ".": "./mod.ts"                  ← client-safe
    "./server": "./src/server.ts"    ← server-only
```

**`@atlas/mcp-registry`** — split from `core/src/mcp-registry/`

```
@atlas/mcp-registry/
├── mod.ts              — CLIENT-SAFE: schemas, requirement-validator
├── src/
│   ├── schemas.ts                  — MCP server config schemas
│   ├── requirement-validator.ts    — Validation logic
│   ├── server.ts                   — SERVER barrel
│   ├── registry-consolidated.ts    — Full registry implementation
│   ├── credential-resolver.ts      — Credential fetching
│   └── storage/                    — Persistence
└── deno.json exports:
    ".": "./mod.ts"                                ← client-safe
    "./server": "./src/server.ts"                  ← server-only
    "./credential-resolver": "./src/credential-resolver.ts"
```

**`@atlas/runtime`** — what remains of `@atlas/core` (all server-only)

```
@atlas/runtime/
├── mod.ts              — AgentOrchestrator, AgentLoader, ChatStorage, streaming
├── src/
│   ├── agent-loader/        — Load agents from registry (adapters: bundled, sdk)
│   ├── agent-conversion/    — Config → agent instances
│   ├── agent-server/        — MCP server hosting for agents
│   ├── orchestrator/        — Route execution, SSE streaming
│   ├── streaming/           — Stream emitter abstractions
│   ├── chat/                — Conversation storage (file-based)
│   ├── kv.ts                — Deno KV polyfill
│   ├── credential-fetcher.ts — JWT credential fetching
│   ├── atlas-config.ts      — URL helpers
│   └── utils/file-lock.ts   — Concurrent file access
```

**Breaking the core ↔ system cycle:**

Today, `core/src/agent-loader/adapters/system-adapter.ts` directly imports
`conversationAgent` and `workspaceChatAgent` from `@atlas/system/agents`,
creating a `core ↔ system` circular dependency. After the split, this would
become `runtime ↔ system`.

Fix: Relocate `SystemAgentAdapter` from runtime to `@atlas/atlasd`. Only atlasd
instantiates `AgentRegistry` with `includeSystemAgents: true` — no other
consumer needs it. Runtime exports the `AgentAdapter` interface; atlasd provides
the system adapter implementation and registers it at startup via
`loader.addAdapter()`. Remove the `includeSystemAgents` constructor option from
`AgentRegistry`.

This is standard dependency inversion: the framework (runtime) defines the
interface, the host app (atlasd) provides the implementation.

**Distributing client-safe stragglers** from the old `@atlas/core`:

| File(s) | New Home | Rationale |
|---------|----------|-----------|
| `utils/error-helpers.ts` | `@atlas/utils` | Pure utility |
| `types/error-causes.ts` | `@atlas/agent-sdk` | Part of agent error contract |
| `types/outline-ref.ts` | `@atlas/agent-sdk` | Schema agents produce |
| `types/legacy.ts` | `@atlas/atlasd` or delete | Legacy re-exports |
| `errors/` (SessionFailedError, UserConfigurationError) | `@atlas/agent-sdk` | Errors agents can throw |
| `library/types.ts` | `@atlas/config` | Library schemas belong with config |

**Compatibility barrel for incremental migration:**

During migration, `@atlas/core` remains as a thin re-export barrel so consumers
can migrate incrementally rather than in one big-bang PR:

```typescript
// packages/core/mod.ts (temporary — remove once all consumers migrate)
export * from "@atlas/artifacts";
export * from "@atlas/sessions";
export * from "@atlas/mcp-registry";
export * from "@atlas/runtime";
```

Subpath exports are similarly forwarded:

```jsonc
// packages/core/deno.json (temporary)
{
  "exports": {
    ".": "./mod.ts",
    "./artifacts": "@atlas/artifacts",
    "./session/session-events": "@atlas/sessions",
    "./session/reducer": "@atlas/sessions",
    "./mcp-registry": "@atlas/mcp-registry",
    "./mcp-registry/server": "@atlas/mcp-registry/server"
    // ... etc
  }
}
```

The workspace-wide architecture test (see Testing Decisions) warns on
`@atlas/core` imports without failing, giving teams time to migrate. Once all
consumers are updated, delete the core package entirely.

### Move 3: Consolidate Shallow Modules

**Absorb into `@atlas/fsm-engine`:**

| Package | LOC | Rationale | Consumer update |
|---------|-----|-----------|-----------------|
| `@atlas/hallucination` | 744 | Hallucination detection is an FSM execution concern. Eliminates hallucination↔fsm-engine cycle. | 4 files change import path |
| `@atlas/mcp` (thin wrapper) | 253 | Ephemeral MCP tool creation only happens during FSM execution. | 5 files change import path |
| `@atlas/document-store` | 532 | Only used for FSM context document persistence. Legacy for non-compiled workspaces. | 3 files change import path |

This makes `@atlas/fsm-engine` ~1500 lines deeper. The interface stays small
(run an FSM, get events) while the implementation grows (LLM orchestration,
hallucination detection, MCP client management, document persistence). Textbook
deep module.

**Absorb into `@atlas/signals`:**

| Package | LOC | Rationale | Consumer update |
|---------|-----|-----------|-----------------|
| `@atlas/fs-watch` | 162 | Both consumers are signal-related. Path utilities (`expandHomePath`) move to `@atlas/utils`. | 2 files change import path |

**Absorb into `@atlas/workspace`:**

| Package | LOC | Rationale | Consumer update |
|---------|-----|-----------|-----------------|
| `@atlas/cron` | 430 | Cron timer management is a workspace scheduling concern. Both deps (storage, workspace) are already workspace deps. | Consumers import from `@atlas/workspace/cron` |

**Absorb into `@atlas/client`:**

| Package | LOC | Rationale | Consumer update |
|---------|-----|-----------|-----------------|
| `@atlas/oapi-client` | ~300 | Consolidate all daemon API clients. Migration from OpenAPI→Hono RPC becomes internal. `getAtlasDaemonUrl()` becomes internal utility. | 36 files change import path for `getAtlasDaemonUrl` |

### Move 4: Break Circular Dependencies

**Cycle: `config → fsm-engine → config`**

- `config` imports FSM types (`Action`, `FSMDefinition`) from `fsm-engine` for
  its mutation API.
- `fsm-engine` imports `MCPServerConfig` from `config`.

Fix: Move `MCPServerConfig` to `@atlas/agent-sdk` (MCP configuration is part of
the agent contract). Move FSM type definitions to `@atlas/schemas` (they're
compiled workspace schema shapes). Both config and fsm-engine import downward
from agent-sdk and schemas.

```
Before:  config → fsm-engine → config               (cycle)
After:   config → schemas, agent-sdk                 (downward)
         fsm-engine → schemas, agent-sdk             (downward)
```

**Cycle: `hallucination ↔ fsm-engine`**

Eliminated by absorbing hallucination into fsm-engine (Move 3).

**Cycle: `atlasd ↔ mcp-server`**

- `atlasd` imports `PlatformMCPServer` from `mcp-server` (runtime).
- `mcp-server` imports `getAtlasDaemonUrl()` from `atlasd` (runtime).

Fix: Eliminated by Move 3. Once `oapi-client` is absorbed into `@atlas/client`,
`mcp-server` imports `getAtlasDaemonUrl` from `@atlas/client` instead of
`@atlas/atlasd`. The remaining direction (atlasd→mcp-server) is fine — apps can
depend on packages.

**Cycle: `core ↔ system` (becomes `runtime ↔ system`)**

- `core/src/agent-loader/adapters/system-adapter.ts` imports agents from
  `@atlas/system/agents`.
- `system` depends on `core` for artifacts, sessions, mcp-registry, etc.

Fix: Eliminated by Move 2. `SystemAgentAdapter` is relocated from runtime to
atlasd (see Move 2 details). Runtime no longer imports from system.

**Indirect cycles through config hub:**

The config↔fsm-engine direct cycle creates several transitive cycles:

- `config → fsm-engine → mcp → config` (3-way)
- `config → fsm-engine → skills → config` (3-way)
- `config → fsm-engine → resources → schemas → config` (4-way)

All are dissolved by breaking the config↔fsm-engine edge (above) and absorbing
mcp into fsm-engine (Move 3).

**Service apps as packages: `ledger`, `link`**

Restrict `deno.json` exports to route type definitions only:

```jsonc
// apps/ledger/deno.json
{
  "exports": {
    "./routes": "./src/routes/index.ts"  // types only
    // no "." export — can't import the full app
  }
}
```

`@atlas/client` uses `import type` from these for Hono RPC inference. A lint
rule or architecture test enforces that these remain type-only imports.

### Client/Server Boundary Enforcement

After reorganization, the web-client's imports are structurally safe:

```
@atlas/web-client imports:
  @atlas/analytics          ← Layer 0, client-safe
  @atlas/ui                 ← Layer 0, client-safe
  @atlas/config             ← Layer 1, client-safe
  @atlas/artifacts          ← Layer 2, client-safe barrel (no ./server)
  @atlas/sessions           ← Layer 2, client-safe barrel (no ./server)
  @atlas/client             ← Layer 2, client-safe
  @atlas/system/agent-types ← Layer 4 subpath, types only
```

No import can transitively reach `@db/sqlite`, `node:fs`, or Deno APIs.

Architecture tests to add in the web-client:

1. **Ban server-only packages**: `@atlas/runtime`, `@atlas/fsm-engine`,
   `@atlas/workspace`, `@atlas/storage`, `@atlas/bundled-agents` must never
   appear in web-client imports.
2. **Ban server subpaths**: `@atlas/artifacts/server`,
   `@atlas/sessions/server`, `@atlas/mcp-registry/server` must never appear.
3. **Enforce type-only service app imports**: Any import from `@atlas/atlasd`,
   `@atlas/ledger`, or `@atlas/link` must use `import type`.

### Package Count

| | Before | After |
|---|---|---|
| Total packages | 28 | 24 |
| Circular dependency cycles | 8 (4 direct, 4 indirect) | 0 |
| Packages with < 300 LOC | 5 | 0 |
| Client-unsafe barrel exports | 4 | 0 |

Packages eliminated:
- `@atlas/core` → split into artifacts, sessions, mcp-registry; remainder
  renamed to runtime; stragglers distributed. Temporary compatibility barrel
  during migration (counts as 1 until removed).
- `@atlas/hallucination` → absorbed into fsm-engine
- `@atlas/mcp` → absorbed into fsm-engine
- `@atlas/document-store` → absorbed into fsm-engine
- `@atlas/fs-watch` → absorbed into signals
- `@atlas/cron` → absorbed into workspace
- `@atlas/oapi-client` → absorbed into client

Packages added:
- `@atlas/artifacts` (split from core)
- `@atlas/sessions` (split from core)
- `@atlas/mcp-registry` (split from core)

Net: 28 - 7 + 3 = 24 packages, plus a temporary core compatibility barrel.

## Testing Decisions

Tests should verify **module boundaries**, not internal wiring. The
reorganization creates natural test boundaries at each package's public
interface.

### Architecture Tests (new)

- **Workspace-wide layer enforcement**: A single test that scans every package's
  source files for `from "@atlas/*"` import statements, determines each
  dependency's layer from a canonical layer map, and verifies all `@atlas/*`
  deps are at lower layers. Scanning actual source imports (not just
  `deno.json`/`package.json` declarations) catches undeclared dependencies that
  would otherwise evade detection — multiple packages today have `@atlas/*`
  imports not declared in their `package.json`. Fails CI on any upward
  dependency. Type-only deps on service apps (atlasd, ledger, link) are allowed
  cross-layer and verified to use `import type`.

  ```typescript
  // packages/architecture/layer-enforcement.test.ts
  const LAYER_MAP: Record<string, number> = {
    "@atlas/agent-sdk": 0,
    "@atlas/utils": 0,
    "@atlas/sentry": 0,
    "@atlas/analytics": 0,
    "@atlas/ui": 0,
    "@atlas/logger": 1,
    "@atlas/config": 1,
    "@atlas/llm": 2,
    "@atlas/client": 2,
    "@atlas/artifacts": 2,
    "@atlas/sessions": 2,
    "@atlas/mcp-registry": 2,
    "@atlas/schemas": 2,
    "@atlas/signals": 2,
    "@atlas/resources": 2,
    "@atlas/skills": 2,
    "@atlas/activity": 2,
    "@atlas/fsm-engine": 3,
    "@atlas/bundled-agents": 3,
    "@atlas/storage": 3,
    "@atlas/workspace-builder": 3,
    "@atlas/runtime": 4,
    "@atlas/workspace": 4,
    "@atlas/mcp-server": 4,
    "@atlas/system": 4,
  };
  ```

- **Web-client import boundaries**: Fail CI if web-client imports from Layer 3+
  or server subpaths. Extends the existing
  `web-client/src/lib/architecture.test.ts` pattern.
- **SDK leaf enforcement**: Fail CI if `@atlas/agent-sdk` imports any `@atlas/*`
  package.
- **Compatibility barrel warnings**: During migration, warn (don't fail) on
  `@atlas/core` imports. After migration deadline, convert to hard failure.

### Migration Testing

Each absorption (hallucination→fsm-engine, mcp→fsm-engine, etc.) should
preserve existing tests by moving them alongside the source files. No test
rewrite needed — only import path updates.

### Prior Art

- `apps/web-client/src/lib/architecture.test.ts` — existing architecture test
  pattern
- `packages/workspace-builder/compiler/build-fsm.test.ts` — pure function
  boundary testing (2200 LOC, zero mocks)
- `apps/link/tests/oauth.test.ts` — integration testing at HTTP boundary (823
  LOC, zero mocks)
- `packages/core/src/artifacts/local-adapter.test.ts` — storage adapter
  boundary testing (1033 LOC, zero mocks)

### Packages with Zero Tests (Existing Gap)

The following packages currently have no tests. This reorganization does not add
tests for them, but notes the gap for future work: `logger`, `cron`, `signals`,
`client`.

## Out of Scope

- **Implementation rewrites**: This is file reorganization + import updates. No
  runtime behavior changes.
- **Finishing the OpenAPI→Hono RPC migration**: The `@atlas/client`
  consolidation absorbs `oapi-client` but does not migrate the remaining 12
  route files. That migration continues as a separate effort, now internal to
  the client package.
- **Adding tests to untested packages**: The reorganization preserves existing
  tests but does not add new ones (except architecture tests).
- **moon/Nx/Turborepo adoption**: The reorganization improves the graph for
  Deno's built-in workspace features. Monorepo orchestration tools are a
  separate decision.
- **Dependency visualization tooling**: The research on `deno info --json` and
  graph rendering is available but building a visualization tool is not part of
  this work.
- **`@atlas/system` decomposition**: System has 17 `@atlas/*` deps
  post-consolidation (spanning Layers 0–4, plus type-only deps on ledger/link)
  and god object agents (conversation.agent.ts is 1117 lines). The layer table
  is honest about its full dependency surface, but decomposition is a deeper
  refactor for a follow-up effort.
- **`@atlas/workspace` dep reduction**: Workspace has 10 `@atlas/*` deps
  post-consolidation plus a lateral dep on system (Layer 4). The dep list is
  honest, but reducing it (e.g., extracting agent type registry from system)
  is a follow-up effort.
- **`@atlas/workspace` → `@atlas/system` lateral dep**: Same-layer dependency
  noted as an exception. Eliminating it requires extracting an agent type
  registry to a lower layer.

## Further Notes

### Execution Order

The moves have dependencies between them. Recommended order:

1. **SDK leaf** (Move 1) — no downstream impact, can ship independently
2. **Consolidate shallow modules** (Move 3) — absorbing oapi-client into client
   unblocks the atlasd↔mcp-server cycle fix in the next step
3. **Break circular deps** (Move 4) — now possible since Move 3 landed
4. **Decompose core** (Move 2) — the big move, but simpler after 1, 3, 4.
   Includes `SystemAgentAdapter` relocation to atlasd. Uses compatibility barrel
   for incremental migration.

Each move can be a separate PR or small PR series. Move 2 is the largest (most
import path changes) but is purely mechanical — no logic changes. The
compatibility barrel enables splitting Move 2 across multiple PRs:

1. PR 1: Create new packages (artifacts, sessions, mcp-registry, runtime) with
   source files. Set up compatibility barrel in core. Relocate
   `SystemAgentAdapter` to atlasd.
2. PR 2–N: Migrate consumers package-by-package from `@atlas/core` to new
   packages.
3. Final PR: Delete `@atlas/core` compatibility barrel. Add hard-fail
   architecture test.

### Open-Source SDK Timeline

Making `@atlas/agent-sdk` a leaf node is prerequisite to open-sourcing. The
actual open-source release (publishing to npm/jsr, documentation, examples) is a
separate effort that can proceed once Move 1 ships.

### Deep Module Philosophy

The guiding principle: a package should have a **small interface hiding a large
implementation**. After this reorganization:

- `@atlas/fsm-engine` — small interface (run FSM, get events), large
  implementation (LLM orchestration, hallucination detection, MCP clients,
  document persistence). ~4000 lines behind a handful of exports.
- `@atlas/artifacts` — small interface (types + schemas in barrel), large
  implementation (storage adapters, converters, parsers behind `./server`
  subpath).
- `@atlas/client` — small interface (typed RPC methods), large implementation
  (OpenAPI fallback, Hono RPC, daemon URL resolution, environment detection).
- `@atlas/signals` — small interface (signal providers), large implementation
  (HTTP, filesystem watching, debouncing, event normalization).

Shallow modules (hallucination, mcp, fs-watch, document-store) become
implementation details of their parent packages, not packages in their own right.

### Dependency Graph Visualization

For ongoing monitoring, a `deno info --json`-based script can generate the
workspace dependency graph. The research in this design doc's companion material
covers the approach: parse root `deno.json` for workspace members, run
`deno info --json` per entry point, extract cross-member edges, output DOT or
Mermaid. This can be added as a `deno task graph` command for developer use.
