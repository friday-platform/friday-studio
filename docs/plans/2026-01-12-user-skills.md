# User Skills

Shipped on branch `eric/planner-graph-prototype`. Workspace-scoped reusable skills that capture user expertise (analysis style, domain knowledge, query patterns) for agents to discover and apply.

## What Changed

### `packages/skills/` — Skills Package

New package providing the full skills stack: Zod schemas, storage interface, two adapters, formatting helper, and the `load_skill` tool factory.

- **`schemas.ts`** — `SkillNameSchema` (kebab-case, 1-64 chars), `CreateSkillInputSchema`, `SkillSchema`, `SkillSummarySchema`. All validation runs through these.
- **`storage.ts`** — `SkillStorageAdapter` interface (CRUD + `getByName` + `list`). Exported as `SkillStorage` via lazy Proxy so adapter creation defers until first call (allows test env setup).
- **`local-adapter.ts`** — SQLite adapter (`@db/sqlite`) for local dev. Single `skills.db` file at `ATLAS_DATA_DIR/skills.db`. UNIQUE constraint on `(workspace_id, name)`.
- **`cortex-adapter.ts`** — Production adapter backed by Cortex object storage. Maps skill CRUD to Cortex HTTP API with metadata-based filtering.
- **`format.ts`** — `formatAvailableSkills()` renders skill summaries as `<available_skills>` XML block for prompt injection.
- **`load-skill-tool.ts`** — `createLoadSkillTool(workspaceId, options?)` factory. Accepts optional `hardcodedSkills` array that takes precedence over workspace lookups. Returns a Vercel AI SDK `tool()`.

### `packages/core/src/agent-context/` — Agent Context Integration

`buildAgentContext` checks `agent.useWorkspaceSkills` flag. When true: lists workspace skills via `SkillStorage.list()`, appends `<available_skills>` to the prompt, and injects a `load_skill` tool (only if one isn't already registered — preserves conversation agent's unified tool).

### `packages/system/agents/skill-distiller/` — Skill Distiller Agent

LLM-powered agent that distills source material (artifacts) into skill definitions. Uses `generateObject` with Claude Sonnet. Saves output as a `skill-draft` artifact for user review before promotion. Supports revision of existing drafts via `draftArtifactId`.

### `packages/system/agents/conversation/tools/create-skill.ts` — Draft Promotion

`create_skill` tool loads a `skill-draft` artifact, validates via `CreateSkillInputSchema`, and writes to `SkillStorage`. Simple promotion — no LLM involved.

### `apps/atlasd/routes/skills.ts` — REST API

CRUD endpoints: `GET /:workspaceId`, `GET /:workspaceId/:name`, `POST /`, `PATCH /:id`, `DELETE /:id`.

### `apps/web-client/` — Skill Draft Renderer

`skill-draft.svelte` component renders draft artifacts with "Pending Approval" badge, skill metadata, and markdown-rendered instructions. Wired into the artifact display router.

### `packages/core/src/artifacts/model.ts` — Artifact Type

Added `skill-draft` artifact type for the draft-then-promote creation flow.

## Key Decisions

**Workspace-only scope.** Skills are scoped to a single workspace via `workspaceId`. Platform-level (org-wide) skills were deferred to keep the model simple.

**Draft-then-promote creation flow.** The skill-distiller agent produces a `skill-draft` artifact, the user reviews it, and only then does `create_skill` promote it to skill storage. This follows the workspace-planner pattern and prevents bad skills from entering the system.

**Agent opt-in via `useWorkspaceSkills` flag.** Not all agents need skills. The flag on the agent definition controls whether `buildAgentContext` fetches and injects them.

**Hardcoded skills coexistence.** The conversation agent has bundled skills (checked first) alongside workspace skills (checked second). The `createLoadSkillTool` factory handles this via the `hardcodedSkills` option. Agent-context won't overwrite an existing `load_skill` tool, so the conversation agent's unified version wins.

**Lazy storage initialization.** `SkillStorage` is a Proxy that defers adapter creation until first method call. This lets tests configure `SKILL_STORAGE_ADAPTER` env var before the adapter is instantiated.

**Adapter selection via `SKILL_STORAGE_ADAPTER` env var.** `"local"` (default, SQLite) or `"cortex"` (production). Factory pattern with two implementations.

## Out of Scope

- **Platform-level skills** — org-wide sharing across workspaces
- **Skill versioning** — change tracking, rollback
- **Skill categories/tags** — filtering by domain
- **Usage analytics** — tracking which skills are loaded
- **Token budget management** — truncation/limits on skills injected into prompts
- **Migration of hardcoded conversation agent skills** to workspace storage (Phase 2)

## Test Coverage

- **`packages/skills/tests/schemas.test.ts`** — Schema validation (valid names, rejection of invalid formats)
- **`packages/skills/tests/format.test.ts`** — `formatAvailableSkills` XML output
- **`packages/skills/tests/local-adapter.test.ts`** — Full CRUD lifecycle, uniqueness constraint, workspace scoping
- **`packages/skills/tests/cortex-adapter.test.ts`** — Cortex adapter operations
- **`packages/skills/tests/storage-factory.test.ts`** — Adapter factory env var selection
- **`packages/system/agents/skill-distiller/skill-distiller.test.ts`** — Distiller agent
- **`packages/system/agents/conversation/tools/create-skill.test.ts`** — Draft promotion
- **`packages/system/agents/conversation/tools/load-skill.test.ts`** — Unified load with hardcoded fallback
- **`packages/core/src/agent-context/agent-context.test.ts`** — Skill injection into agent context
- **`apps/atlasd/routes/skills.test.ts`** — API endpoint integration tests
