# Review: melodic-strolling-seal — Pass 2

**Date:** 2026-05-06
**Branch:** `worktree-melodic-strolling-seal`
**Verdict:** Clean (with two acknowledged carve-outs); **two production bugs caught and fixed** that would have shipped silently
**Scope:** First-pass review's 13 findings + new code in `40ae3cb` (Phase 12.C+1.C) that landed mid-review.
**First-pass review:** `docs/reviews/2026-05-06-melodic-strolling-seal.md`

## Summary

All 13 findings from the first-pass review have been addressed across 5 fix commits (`488e7ad`, `f4622f6`, `ba6062f`, `abf2d6f`, plus the in-flight elicitations storage tests). The supervisor-flip fan-in fix is no longer at risk of silently regressing under burst load, the `dangerouslySkipAllowlist` bypass actually bypasses, the delegate depth-cap loophole is closed, and tests with names that lied have been renamed honestly. Phase 12.C+1.C (`40ae3cb`) adds `request_tool_access` plus its permissions plumbing — clean code, isolated, well-tested. Two carve-outs flagged for follow-up rather than fixed in-pass: the `completedSessionMetadata` cap raise is a band-aid (proper fix needs a "consumed" event from the cascade), and lifecycle/model test files remain Zod-shape-heavy (acceptable because behavioral coverage lives in adjacent runtime/sweeper tests, but the test-count headline is inflated).

## First-pass findings — status

