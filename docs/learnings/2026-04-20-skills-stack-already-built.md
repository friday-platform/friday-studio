# Skills stack: what's already built (before you reinvent any of it)

Before implementing anything in the skills-scoping / context-inspector / skills.sh / system-skills plan (`docs/plans/2026-04-20-skills-scoping-and-inspector.v4.md`), check what's already in place. Several endpoints and helpers that read like "to-build" items in earlier drafts of the plan exist and work.

## Storage

`packages/skills/src/storage.ts` — `SkillStorageAdapter` interface + `SkillStorage` proxy. Methods you'd otherwise re-add:

- `create(namespace, createdBy)` / `publish(namespace, name, createdBy, input)` / `get(namespace, name)` / `getById(id)` / `getBySkillId(skillId)`.
- `list(namespace?, query?, includeAll?, sort?)` / `listVersions` / `deleteVersion` / `setDisabled` / `deleteSkill`.
- **Assignment operations (live):** `listUnassigned`, `listAssigned(workspaceId)`, `assignSkill(skillId, workspaceId)`, `unassignSkill`, `listAssignments(skillId)`.

Swappable adapter (`LocalSkillAdapter` SQLite vs `CortexSkillAdapter`) via `SKILL_STORAGE_ADAPTER` env var.

## Scope resolution

`packages/skills/src/resolve.ts` — `resolveVisibleSkills(workspaceId, skills)` returns `unassigned ∪ assignedToWorkspace`, dedup by `skillId`.

## HTTP API

`apps/atlasd/routes/skills.ts` — more built than you think:

- Full CRUD + publish (JSON and multipart) + delete + disable.
- **Assignments (already wired):** `POST/GET/DELETE /scoping/:skillId/assignments` — keyed by stable `skillId`, supports 207 partial-success on bulk assigns.
- File-level read/write: `GET/PUT /:namespace/:name/files/*`.
- Archive download: `GET /:namespace/:name?include=archive`.
- Every write endpoint calls `requireUser()` — there's no `createdBy: "system"` bypass today; bootstrap must call `SkillStorage.publish()` directly.

## Frontmatter + parsing

`packages/skills/src/skill-md-parser.ts` — `SkillFrontmatterSchema` already matches the Anthropic Agent Skills spec:

- `description` ≤1024 chars, `noXmlTags` refinement, passthrough via `.catchall(z.unknown())` for unknown keys.
- `allowed-tools` is `z.string()` (comma-separated) — **not an array** — matches agentskills.io.
- Known keys: `name`, `description`, `allowed-tools`, `context`, `agent`, `model`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `license`, `compatibility`, `metadata`.

Reserved word check: `RESERVED_WORDS = ["anthropic", "claude"]` in `packages/config/src/skills.ts`. Bundled system skills publish under **`@friday`** — user-facing surfaces don't mention the internal monorepo name "atlas".

## Link validator

`packages/skills/src/archive.ts` — `validateSkillReferences(instructions, archiveFiles)` returns broken reference paths. Reuse this from the linter rather than rolling your own.

## skills.sh client

`packages/skills/src/skills-sh-client.ts` — `SkillsShClient` class with:

- `search(query, limit)` — Zod-validated, 1-hour TTL cache, sorted by `sortByOfficialPriority`.
- `download(owner, repo, slug)` — sha256 hash returned from skills.sh response.
- `OFFICIAL_ORGS` list (anthropics, vercel, microsoft, google, openai, github, supabase, official) with `isOfficialSource()` helper.

Install route + Browse UI + local audit are the remaining gaps.

## load-skill tool

`packages/skills/src/load-skill-tool.ts` — `createLoadSkillTool({hardcodedSkills?, workspaceId?})`:

- Two-tier resolution: hardcoded → global catalog.
- Defense-in-depth workspace scoping at `:164-169`.
- Archive-extraction cache at `:66-69` (`Map<"ns/name/version", dir>`, session-scoped cleanup) — a good template for the planned lint-result LRU cache.
- Tool `description` composed at `:73-78` from hardcoded skill IDs; **not filter-aware** — v4 plan changes this.

## First-run bootstrap precedent

`packages/workspace/src/first-run-bootstrap.ts` — `ensureDefaultUserWorkspace(manager)`. Check, write template, register. Mirror its shape for `ensureSystemSkills()`.

## MessageMetadata + data events

`packages/agent-sdk/src/messages.ts`:

- `MessageMetadataSchema` carries `agentId`, `sessionId`, `provider`, `modelId`, timestamps. **`jobName` added 2026-04-20** for Context tab wiring.
- `AtlasDataEventSchemas` — existing events: `tool-progress`, `skill-write`, `skill-rollback`, etc. **`skill-lint-warning` added 2026-04-20** for load-time linter signals.

## Playground

- **Chat inspector** (the Cmd+Shift+D drawer): `tools/agent-playground/src/lib/components/chat/chat-inspector.svelte` + `tools/agent-playground/src/lib/inspector-state.svelte.ts`. Existing tabs: Waterfall, Timeline.
- **Standalone session inspector** at `/inspector/` is a different surface — out of scope for the Context-tab work.
- **Skills page** at `tools/agent-playground/src/routes/platform/[workspaceId]/skills/+page.svelte` — currently read-only list with a literal "Assign skills or collections via the API" empty state.
- **Client queries** at `tools/agent-playground/src/lib/queries/skill-queries.ts`: `catalog()`, `detail`, `files`, `fileContent`, `workspaceSkills`. Assignment mutations are the gap.

## Related existing agents

- `packages/system/agents/skill-distiller/` — LLM-powered distillation from source artifacts. Use for the system-skill creating-* workflow; don't hand-write those.
- `packages/system/agents/fsm-workspace-creator/` — existing workspace-authoring expert; source material for `@atlas/creating-workspaces`.

## Key takeaways

1. **Assignment API is done** — wire the UI; don't build a new endpoint.
2. **skills.sh client is done** — build the install route + UI on top of it; don't re-implement HTTP or caching.
3. **Frontmatter schema is spec-compliant** — extend via passthrough, don't rewrite.
4. **Bootstrap uses direct `SkillStorage.publish()`** with a `SYSTEM_USER_ID` marker, not a fake session. HTTP routes stay auth-gated.
5. **`@friday` is the user-facing bundled namespace.** The internal monorepo name is "atlas" — that stays internal (package names `@atlas/skills`, daemon `atlasd`, …) but anything a user sees (skill picker, chat badges, fork prompts) says "Friday". `anthropic` / `claude` are the only hard-reserved substrings in the namespace validator.
