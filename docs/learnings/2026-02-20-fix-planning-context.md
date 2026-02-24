# Team Lead Learnings — fix-planning-context (2026-02-20)

- Concurrent teammates sharing a git worktree can't commit simultaneously without races. Commits landed but with timing issues — leader checks often ran before commits materialized. Future: check `git diff HEAD --stat` for pending work before declaring commits missing.
- Teammates consistently hallucinate commit hashes — they report sha hashes that don't exist in the object store, even when the actual commit did land under a different hash. Don't trust reported hashes; verify with `git log`.
- Fixture changes that add new required fields to schemas cascade into assembler tests that load those fixtures. The csv-analysis fixture change broke `build-workspace.test.ts` because it added `bundledId` to agents the test assumed were LLM-only. Divergent fixture updates need a grep for all test files that reference the fixture name.
- Destructure-to-omit pattern (`const { unwantedKey, ...rest } = obj`) triggers `no-unused-vars` in Deno lint. Use `// deno-lint-ignore no-unused-vars` — this is intentional key omission, not dead code.
- `ClassifiedDAGStepSchema` uses `z.strictObject()` (inherited from `DAGStepSchema.extend()`), so adding a required field to the schema breaks any fixture or test data parsed through it that doesn't include the new field. Schema changes must be coordinated with ALL fixture and test data updates in the same commit or adjacent commits.
- `z.preprocess()` wrapping `.extend()` of a `strictObject` returns `ZodPipe<ZodTransform, U>` — `z.infer` gives the right output type but exports ugly. Infer from the inner schema directly for clean named types.
- `build-fsm.ts` emits `agentAction(step.executionRef)` not `agentAction(step.agentId)` — downstream maps keyed by agentId silently miss bundled agents whose planner ID differs from their registry key.
- Fastpath bypasses `stampExecutionTypes()` entirely — identity fields must be set manually to match the same contract as the full pipeline.
- `agent.name` is display text, `agent.id` is the stable kebab-case identifier — use `agent.id` for planner identity, never `agent.name`.
- Per-file `deno check` on changed files won't catch fixtures in OTHER test files that construct the same types. Full `deno check` after each wave is essential.
