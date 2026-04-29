# Fine-grained Validation Verdict + Inline UI Observability

**Date:** 2026-04-28
**Status:** Design approved, ready for implementation
**Author:** Eric (with brainstorming pair)

## Problem Statement

When Friday's hallucination detector rejects an LLM action, the user sees a long opaque execution followed by a generic error string. There is currently zero observability into:

- The fact that a validation attempt happened
- The fact that a retry is in progress
- WHY the validator rejected the output
- Which specific claims were flagged
- Whether the validator was uncertain or confident-fail
- Whether the validator itself made a math/timezone/arithmetic error (a common false-positive class)

Concretely: jobs that take two minutes to fail look like silent hangs. The error message at the end ("LLM action failed validation after retry: ...") is a freeform concatenation of issue strings the user has to reverse-engineer.

The binary `{valid, feedback}` envelope also forces every consumer (FSM retry policy, UI surfacing, observability tooling) to re-derive its own policy from a freeform string. There is no shared structure for what kind of failure happened.

## Solution

Replace the binary verdict with a structured `ValidationVerdict` carrying:

- A three-state status (`pass` / `uncertain` / `fail`) so judge uncertainty does not kill agent work
- Categorized per-claim issues drawn from a fixed enum
- Confidence + threshold so the user can see how close a verdict was to the line
- Retry guidance the judge phrased
- Citation strings linking flagged claims to the tool-result excerpts that should have backed them

Surface validation lifecycle in the agent-playground chat as inline pill rows — one row per attempt — placed after the tool calls of the action being validated. Pills auto-collapse on `pass`, expand on `fail`. The chat reads quietly when things work and explains itself when they don't.

Backend emits durable validation events through the existing FSM event pipeline so failures are replayable from session history.

In addition, update the judge prompt to explicitly forbid arithmetic, timezone, and date-logic reasoning (the most common false-positive class today) and bias toward `valid` when uncertain.

## User Stories

1. As a Friday user, I want to see when validation is running on a job, so that long execution times do not look like silent hangs.
2. As a Friday user, I want to see when the validator decided to retry an LLM step, so that I understand why a job is taking longer than expected.
3. As a Friday user debugging a failed job, I want to see what specific claims the validator flagged, so that I can decide if the validator was correct or buggy.
4. As a Friday user replaying a session, I want validation history to be persisted and visible, so that I can audit past failures without re-running the job.
5. As an agent author, I want validation failures to include category labels, so that I can iterate on prompts targeting specific failure modes.
6. As an agent author, I want my agent's correct output to NOT be rejected when the judge is uncertain about computed values (timezones, math), so that recoverable downstream work is not blocked.
7. As an agent author, I want a "retry guidance" string that the judge generated, so that retry attempts get coherent feedback rather than concatenated issue lines.
8. As a Friday operator, I want hallucination metrics broken down by category, so that I can tell whether failures are real fabrications or judge confusion.
9. As a developer working on the validator, I want to plug in a different judge model without changing event consumers, so that I can experiment with judge configurations.
10. As a developer working on the FSM engine, I want validation events to flow through the existing event pipeline, so that I do not need new transport infrastructure.
11. As a Friday user, I want successful validations to be visually quiet (auto-collapsed), so that the chat remains readable when things work.
12. As a Friday user, I want failed validations to be visually loud (expanded by default), so that I do not miss the explanation.
13. As an agent on retry, I want structured per-issue feedback rather than a concatenated string, so that I can target each issue precisely.
14. As a Friday user, I want validation events correlated with the FSM step that produced them, so that I can see which step failed in a multi-step job.
15. As a Friday user, I want the validator to default to "let it through" when in doubt, so that false positives do not block recoverable work.
16. As a developer extending the verdict, I want categories to come from a fixed enum the judge picks from, so that adding a new category requires explicit code changes.
17. As a Friday user, I want citations linking flagged claims to specific tool-result excerpts, so that I can verify the validator's reasoning.
18. As an agent author, I want the validator to NOT attempt arithmetic, timezone conversions, or date math, so that the judge's own math errors do not generate false fabrication claims.
19. As an agent author, I want tool-result truncation to be visible to the validator with a banner, so that the judge does not flag missing-tail content as fabrication.
20. As a Friday user, I want validator infrastructure failures (network, rate-limit, parse errors) to result in `uncertain` not `fail`, so that my agent's work is not lost when the validator breaks.
21. As a Friday user, I want the confidence score and threshold visible on the pill, so that I can tell how close a verdict was to the line.
22. As a developer adding a new event type, I want schema validation tests to catch missing schema updates, so that new events do not get silently dropped between layers.
23. As a Friday user, I want validation pill rows to render at the same indentation level as tool-call cards, so that the chat hierarchy is consistent.
24. As a Friday user, I want validation pills placed AFTER the tool calls of a step, so that chronological order matches what actually happened.
25. As a Friday user aborting a job mid-validation, I want the abort to propagate to the judge call, so that I do not waste tokens on a doomed validation.
26. As a Friday user, I want the same verdict shape regardless of which agent path produced the output (FSM LLM action vs. ad-hoc agent), so that consumers do not branch on agent type.

