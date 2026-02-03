# Code Review: Add Output Schemas to Bundled Agent Registry

**Branch:** feat/bundled-agent-output-schema
**Date:** 2026-01-30
**Verdict:** Clean

## Summary

Adds `outputSchema` (JSONSchema) to `BundledAgentRegistryItem` so the FSM workspace creator LLM sees actual agent output shapes instead of hallucinating fields. Converts each bundled agent's Result type to a Zod schema (`z.infer` for TypeScript + `z.toJSONSchema()` for prompt injection). `fromAgent()` helper derives registry entries from agent metadata. Moves registry from `@atlas/core` to `@atlas/bundled-agents`. Fundamentally sound, no blockers.

---

## Design Critique

**Verdict:** Solid

The core idea — give the LLM the real output schema — is correct, well-scoped, and proportionally addressed. The `z.infer` pattern keeps TypeScript types and JSONSchema in sync. The `fromAgent()` helper reduces registry duplication. Backward compatible for unknown/custom agents (falls back to "derive from downstream"). The registry move to `@atlas/bundled-agents` is the right home — it's metadata *about* bundled agents.

### Concerns

#### 1. Circular dependency between @atlas/core and @atlas/bundled-agents [NEEDS-DECISION]

**Problem:** `@atlas/core` imports from `@atlas/bundled-agents/registry`, while `@atlas/bundled-agents` imports from `@atlas/core/artifacts` (google/calendar.ts). This circular package dependency works today because the specific subpaths don't form a runtime cycle, but it's fragile — any future import in the registry path that touches `@atlas/core` will break at runtime with incomplete module initialization.

**Recommendation:** Accept for now with awareness. Long-term options: (1) extract registry types into a leaf package, (2) extract `OutlineRefSchema` into `@atlas/agent-sdk`, or (3) document the constraint on both sides.

#### 2. OutlineRefSchema duplication [RESOLVED]

**Problem:** `shared-schemas.ts` duplicates `OutlineRefSchema` from `@atlas/core` with a "keep in sync" comment but no automated enforcement. If someone adds a field to the core version, the bundled-agents copy silently drifts.

**Resolution:** Added drift-detection test at `packages/core/src/types/outline-ref-drift.test.ts` that compares `z.toJSONSchema()` output of both copies. Added `./shared-schemas` subpath export to `@atlas/bundled-agents` to support the import.

#### 3. LLM compliance is best-effort

**Problem:** The prompt says "EXACTLY this shape" but LLMs are probabilistic.

**Assessment:** Proportionate. Unit tests verify the prompt contains the schema; the local-only integration test verifies end-to-end. This is the right tradeoff.

---

## Code Review

### P1: Bugs

None found. The circular dependency is a risk, not a current bug.

### P2: Code Quality

#### Google Calendar drops toolCalls/toolResults from output type [RESOLVED]

**Priority:** P2
**Location:** `packages/bundled-agents/src/google/calendar.ts:20-24`

**Problem:** Old type had `toolCalls?: ToolCall[]` and `toolResults?: ToolResult[]`. New `GoogleCalendarOutputSchema` omits them. The old `GoogleCalendarAgentResultSchema` was also exported and may have consumers.

**Resolution:** Verified safe. The handler never populated `toolCalls`/`toolResults` in return values, and `GoogleCalendarAgentResultSchema` has zero consumers outside the defining file.

#### Three new subpath exports from @atlas/system for one test [NEEDS-DECISION]

**Priority:** P2
**Location:** `packages/system/deno.json`, `packages/system/package.json`

**Problem:** `agent-classifier`, `agent-helpers`, and `fsm-generation-core` exported from `@atlas/system` solely for the integration test in `@atlas/fsm-engine`. Widens public API surface.

**Recommendation:** Move integration test into `packages/system/` and remove the subpath exports.

#### Heavy devDependencies added to fsm-engine for one test [NEEDS-DECISION]

**Priority:** P2
**Location:** `packages/fsm-engine/package.json:19-24`

