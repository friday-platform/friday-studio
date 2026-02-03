# Code Review: Artifact-ref Resolution and failStep Detection

**Branch:** feature/artifact-ref-resolution
**Date:** 2026-02-02
**Verdict:** Clean
**Reviews:** 4

## Summary

Fixes two production bugs: (1) LLM-hallucinated artifact IDs passing through unvalidated in signal payloads, and (2) `failStep` tool calls going undetected when the LLM called other tools first. The implementation is clean — artifact resolution is a well-tested pure function, failStep detection mirrors the existing `findCompleteToolArgs` pattern, and the enricher heuristic is a pragmatic belt-and-suspenders addition.

---

## Design Critique

**Verdict:** Solid

The implementation matches the plan's intent with one deliberate deviation: the enricher now injects `format: "artifact-ref"` post-hoc via `injectArtifactRefFormat()`, whereas the plan said "no changes needed in the enricher." This deviation is an improvement — relying solely on prompt engineering for reliable format annotation is fragile.

### Findings

- **`injectArtifactRefFormat` false-positive risk** — The regex `/(?:^|_)file(?:$|_)/` will tag any string field with "file" in the key name (e.g., `file_count` that's a number metadata field). The keyword "artifact" alone is broad. Acceptable as a heuristic for new workspace creation — the worst case is resolution rejects a non-artifact value with a clear error, and workspace authors can fix the schema.

- **`stopOnToolCall` behavioral change** — Previously `undefined` when `completeToolInjected` was false, now `["failStep"]`. Correct: stopping on `failStep` is always desirable.

- **No integration test for trigger.ts wiring** — The pure function is well-tested, but the wiring (streamId extraction, artifact fetch, fallback) has no direct test. Low risk given the defensive error handling.

- **~~Silent catch in trigger.ts~~** — Resolved in R3→R4. Both the `!artifactsResponse.ok` path and the `catch` block now return errors (fail-closed).

## Code Review

### P1: Bugs
None found.

### P2: Code Quality

#### Redundant `as Record<string, unknown>` cast in trigger.ts [APPLIED]

`signalConfig.schema` is already typed as `Record<string, unknown>` from `SchemaObjectSchema`. The `as` cast was redundant and violated the project's "no `as` assertions" rule. Removed.

#### Unconditional artifact fetch on every signal trigger [APPLIED]

Every signal trigger with a schema and streamId was fetching up to 1000 artifacts, even when the schema has zero `artifact-ref` fields. Added `hasArtifactRefFields(schema)` guard to skip the fetch when unnecessary.

#### Misleading error message for non-string array items [APPLIED]

When an array item was not a string, the error said "artifact ID 'X' not found in chat" — the real problem is the item isn't a string. Fixed to say "expected string artifact ID, got {typeof}".

#### `as` casts in injectArtifactRefFormat [ACCEPTED]

Three `as Record<string, ...>` casts in `signals.ts`. These are pragmatic — the function already does runtime `typeof` checks before the casts. The alternative (Zod parsing) would be more complex for a deterministic post-processing function that only runs at workspace creation time. Accepted.

#### `as` cast on schema.properties in resolve-artifact-refs.ts [ACCEPTED]

`schema.properties as Record<string, SchemaProperty> | undefined` at line 45. The function returns early if `!properties`, and the `SchemaProperty` interface uses index signatures. Pragmatic boundary cast with immediate null check. Accepted.

### P3: Slop

#### JSDoc on findFailStepToolArgs [APPLIED - R2]

Fixed in round 2. JSDoc now matches actual search order.

#### JSDoc scope creep on SchemaObjectSchema [APPLIED - R1]

Trimmed in round 1. References implementation file instead of describing runtime behavior.

## Test Review

### Bullshit Tests
None found. All tests exercise real application logic with zero or minimal mocking.

### Vitest Issues

#### Double assertion on engine.signal() [APPLIED - R1]

Fixed in round 1. Combined into single regex assertion.

### Coverage Gaps

- **Non-string value in single artifact-ref field** — `typeof value !== "string"` branch at `resolve-artifact-refs.ts:69` untested. Low priority.

- **Non-string item in array artifact-ref field** — `typeof item !== "string"` branch untested. Low priority.

- **Non-string typed field with "file" in key name** — `injectArtifactRefFormat` skips non-string fields (e.g., `file_count: number`) but no test covers this. Low priority.

- **FSM definition boilerplate** — 15+ near-identical FSM definitions in `complete-tool-injection.test.ts`. Readability concern, not correctness. Could extract 2-3 builder helpers.

---

## Applied Fixes

| Round | File | Fix |
|-------|------|-----|
| R3 | `trigger.ts:66` | Removed redundant `as Record<string, unknown>` cast |
| R3 | `trigger.ts:57` | Added `hasArtifactRefFields()` guard to skip unnecessary artifact fetch |
| R3 | `resolve-artifact-refs.ts:112` | Fixed error message for non-string array items |
| R3 | `resolve-artifact-refs.ts:34` | Added `hasArtifactRefFields()` helper |
| R2 | `resolve-artifact-refs.ts:52` | Replaced `as string[]` with `.filter()` type guard |
| R2 | `fsm-engine.ts:67` | Fixed JSDoc to match actual search order |
| R1 | `complete-tool-injection.test.ts:737-738` | Combined double `rejects.toThrow` into single regex assertion |
| R1 | `base.ts:74-78` | Trimmed JSDoc to reference implementation file |
| R1 | `signals.test.ts:44` | Changed `toEqual` to `toBe` for reference equality |

## Needs Decision

None remaining.

### Low-priority coverage gaps

Non-string values in artifact-ref fields (both single and array), non-string typed fields with "file" in key name. Low priority but would improve coverage of type-guard branches.

## Resolved Decisions

- **Auto-fill optional artifact-ref fields** — Fixed in R1. Only required fields are now auto-filled.
- **Broad "artifact" keyword** — Accepted in R2. Enricher runs only at workspace creation.

---

## Context

- **Plan:** `docs/plans/2026-02-02-artifact-ref-resolution-design.v3.md`
- **Files changed:** 10
- **PR:** https://github.com/tempestteam/atlas/pull/1778
- **Reviewed by:** Design Critic, Code Reviewer, Test Reviewer (×3 rounds)
