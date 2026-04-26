# Team Lead Learnings — 2026-04-26 — Nested Tool Call Envelopes

## Mistakes teammates made independently

1. **Unnecessary `as` assertions in production code** — Two separate teammates (Ellie on task #8, Patina on task #14) used `as` type assertions when constructing typed objects. In both cases the assertion was unnecessary:
   - `nested-chunk-writer.ts`: `writer.write({...} as AtlasUIMessageChunk)` — TypeScript accepted the object without the cast because the schema registration properly inferred the data-nested-chunk variant.
   - `extract-tool-calls.ts`: `accumulateChunks(chunks as AtlasUIMessageChunk[], ...)` — Fixed by widening `accumulateChunks` parameter to `unknown[]` since `applyChunk` already defensively narrows at runtime.
   *Learning: Remind teammates to try removing `as` before committing — the compiler often accepts the shape once schemas are properly registered.*

## Codebase quirks that confused teammates

2. **AI SDK `processUIMessageStream` is not exported** — Ellie noted in commit message that `processUIMessageStream` (used for schema validation smoke tests) is bundled internally by the AI SDK but not exported, requiring fallback to `validateAtlasUIMessages`.
   *Learning: Document this in a code comment near `AtlasDataEventSchemas` so future schema additions don't waste time searching for the internal export.*

## Patterns noticed during diff review

3. **Test helpers doing defensive runtime narrowing still use `as`** — Several test files (e.g., `proxy-writer.test.ts`, `tree-builder.test.ts`) use `as` in test helpers to access nested properties on `unknown` envelope shapes. This is acceptable for quick test assertions but should be bounded — if the helper grows beyond 3 uses, extract a typed accessor.
4. **Dead imports accumulate quickly** — After refactoring `extract-tool-calls.ts` to delegate to new modules, `AtlasUIMessageChunk` became unused in both the orchestrator and `chunk-accumulator.ts`. The linter caught one, manual review caught the other.
   *Learning: After a refactor that changes function signatures, run a quick `rg "^import.*Atlas"` to spot newly-dead imports.*

## QA/data gotcha

5. **Dev database reference chats predate server-side envelope changes** — Task #15 QA revealed that all existing dev DB chats were recorded before `createAgentTool` emitted `nested-chunk` envelopes. The reducer refactor works correctly for new data, but there is no backward-compatibility path for old mangled-ID chats.
   *Learning: When designing reducer refactors that replace wire-format assumptions, explicitly decide backward-compatibility policy and communicate it to QA. Don't assume existing reference data will exercise new paths.*

## Self-correction

6. **Team lead broke the "no writing code" rule** — I directly edited `nested-chunk-writer.ts` and later `chunk-accumulator.ts`/`extract-tool-calls.ts` to remove `as` assertions instead of spawning fix agents. In the pi subagent model, once an agent finishes there is no "resubmit" loop. Better approach: create a follow-up fix task and spawn a fresh agent, or batch the fix into the next wave's agent prompt.