## Implementation Decisions

### Modules built or modified

- **`@atlas/hallucination`** — replace binary verdict with structured `ValidationVerdict`; categorized issues; threshold-aware status mapping; truncation banner on tool-result formatting; bumped infrastructure-failure fallback confidence (0.3 → 0.4); rewritten judge prompt with explicit out-of-scope section forbidding arithmetic, timezone, and date reasoning; remove dead `containsSeverePatterns` / `getSevereIssues` helpers and severity regex.
- **`@atlas/fsm-engine`** — new `FSMValidationAttemptEvent` variant in `FSMEvent` union; `LLMActionTrace` gains a `reasoning?` field populated from LLM result; emit lifecycle events on every attempt; retry only when `verdict.status === "fail"`; both `pass` and `uncertain` proceed.
- **`@atlas/core` session machinery** — extend FSM-event-to-session-event mapper for the new variant.
- **`@atlas/workspace` runtime** — forward the new event through the existing stream-chunk pipeline; no transport changes.
- **`apps/atlasd` SSE schemas** — add validation event variant to `SessionStreamEventSchema` so the playground does not silently drop it.
- **`apps/atlasd/src/agent-helpers.ts`** — consume the new verdict shape; remove the old confidence-only severity check; rely on the verdict's own status field.
- **`tools/agent-playground`** — chunk accumulator handles the new chunk type, correlates by `actionId`; new `<ValidationPillRow>` component; chat-message-list renders pills inline after each step's tool calls; SSE event schema updated to match.

### Architectural decisions

- **Three-state verdict (`pass` / `uncertain` / `fail`)** instead of two-state. Uncertain proceeds with a soft warning so judge uncertainty cannot kill recoverable agent work. False positives are strictly worse than false negatives in this domain.
- **Confidence bands tied to supervision level.** `confidence >= threshold` → `pass`; `0.3 <= c < threshold` → `uncertain`; `c < 0.3` → `fail`. STANDARD threshold is 0.45; MINIMAL 0.35; PARANOID 0.6.
- **Status is derived in code, not picked by the judge.** The judge emits structured issues + confidence; the threshold mapping lives in the validator. Separates observation (what the judge saw) from policy (what counts as failing).
- **Categorized issues come from a fixed enum the judge picks from** via a Zod schema enforced through `generateObject`. Worst case is a wrong category, never an unstructured emission.
- **Initial category set:** `sourcing`, `no-tools-called`, `judge-uncertain`, `judge-error`. Tight, expandable.
- **Judge crash → uncertain, not fail.** Synthetic verdict with confidence 0.4 and a single `judge-error` issue. Agent work is never lost to validator infrastructure failures.
- **Retry guidance lives on the verdict** (judge phrases it) rather than being assembled by FSM engine from concatenated issue strings.
- **Validation events are durable**, flowing through the existing JetStream session-events channel. Replayable from session history.
- **Validation events emit on EVERY phase including pass.** Full lifecycle is honest about replay; pass events are cheap to ignore in UI.
- **Action correlation via the existing `actionId`** on the parent action event; no new identifier introduced.
- **Pill placement after tool calls** of a step (chronological honesty — validation runs after the LLM returns).
- **Auto-collapsed pass, expanded-by-default fail.** Visual loudness matches importance; happy path stays quiet.
- **Retry policy stays inside fsm-engine**, not extracted to a separate module — it is two lines (`verdict.status === "fail" ? retry : proceed`) and splitting would be theatrical.

### API contracts

- `ValidationVerdict`: `{ status: "pass" | "uncertain" | "fail"; confidence: number; threshold: number; issues: ValidationIssue[]; retryGuidance: string }`
- `ValidationIssue`: `{ category: "sourcing" | "no-tools-called" | "judge-uncertain" | "judge-error"; severity: "info" | "warn" | "error"; claim: string; reasoning: string; citation: string | null }`
- `FSMValidationAttemptEvent`: `{ type: "data-fsm-validation-attempt"; data: { sessionId, workspaceId, jobName, actionId, state, attempt: number, status: "running" | "passed" | "failed", verdict?: ValidationVerdict, timestamp } }`
- `LLMOutputValidationResult` (FSM-engine internal): replaced from `{ valid, feedback? }` to `{ verdict: ValidationVerdict }`. Consumers branch on `verdict.status`.
- Validator entry point: `validate(result, supervisionLevel, config) → Promise<ValidationVerdict>`. Never throws; returns synthetic `uncertain` verdict on infrastructure failure.