**Problem:** `@atlas/document-store`, `@atlas/evals-2`, `@atlas/system`, `@atlas/workspace-builder` added as devDependencies. The regression test is a pipeline integration test, not an FSM engine test.

**Recommendation:** Colocate the test with the code it actually tests (`@atlas/system`).

#### fromAgent silently accepts mismatched registry keys [NEEDS-DECISION]

**Priority:** P2
**Location:** `packages/bundled-agents/src/registry.ts:128`

**Problem:** Registry key (e.g., `"slack"`) and `agent.metadata.id` happen to match but there's no enforcement. `fromAgent` derives `id` from metadata, not the key.

**Recommendation:** Consider asserting `registryKey === agent.metadata.id` or building the Record from an array keyed by metadata id.

#### @atlas/evals-2 export may be unnecessary [NEEDS-DECISION]

**Priority:** P2
**Location:** `tools/evals-2/deno.json`, `tools/evals-2/package.json`

**Problem:** New export `./lib/load-credentials` and package name added. The integration test imports from `@atlas/core/credentials`, not from evals-2. May be leftover from an earlier iteration.

**Recommendation:** Verify this is actually needed. If nothing imports it, revert.

### P3: Slop

None found.

---

## Test Review

### agent-helpers.test.ts

Good. Tests real behavior through public APIs (`flattenAgent`, `buildFSMGenerationPrompt`). New tests cover:
- outputSchema population from registry for bundled agents
- outputSchema absent for nonexistent registry entries
- Prompt includes "EXACTLY this shape" instruction when outputSchema present
- Prompt excludes schema block when outputSchema absent

One concern: `enrichAgentsWithPipelineContext` tests call real LLM and are skipped in CI. The deterministic logic (step-description-as-base, no-downstream-skip, passthrough) has zero CI coverage.

### agent-output-schema-mismatch.test.ts

Well-structured regression test exercising full pipeline. Realistic mock agent results matching production shapes. Appropriately skipped in CI.

One subtle issue: plan agent IDs (`web-researcher`, `summary-writer`) differ from bundled agent IDs (`research`, `get-summary`) used by the executor. The implicit mapping via `classifyAgents` is non-obvious — a comment would help.

### Coverage Gaps

- `signalPayloadSchema` branch in `buildFSMGenerationPrompt` has zero test coverage (pre-existing)
- No snapshot test on `z.toJSONSchema()` output to catch Zod upgrade surprises
- `enrichAgentsWithPipelineContext` deterministic logic untestable in CI due to hard LLM dependency

---

## Applied Fixes

- OutlineRefSchema drift-detection test added (`packages/core/src/types/outline-ref-drift.test.ts`)
- `./shared-schemas` subpath export added to `@atlas/bundled-agents`
- Google Calendar `toolCalls`/`toolResults` removal verified safe

## Needs Decision

### Architecture
1. **Circular dependency** `@atlas/core` ↔ `@atlas/bundled-agents` — accept + document, or extract leaf package
2. ~~**OutlineRefSchema duplication**~~ — resolved with drift-detection test

### Code Quality
3. ~~**Google Calendar `toolCalls`/`toolResults` removal**~~ — verified safe, no consumers
4. **`@atlas/system` subpath exports** — 3 modules exported for 1 test, consider relocating
5. **fsm-engine devDependencies** — heavy deps for a single integration test
6. **`fromAgent` key/id mismatch** — no enforcement between registry key and agent metadata id
7. **`@atlas/evals-2` export** — verify it's needed

### Tests
8. **`signalPayloadSchema` branch** — zero coverage (pre-existing)
9. **`enrichAgentsWithPipelineContext` CI coverage** — deterministic logic skipped in CI

---

## Context

- **Plan:** None
- **Files changed:** 30
- **PR:** https://github.com/tempestteam/atlas/pull/1688
- **Reviewed by:** Design Critic, Code Reviewer, Test Reviewer
