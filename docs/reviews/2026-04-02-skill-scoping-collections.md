# Review: feat/skill-scoping-collections

**Date:** 2026-04-02
**Branch:** feat/skill-scoping-collections
**Verdict:** Needs Work

## Summary

Replaces workspace.yml-based skill binding (inline + global refs) with database-backed skill scoping: visibility (global/scoped), direct assignments, and nested collections. The core architecture is sound — resolve.ts is clean, collection cycle detection is correct, and schema design is reasonable. However, write routes lack auth, error handling silently swallows failures, there's an N+1 query pattern on the agent startup critical path, and the new feature has zero test coverage for its core behavior.

## Critical

### 1. Silent error swallowing in resolveVisibleSkills
**Location:** `packages/skills/src/resolve.ts:21-22`
**Problem:** If `listGlobal()` or `listAssigned()` fails (DB corruption, schema mismatch), the workspace gets an empty skill list with zero indication. An agent silently loses all skills and produces garbage. This is the kind of failure that's invisible for days.
**Recommendation:** At minimum log when falling back to empty. Better: propagate error if all sources fail, only degrade gracefully when at least one succeeds.
**Worth doing: Yes — silent data loss on the critical path is a production risk.**

### 2. N+1 query pattern in agent-context eager resolution
**Location:** `packages/core/src/agent-context/index.ts:120-135`
**Problem:** For each visible skill, two DB queries: `getAssignment()` + `get()`. With 20 skills that's 40 queries per session start on the critical path. The `resolveVisibleSkills` function already knows which skills are assigned — that data should flow through rather than being re-queried.
**Recommendation:** Either propagate assignment data (including pinnedVersion) through the summary type, or add a batch `getAssignments(skillIds, workspaceId)` method.
**Worth doing: Yes — directly impacts agent startup latency, cost scales with skill count.**

### 3. Zero test coverage for the core new feature
**Location:** Multiple new files
**Problem:** 291 lines of collection-adapter, 48 lines of resolve.ts, 160 lines of new local-adapter methods, scoped visibility enforcement in load-skill-tool — all untested. The modified load-skill-tool test mocks `getVisibility` to always return "global", meaning the scoped path (the entire point of this PR) is never exercised. Tests were deleted for replaced code but replacement code has no tests.
**Recommendation:** Before merge, add tests for: (1) resolveVisibleSkills with mock adapters covering dedup, error handling, collections undefined; (2) load-skill-tool scoped visibility branch; (3) collection-adapter cycle detection and recursive resolution against real SQLite; (4) local-adapter new methods round-trips.
**Worth doing: Yes — shipping untested graph algorithms and visibility enforcement is risky.**

## Important

### 4. Double-fetch in resolveGlobalSkill
**Location:** `packages/skills/src/load-skill-tool.ts:148,170`
**Problem:** First `SkillStorage.get(namespace, skillName)` to look up skillId, then again with `pinnedVersion`. When there's no pinned version, this fetches the same row twice including the archive blob.
**Recommendation:** Reuse the first result when `pinnedVersion` is undefined.
**Worth doing: Yes — easy win, avoids redundant archive blob fetch.**

### 5. Duplicated visibility logic between load-skill-tool and resolveVisibleSkills
**Location:** `packages/skills/src/load-skill-tool.ts:145-167`
**Problem:** The visibility check manually reimplements what resolveVisibleSkills handles: get skillId, check visibility, check assignments. Two code paths must stay in sync. If a new visibility mechanism (e.g. collection-based) is added, both places need updating.
**Recommendation:** Have resolveGlobalSkill delegate to resolveVisibleSkills (or a lightweight variant) rather than reimplementing.
**Worth doing: Yes — maintaining two visibility code paths will cause drift. Cost of fixing is moderate.**

### 6. getCollectionStorage throws on Cortex adapter
**Location:** `packages/skills/src/storage.ts:96-98`
**Problem:** `getCollectionStorage()` throws if adapter isn't `LocalSkillAdapter`. Agent-context calls it unconditionally when `useWorkspaceSkills` is true. If Cortex is enabled, every agent session crashes.
**Recommendation:** The `collections` param in `resolveVisibleSkills` is already optional. Pass `undefined` when on Cortex instead of throwing.
**Worth doing: Yes — small fix prevents a hard crash on a different adapter config.**

### 7. Missing DB indexes for workspace-scoped queries
**Location:** `packages/skills/src/local-adapter.ts` (schema)
**Problem:** `listAssigned(workspaceId)` filters `skill_assignments` by `workspace_id`, but PK is `(skill_id, workspace_id)` — SQLite indexes by skill_id first, so workspace_id-only queries do a full scan. Same for `workspace_collection_assignments`.
**Recommendation:** Add `CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace ON skill_assignments(workspace_id)` and similar for workspace_collection_assignments.
**Worth doing: Yes — small schema addition, prevents table scans as data grows.**

## Tests

**Verdict: Missing.** The PR deletes ~190 lines of tests for removed code (justified) but adds zero tests for ~500+ lines of new business logic. The core feature (scoped visibility) has zero test coverage. The modified load-skill-tool test only exercises the "global" path — the "scoped" branch, version pinning, and assignment checks are never reached. Collection cycle detection (BFS), recursive skill resolution, and all new local-adapter methods are untested.

Minimum test bar before merge:
1. `resolve.ts` — mock adapter tests for dedup, error fallback, collections undefined
2. `load-skill-tool.ts` — scoped+assigned (pass), scoped+unassigned (block), pinnedVersion
3. `collection-adapter.ts` — cycle detection, recursive resolution (real SQLite)
4. `local-adapter.ts` — visibility, assignment, filtered listing round-trips

## Needs Decision

1. **Migration path for existing workspace.yml `skills` entries.** The PR removes `SkillEntrySchema` from workspace config. Existing files with `skills:` will have that key silently stripped by Zod v4. Users lose bindings with no error. Is a migration or warning needed, or are there no production workspace.yml files with skill entries?

2. **PTY server migration bundled in the same PR.** The Deno-to-Node.js/tsx change for pty-server is unrelated to skill scoping. Should it be split into its own PR to reduce blast radius?

3. **Frontend uses raw `fetch` with `as` cast instead of typed RPC client.** `skill-queries.ts` casts `(await res.json()) as { skills: unknown[] }` which violates the codebase `as` rule. Is this temporary scaffolding or should it use Zod parsing / the daemon client?

4. **`collection_members.member_id` has no FK constraint when `member_type='skill'`.** The member_id references skills.skill_id but there's no foreign key — orphaned references will accumulate as skills are deleted (the deleteSkill cleanup helps but isn't transactional). Is this acceptable?
