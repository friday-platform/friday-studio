# Validation Verdict Implementation - Team Lead Learnings

Session: 2026-04-28, parallel implementation of tasks #20-#29 (fine-grained
ValidationVerdict pipeline).

## Observations

- **Concurrent error-class duplication.** Two parallel teammates (Patina on #26,
  Ellie on #22) both needed a `ValidationFailedError` class carrying a verdict.
  Patina put it in `@atlas/hallucination`, Ellie defined a duplicate with a
  different constructor signature in `@atlas/fsm-engine`. Coordination notes
  ("contract aligned") in commit messages were aspirational — the actual code
  diverged. Lesson: when two parallel tasks share a contract, the leader should
  pre-declare the shared symbol's home and signature in the spawn prompts, not
  rely on cross-teammate coordination via chat.

- **Pre-existing red typecheck masks new errors.** `deno task typecheck` was
  already red on main (4 errors in `packages/system/agents/workspace-chat/tools/job-tools.test.ts`
  — `UIMessageStreamWriter.onError` missing, `callArgs[1]` index-access). Every
  teammate flagged this in their commit footer. Risk: a new typecheck regression
  introduced by a teammate would be invisible against the existing red. Lesson:
  before kicking off parallel waves, fix the workspace-wide typecheck or list
  the EXACT pre-existing error fingerprints so teammates can diff against them.

- **Tracer bullet split was effective.** Splitting the type/schema spine (#20)
  from the prompt rewrite (#21) let the schema land first and unblock four
  parallel tasks (#21, #22, #26, #27). The trade-off — Task #20 had to leave
  `issues: []` and a `retryGuidance` string concatenation as placeholders —
  was visible and resolved cleanly in #21.

- **The `validate()` total-function design eliminates a class of dead code.**
  Patina noticed during #26 that the existing `try/catch` around `validate()`
  was dead — `validate()` swallows infra failures into synthetic uncertain
  verdicts and never throws. The pattern of "return a typed error verdict
  rather than throw" is worth promoting elsewhere in the codebase where call
  sites currently wrap with defensive try/catch.