### Module Boundaries

**`@atlas/hallucination`**

- **Interface:** `validate(result, supervisionLevel, config) → Promise<ValidationVerdict>` plus the public types.
- **Hides:** judge prompt construction; Zod schema for judge output; confidence-to-status threshold mapping; retry-guidance wording; tool-result truncation strategy and banner format; judge-crash fallback verdict construction; classifier model selection.
- **Trust contract:** always returns a well-formed verdict; never throws; fallback verdict on infrastructure failure means consumers never need to wrap in try/catch.

**FSM engine validation block**

- **Interface:** internal — runs the validator, emits events, decides proceed/retry/throw based on verdict status.
- **Hides:** retry counting, attempt indexing, when to short-circuit on uncertain, event lifecycle ordering.
- **Trust contract:** emits exactly one `running` and exactly one terminal status event per attempt; either returns successfully or throws after the second attempt's `fail`.

**FSM-event-to-session-event mapper**

- **Interface:** `FSMEvent → SessionStreamEvent`.
- **Hides:** serialization and field selection.
- **Trust contract:** pure function, no I/O, total over the FSMEvent union.

**Playground chunk accumulator**

- **Interface:** stream of validated SSE events → timeline of displayable chunks correlated to their parent action.
- **Hides:** correlation logic between validation events and their parent action via `actionId`; ordering of events in time.
- **Trust contract:** never silently drops; unknown event types surface as a warning, not silence.

**`<ValidationPillRow>` component**

- **Interface:** props are an attempt event plus optional verdict; emits expand/collapse.
- **Hides:** severity-to-color mapping, lifecycle iconography, expansion state, citation rendering format.
- **Trust contract:** pure presentational, no data fetching, no side effects.

### Data Isolation

Not applicable. No new user-scoped tables. Validation event data flows through the existing session-history infrastructure which already enforces user isolation.

## Testing Decisions

**What makes a good test:** external behavior only, never reach across module boundaries. Each test verifies the contract at one boundary. We do not test specific judge wording (LLM nondeterminism), pixel-perfect colors (theme-dependent), or exact retry-guidance text (judge-generated).

**Modules tested:**

- `@atlas/hallucination` unit (no LLM): verdict-shape mapping across confidence bands, judge-crash fallback construction, truncation banner appearance and content.
- `@atlas/hallucination` integration (real Haiku, gated on `ANTHROPIC_API_KEY`): categorized issues round-trip from the judge, sourced computed claims pass, unsourced claims fail with correct category, borderline confidence returns uncertain not fail.
- `@atlas/fsm-engine` unit: event lifecycle counts (one running + one terminal per attempt), `pass`/`uncertain` proceed, `fail` triggers retry, terminal `fail` throws with verdict in the error.
- `@atlas/fsm-engine` integration (real Haiku): existing `llm-validation-integration.test.ts` extended for event-emission assertions and verdict-shape contract.
- Playground component: snapshot tests for all five pill lifecycle states; correlation tests for the chunk accumulator linking validation events to their parent actions.
- SSE schema round-trip: serialize a `FSMValidationAttemptEvent`, parse via `SessionStreamEventSchema`, assert no fields lost. Catches forgotten schema updates at every layer.
- E2E manual sanity: replay one of the meeting-coordinator session reproductions against the new validator and verify pills render correctly through retry and terminal states.

**Prior art:** existing `fsm-validator.test.ts` and `llm-validation-integration.test.ts` already cover the verdict layer; existing snapshot patterns in the playground chat components.

## Out of Scope

- Step-level FSM cards in the UI (separate work — see `2026-04-28-job-tool-step-grouping-design.v2.md`).
- Validator metrics or observability dashboards (post-hoc, not blocked).
- User-configurable validation policies (proceed/retry/fail per category).
- Judge model A/B testing infrastructure.
- Citation deep-linking (clicking a citation jumps to the tool-result row).
- External notifications on terminal validation failures (Slack, email).
- Per-claim partial-output salvage (validated claims through, dubious claims rejected). Was Approach C in earlier brainstorm; held back as future enhancement once the verdict shape is in place.
- Restoring the integration-test fix that wires real `platformModels` — the test currently calls `createFSMOutputValidator()` with no args, returning the no-op validator. Acknowledged limitation; lives outside this work.

## Further Notes