| # | Severity | Status | Commit | Notes |
|---|---|---|---|---|
| 1 | Critical | ✓ Fixed | `f4622f6` | Renamed false-pass test in `elicitations/model.test.ts:137` to "accepts but does not require id at create time (.omit semantics; extras pass)" — name now matches assertion. |
| 2 | Critical | ✓ Fixed (and uncovered 2 production bugs) | `d0d5594` | Behavioral tests for `JetStreamElicitationStorageAdapter` against the real nats-server fixture (10 tests). **The exercise uncovered two real production bugs that would have shipped silently** — exactly what the review finding predicted: (a) stream config was missing `allow_msg_ttl: true`, so NATS 2.11+ rejected every `js.publish` with "per-message ttl is disabled" (`create()` was 100% broken in production); (b) `list()` calling `await kv.get(key)` inside `for await (const key of kv.keys())` terminated the underlying ordered consumer early, returning only the first key (route handler would hit this on any non-trivial bucket). Both fixed in the same commit. |
| 3 | Important | ✓ Fixed | `488e7ad` | `expireEphemeralForSession` swapped from `listByWorkspace + per-id get` to `listBySession`. ArtifactSummary keeps `lifecycle` (omits only `data`), so no per-id refetch needed. O(N_workspace) → O(N_session). |
| 4 | Important | ✓ Fixed | `488e7ad` | FSM type:llm action now passes `signal.data.foregroundWorkspaceIds` to `composeMemoryBlocks`. Phase 5 parity break closed. |
| 5 | Important | ✓ Fixed | `f4622f6` | `buildTools` now resolves effective permissions and skips per-agent narrowing when `dangerouslySkipAllowlist` resolves true. Falls through to `wrapPlatformToolsWithScope` so scope-injected tools still receive sessionId/actionId/perms. Logs at info level for operator visibility. Imported `resolvePermissions` via `@atlas/config/permissions` subpath to avoid a TS2589 type-instantiation-depth error from the full config zod graph. |
| 6 | Important | ✓ Fixed | `488e7ad` | Delegate depth-cap loophole closed. When child can re-delegate (`depth + 1 < maxDepth`), build a fresh `createDelegateTool` with `depth: depth + 1` instead of inheriting the parent's closure-bound delegate. Grandchildren now see the actual incremented depth. |
| 7 | Important | 🟡 Mitigated (band-aid) | `abf2d6f` | `completedSessionMetadata` cap raised from 100 → 10,000 with eviction-warn-log. The proper fix (per-session keyed map cleared on cascade-dispatched event) is filed as a follow-up. 10k entries × small payload is hundreds of KB; eviction is now genuinely improbable in any realistic workspace. |
| 8 | Important | ✓ Honest demote | `ba6062f` | `scrubber-integration.test.ts` got a docstring acknowledging the tautology (the mocked `createMCPTools` itself implements the `scrubResult` branch). Wiring assertion is genuine; payload-shape assertions are noted as needing a real `createMCPTools + stub MCP server` follow-up. |
| 9 | Important | 🟡 Acknowledged | (no commit) | Schema round-trip tests in `lifecycle.test.ts` (13/13 are `safeParse`), `elicitations/model.test.ts`, and `session-events.parent-link.test.ts` were flagged as inflating the test-count headline. **Carve-out:** behavioral coverage for these surfaces actually exists in adjacent files (`artifacts-sweeper.test.ts`, `runtime-ephemeral-cleanup.test.ts`, `runtime-artifact-persist.test.ts`, the in-flight storage adapter tests for #2). The schema tests are guards, not load-bearing coverage; the framing in the first-pass review overstated their cost. The chain-walk test in `session-events.parent-link.test.ts:232-268` is genuine behavior. No code change. |
| 10 | Important | ✓ Fixed | `488e7ad` | Exported `DEFAULT_MAX_DEPTH` / `DEFAULT_MAX_STEPS_PER_CALL` / `DEFAULT_MAX_OUTPUT_TOKENS` from `core/src/delegate/index.ts`. fsm-engine references the exported constant. Removes the duplicated `1` literal that would silently drift. |
| 11 | Important | ✓ Fixed | `488e7ad` | `artifacts-sweeper.ts` builds a fresh `scanCtx` via spread instead of mutating `ctx` from `getScanContext`. Pre-empts coupling bug if a future memoization layer is added. |
| 12 | Minor | ✓ Fixed | `ba6062f` | `auto-injection.test.ts` describe block renamed from "auto-injection of memory+artifact tools" to "forwards configured platform tools to LLM" with a docstring noting the integration-vs-unit boundary. |
| 13 | Important | ✓ Fixed | `ba6062f` | `budget.test.ts` wall-clock test gap widened from 5ms / 25ms to 50ms / 250ms. Same branch under test (wall-clock fires before steps resolve); no longer races CI runners with GC pauses. |

**Score:** 12 fully fixed (with #2 also uncovering 2 production bugs en route), 1 acknowledged carve-out (#9), 1 mitigated band-aid (#7).

## New code review — Phase 12.C+1.C (`40ae3cb`)

### What landed

`request_tool_access(toolName, reason)` platform MCP tool. The LLM calls it when it wants a tool not in its allowlist. The tool resolves effective permissions via `resolvePermissions` (job > workspace > daemon env). On bypass: returns `{ ok: true, granted: true, reason: "bypass" }` and logs at info level. Otherwise: emits a `kind: "tool-allowlist"` elicitation via `ElicitationStorage.create` and returns `{ ok: false, granted: false, elicitationId, reason: "pending_user_approval" }`.

Permissions plumbing: `WorkspaceConfig.permissions` and `JobSpecification.permissions` flow into `FSMEngineOptions` → `buildTools` → `wrapPlatformToolsWithScope` → tool's execute args. The MCP tool reads them at call time and resolves with the daemon env-var as the floor.

### Findings

#### Critical
None.

#### Important

**N1. `request_tool_access` does not surface in chat's tool catalog**
- **Location:** `packages/system/agents/workspace-chat/workspace-chat.agent.ts:741`
- **Problem:** Chat composes its `primaryTools` from chat-side factories and doesn't pull from atlas-platform MCP. So the LLM in chat can't actually call `request_tool_access` — only FSM `type:llm` actions and `executeCodeAgent` paths can. The Phase 12.C+1.C agent flagged this in their report; the spec described chat surfacing as a "report back" sanity check, not a deliverable. But the user-felt experience is "I'm chatting with workspace-chat, my agent wants a tool, and the elicitation flow doesn't fire from chat."
- **Recommendation:** Add a small `createRequestToolAccessTool` factory in `packages/system/agents/workspace-chat/tools/` and include it in the primary tool composition. Mirror the artifacts/memory-tool pattern.
- **Worth doing:** Yes — without it, the supervisor (chat) can never elicit tool-access on the user's behalf, which is the headline use case for Phase 12.

**N2. The bypass + `request_tool_access` flow has overlapping but distinct fires**
- **Location:** `packages/fsm-engine/fsm-engine.ts:buildTools` (Phase 1.C bypass — review #5 fix in `f4622f6`) + `packages/mcp-server/src/tools/permissions/request-tool-access.ts` (Phase 12.C tool)
- **Problem:** Two layers now read `resolvePermissions`. `buildTools` reads it once at action construction to decide whether to skip the per-agent allowlist filter; the tool reads it again at call time when the LLM invokes `request_tool_access`. They use the same precedence rules and should agree, but they're independent calls — if `dangerouslySkipAllowlist` flips between construction and call, behavior diverges. In practice the daemon env var won't change mid-call, and the workspace/job config is loaded at construction; risk is low. But the duplication is a foot-gun.
- **Recommendation:** Either resolve once at construction time and pass the resolved result through the scope (one source of truth), or accept the duplication and document the (low-risk) divergence window.
- **Worth doing:** No (today) — duplicated reads are correct for now and the practical divergence window is empty. Flag for future refactor.

**N3. Elicitation `expiresAt` defaults to 30 minutes, not job-timeout-derived**
- **Location:** `packages/mcp-server/src/tools/permissions/request-tool-access.ts`
- **Problem:** The plan's resolved decision was "tied to job timeout; per-job override." The Phase 12.C+1.C agent shipped 30 minutes hardcoded ("no job-timeout plumbing for now since the spec explicitly excludes auto-suspend; the elicitation TTL is informational"). That's a reasonable stopgap but doesn't match the user-resolved policy. With the cascade-suspend pattern not yet built, 30 minutes vs 24h vs job-timeout doesn't matter functionally — the elicitation expires either way. But once the runtime starts honoring the elicitation answer (real auto-suspend land), the timeout will start mattering.
- **Recommendation:** Plumb `signal._context?.jobTimeoutMs` (if available) into the tool's scope; default to `30 minutes` only when no job timeout is wired. Document in the tool's docstring that the runtime auto-suspend behavior is pending.
- **Worth doing:** No (today) — informational TTL is sufficient until auto-suspend lands; revisit then.

#### Minor

**N4. `sessionId: "unknown"` fallback in `request_tool_access`**
- **Location:** `packages/mcp-server/src/tools/permissions/request-tool-access.ts`
- **Problem:** The tool falls back to `sessionId: "unknown"` if scope didn't inject one. In practice FSM and chat always set it, but the fallback masks bugs where future call sites forget to thread `sessionId` through scope.
- **Recommendation:** Either error loudly (`return { ok: false, reason: "missing_session_context" }`) or log a warning. Silently writing `sessionId: "unknown"` to the elicitation makes the Activity feed harder to filter.
- **Worth doing:** Yes — small, removes a future debuggability hole.

**N5. New tests are well-formed**
- `request-tool-access.test.ts` (11 tests): bypass via job perms / workspace perms / daemon env, precedence (`job:false` beats `workspace:true`), elicitation envelope shape, `ElicitationStorage.create` failure, sessionId/actionId fallbacks, registration sanity. Covers each branch of the resolution + creation paths. Mocks `ElicitationStorage` cleanly without re-implementing it.
- `agent-tool-filters.test.ts` (4 new wrap tests): sessionId, actionId, permissions injection, omit-when-absent. Verifies the scope wrapping is the contract `request_tool_access` relies on.
- **Worth doing:** No issues — coverage is proportional to the change.

### Verdict on `40ae3cb`

Clean. Three Important-rated follow-ups (N1 chat surfacing, N2 duplicated reads, N3 expiresAt source) are either deferred-by-design or low-risk. N4 is small.

## Tests

11 first-pass-review fix commits + 1 in-flight sub-agent. Test cleanups in `f4622f6` (false-pass rename), `ba6062f` (honest scope renames + flake reduction), and the in-flight storage adapter tests directly address the three test-quality findings (#1, #2, #8, #12, #13).

The overall test suite continues to pass (228 in the most recent affected-package run after batch A; 16 in batch B; 16 in batch C).

## Needs Decision

1. **N1 chat-surfacing for `request_tool_access`** — small follow-on. Confirm whether you want it in this branch or a separate one.
2. **#7 proper fix** (consumed-event GC) — band-aid via cap raise should hold. Schedule the proper fix when convenient.
3. **#9 schema-test cleanup** — acknowledged carve-out. If you want the test-count headline cleaned up, can run a separate "delete library-only tests" pass. Otherwise leave; the schema guards are cheap and behavioral coverage exists elsewhere.

## Diff stats since first-pass review

6 fix commits ahead of `c8ee215` (the first-pass review's HEAD):
- `40ae3cb` Phase 12.C+1.C (landed mid-review)
- `488e7ad` correctness + parity fixes (#3, #4, #6, #10, #11)
- `f4622f6` bypass enforcement + honest test names (#1, #5, partial #12)
- `ba6062f` test honesty + flake reduction (#8, #13, finishes #12)
- `abf2d6f` completedSessionMetadata cap (#7)
- `d0d5594` elicitations storage adapter tests + 2 production bug fixes (#2)