- Judge prompt updates (forbidding arithmetic, timezone, and date-logic reasoning) are core to making the categorized verdict reliable. Without them, the judge's category assignments would be tainted by its own math errors, which is the most common false-positive class observed in the meeting-coordinator session reproductions.
- The 50KB → 100KB tool-result cap was already bumped in a prior commit; this design adds the explicit truncation banner so the judge knows truncation happened versus content being absent.
- The old `containsSeverePatterns` / `getSevereIssues` helpers and the regex matching `/fabricated|impossible|.../i` are removed entirely. Severity is now derived purely from confidence-band mapping. The previous OR-trigger created a self-fulfilling loop: the prompt taught the judge to use words like "fabricated", which then auto-tripped severe regardless of confidence.
- Future extensions naturally supported by the verdict shape: per-issue user actions ("dismiss this issue", "retry only on this category"), per-category retry policy configuration, validator metrics dashboards. Not in v1, but the structure is forward-compatible.
- The agent-playground UI changes are scoped to a single new component plus a chunk-accumulator case. No restructure of the existing chat message list — pills appear as a new row type alongside tool-call cards.

## Resolved Decisions (Domain Model Interview, 2026-04-28)

These follow-up decisions sharpen the contracts above. Each was resolved interactively after the initial design was approved.

### 1. `uncertain` propagates no taint downstream
The agent's output flows to downstream FSM steps, memory writes, and tool results **identically** whether the verdict was `pass` or `uncertain`. No metadata bit is added to `LLMActionTrace` or any downstream consumer. The verdict's durability through session events is the only observability surface — anyone debugging can see "this step produced under uncertain validation" by reading the validation event, but no consumer reads a "tainted" flag at runtime. Keeps the false-positive guard absolute.

### 2. UI default for `uncertain`: collapsed (yellow band)
Yellow band visible in peripheral vision; full issue list rendered only on click. Same affordance as `pass` (green, collapsed); only `fail` is expanded by default. Avoids training users to dismiss yellow pills when judge-confusion (timezones, math) cases are common.

### 3. `severity` on `ValidationIssue` is derived from category in code
Static map: `sourcing → error`, `no-tools-called → warn`, `judge-uncertain → info`, `judge-error → info`. The judge does not pick severity — same separation-of-policy reasoning as status. Field is kept on `ValidationIssue` (not the verdict) so a single fail verdict can carry mixed-severity issues side-by-side.

### 4. `citation` format: verbatim quote, plain string, ≤ 280 chars
Judge copies the most relevant ~1–3 lines from the tool result. The judge prompt enforces the cap; runtime truncates with ellipsis if it overshoots. `null` is reserved for issues whose category is the *absence* of supporting evidence (e.g., `no-tools-called`) — never used for "judge forgot to cite." Future deep-linking is added by string-matching at render time; no schema change needed.

### 5. Pill lifecycle: 5 states; `terminal` boolean on the failed event
States: `running`, `passed`, `uncertain`, `failed-retrying`, `failed-terminal`. The retry-vs-terminal distinction is encoded explicitly via a `terminal: boolean` field on the `failed` variant of `FSMValidationAttemptEvent` — not inferred from temporal neighbors in the chunk stream. Allows correct rendering under partial replay and event reordering.

### 6. Truncation banner: bottom-only, English, includes omitted byte count
Appended to the bottom of any tool result that hit the 100KB cap, with this exact shape:

```
[TOOL RESULT TRUNCATED — <N> bytes omitted from end. The judge should not flag missing tail content as fabrication.]
```

Bottom matches where truncation happens (tail cut). English instruction beats sentinel marker — the judge reads English natively. Including the byte count gives the judge calibration; the explicit instruction targets the exact false-positive class this banner exists to prevent.

### 7. Terminal-fail UI: red pill **plus** system error chunk
When the second attempt's `fail` throws, the chat shows both: (a) the `failed-terminal` pill (validation-layer detail), and (b) a system-level error chunk matching the existing pattern for tool / FSM job failures ("Job stopped: validation failed"). Two layers of state, two surfaces — matches how every other terminal job failure presents today, so the user does not need to learn a new "this job is dead" affordance per failure type.

## Glossary Note

`CONTEXT.md` defines two distinct things both reachable as "validator":

- **Validator (Workspace)** — the workspace config compiler in `@atlas/config`. Pre-runtime. Zod parse + reference integrity + semantic warnings.
- **Output Validator (Hallucination Judge)** — the post-hoc LLM-output checker in `@atlas/hallucination`. Runtime. Verdict / Issue / Supervision Level.

Always qualify in code comments, commit messages, and PR descriptions to avoid conflation.
