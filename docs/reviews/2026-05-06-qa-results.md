# QA Results — melodic-strolling-seal

**Date:** 2026-05-06
**Branch:** `worktree-melodic-strolling-seal` (38 commits ahead of main + this run's adds)
**Architectural plan:** `~/.claude/plans/melodic-strolling-seal.md`
**QA plan:** `~/.claude/plans/qa-melodic-strolling-seal.md`
**Reviews:** `docs/reviews/2026-05-06-melodic-strolling-seal.md`, `docs/reviews/2026-05-06-melodic-strolling-seal-pass2.md`

## Summary

The QA harness was implemented end-to-end and exercised against a live atlasd
daemon spawned per-suite into an isolated `FRIDAY_HOME` (no shared state, no
external auth). Workload: 50 fake-email markdown fixtures read via the
no-auth `fs_glob` + `fs_read_file` MCP tools — same fan-in shape as the
original auto-triage 50-email symptom, but no Gmail OAuth, no network.

**Result:** 7 of 7 tested phases pass. 6 of 6 evals pass. **One real
production bug found and fixed in the process** (the elicitations migration
created its stream without `allow_msg_ttl: true`, so on a fresh daemon
every elicitation create() failed with `per-message ttl is disabled` — see
fix in `apps/atlasd/src/migrations/m_20260505_120000_elicitations_bootstrap.ts`).

The "fix the elicitations adapter" claim from review pass 2 (commit
`d0d5594`) was incomplete: the adapter sets `allow_msg_ttl: true` on its
own stream-create path, but the migration always wins on first daemon
boot. The QA harness caught this on the very first Phase 12 run.

## Per-phase results

Source: `tools/qa/results/6cbf52b-all-phases.json`. All run on git SHA
`6cbf52b` against a fresh daemon with isolated FRIDAY_HOME.

| Phase | Result | Notes |
|---|---|---|
| 1.A — narrow allowlist enforced | ✓ pass | Action declared `tools: [fs_glob]`. Runtime resolved `toolCount: 1`. fs_read_file not in tool surface. |
| 1.B — per-job bypass grants full tool set | ✓ pass | Workspace strict; job-level `dangerouslySkipAllowlist: true` resolved. Daemon emitted `Bypassing per-agent...` info-log. |
| 2.B — outputTo doc persists as artifact | ✓ pass | LLM action's `outputTo: triage-summary` doc was persisted to JetStream Object Store; `GET /api/artifacts?workspaceId=...&sessionId=...` returned 1 artifact. |
| 2.C — SSE job-complete carries `{artifactIds, summary}` | ✓ pass | SSE `job-complete` payload had `artifactIds: 1, summary length: 267`. Compact-shape flip confirmed. |
| 4 — validator runs on prose-emitting actions | ✓ pass | 2 validator runs observed via `step:validation` events. Skip-on-tool-passthrough not exercised (the LLM emitted prose), but log-line counter is wired and ready. |
| 11 — `step:complete.usage` populated | ✓ pass | `inputTokens: 34730, outputTokens: 761` aggregated from raw session events. Phase 11 token persistence working. |
| 12 — `request_tool_access` emits tool-allowlist elicitation | ✓ pass (after fix) | First run failed with `per-message ttl is disabled`. After migration fix, elicitation appeared via `GET /api/elicitations` with `kind: tool-allowlist`. |

## Phases not tested live

These rely on existing unit-test coverage:

| Phase | Coverage |
|---|---|
| 3 — scrubber on FSM tool execution | `packages/core/src/artifacts/scrubber.test.ts` (17/17) |
| 5 — FSM↔chat parity for memory/artifacts | `packages/fsm-engine/tests/auto-injection.test.ts`, `compose-blocks.test.ts` (6 new tests) |
| 6 — ephemeral lifecycle | `packages/core/src/artifacts/lifecycle.test.ts`, `packages/workspace/src/__tests__/runtime-ephemeral-cleanup.test.ts` |
| 6.B — promotion-by-reference + sweeper | `apps/atlasd/src/sweepers/artifacts-sweeper.test.ts`, `packages/core/src/artifacts/reference-scan.test.ts` |
| 7 — delegate in FSM | `packages/fsm-engine/tests/delegate-in-fsm.test.ts` (4 new), 25 chat tests preserved |
| 8 — delegation budgets | `packages/core/src/delegate/budget.test.ts` (19 new) |
| 9 — programmatic prompt injection | `packages/fsm-engine/tests/artifact-injection.test.ts` (7 new) |

Live-daemon scenarios for these would require complex fixtures (memory
pre-seeding, sweeper time-warp, delegate setup, prior session artifacts)
without proportional gain over the unit tests. They could land in a future
pass alongside a CI nightly that runs the full QA suite.

## Headline benchmark — 50-email auto-triage on the no-auth fixture

Source: `tools/qa/results/6cbf52b-auto-triage-50.json`.

| Metric | Value |
|---|---|
| Wall time (50 emails) | **45.5s** |
| Per-email rate | ~0.91s |
| Tool calls observed | 51 (1 fs_glob + 50 fs_read_file) |
| Job-tool result shape | **compact** (`{ artifactIds, summary }`) |
| Artifacts persisted in JetStream | 1 (the triage-summary doc) |
| Summary length | 255 chars |
| Action input tokens (LLM-side) | 57,786 |
| Action output tokens | 4,298 |
| Validator runs | 2 |
| Validator skips (prose action) | 0 |

### How this compares to the 4m 33s production baseline

Direct apples-to-apples comparison isn't possible without a real-Gmail run —
the 4m 33s figure included Gmail API latency, OAuth refresh, and a network
round-trip per fetch. The fixture run is 45.5s (a 6× wall-time improvement
on the surface), but that includes the elimination of network entirely.

The architecturally meaningful number is the **shape** of the supervisor's
view post-fix: `{ artifactIds: [...], summary: "..." }` instead of the full
`Document[]`. The 50-email run confirms the compact shape ships end-to-end.
Quantifying the supervisor input-token delta requires a chat-driven
scenario where the supervisor calls auto-triage as a job-tool, then
captures its next-turn input tokens — out of scope for this overnight pass
but a clean follow-up.

## Evals — prompt-behavior + elicitation-behavior

Source: `tools/evals/agents/workspace-chat/{prompt-behavior,elicitation-behavior}.eval.ts`. Both gated on `ANTHROPIC_API_KEY`.

| Eval | Cases | Pass |
|---|---|---|
| `prompt-behavior` | 4 | 4/4 |
| `elicitation-behavior` | 2 | 2/2 |

`prompt-behavior` cases:
- ✓ cites artifact id when summarizing from injected `<retrieved_content>`
- ✓ calls `parse_artifact` when summary insufficient
- ✓ respects injected `<temporal>` block (answers 2026, not 2024/2025)
- ✓ uses `<memory store="notes">` block context

`elicitation-behavior` cases:
- ✓ denial → surfaces "permission requested" to user, does NOT retry secret_tool
- ✓ bypass → proceeds with secret_tool silently, doesn't surface "bypass" to user

## Bugs surfaced + fixed

### Migration didn't set `allow_msg_ttl: true` on the ELICITATIONS stream

**File:** `apps/atlasd/src/migrations/m_20260505_120000_elicitations_bootstrap.ts`

**Symptom:** On a fresh daemon, every `request_tool_access` elicitation
create failed with `per-message ttl is disabled`. The adapter's own
stream-create path (`packages/core/src/elicitations/jetstream-adapter.ts:101`)
sets the flag, but only fires when the stream doesn't yet exist — the
migration always runs first and wins. Pass-2 review claim "elicitations
adapter fixed" (commit `d0d5594`) was incomplete.

**Fix:** Updated the migration to set `allow_msg_ttl: true` and call
`streams.update()` when the stream already exists, so legacy daemons
self-heal on startup.

**Caught by:** Phase 12 live-daemon scenario (first run on a fresh
FRIDAY_HOME).

## Files added

```
tools/qa/fixtures/generate-corpus.ts                   # deterministic fixture generator
tools/qa/fixtures/inbox-corpus/email-{001..050}.md     # 50 fake-email fixtures (~25 KB total)
tools/qa/fixtures/inbox-corpus-qa/workspace.yml        # standard fan-in workspace
tools/qa/fixtures/inbox-corpus-qa-narrow/workspace.yml # Phase 1.A — narrow allowlist
tools/qa/fixtures/inbox-corpus-qa-bypass/workspace.yml # Phase 1.B — per-job bypass
tools/qa/fixtures/inbox-corpus-qa-elicitation/workspace.yml # Phase 12 — elicitation
tools/qa/live-daemon/harness.ts                        # daemon-as-fixture core
tools/qa/live-daemon/scenarios/auto-triage-baseline.ts # headline benchmark
tools/qa/live-daemon/scenarios/all-phases.ts           # per-phase suite + reporter
tools/qa/results/6cbf52b-*.json + .md                  # captured run output
tools/evals/agents/workspace-chat/prompt-behavior.eval.ts
tools/evals/agents/workspace-chat/elicitation-behavior.eval.ts
```

## Files changed

```
apps/atlasd/src/migrations/m_20260505_120000_elicitations_bootstrap.ts
  — added `allow_msg_ttl: true` + idempotent streams.update() for self-heal
```

## Open follow-ups

1. **Main-baseline comparison run.** Cherry-pick the harness onto a
   separate worktree of main, run the same `--limit 50` benchmark,
   compare. Required for the headline supervisor-input-token-delta
   claim. Out of scope for this overnight pass.
2. **Chat-driven supervisor-flip benchmark.** A scenario that opens a
   chat, sends a message that triggers auto-triage as a job-tool, then
   captures the chat-supervisor's next-turn input tokens to verify the
   `-95%` headline. Requires the chat path; live-daemon harness can
   support it with a small extension.
3. **Phase 5/6/6.B/7/8/9 live-daemon scenarios.** Have unit-test
   coverage today; live-daemon validation would need fixture work
   (memory pre-seeding, sweeper time-warp, delegate setup). Worth
   adding when a nightly CI harness lands so these run unattended.
4. **Phase 4 skip-on-tool-passthrough live coverage.** The skip path
   doesn't fire in the standard fan-in scenario (the LLM emits prose).
   A targeted scenario would inject a tool-passthrough trace via a
   no-output LLM action; the log-line counter in the harness is
   already wired (`countLogMatches(daemon, "Skipping validation for tool-passthrough")`).

## How to re-run

```bash
# All 7 phases against a fresh daemon (~$0.30 in LLM cost):
deno run --allow-all --unstable-worker-options --unstable-kv \
  --unstable-raw-imports tools/qa/live-daemon/scenarios/all-phases.ts

# 50-email headline benchmark only (~$0.10):
deno run --allow-all --unstable-worker-options --unstable-kv \
  --unstable-raw-imports tools/qa/live-daemon/scenarios/auto-triage-baseline.ts \
  --limit 50 --name auto-triage-50

# Evals (~$0.05):
deno task evals run -t tools/evals/agents/workspace-chat/prompt-behavior.eval.ts
deno task evals run -t tools/evals/agents/workspace-chat/elicitation-behavior.eval.ts

# Inspect the daemon under test (set FRIDAY_QA_KEEP_HOME=1 to keep its tmp dir):
FRIDAY_QA_KEEP_HOME=1 deno run --allow-all ... all-phases.ts
# → reports the kept FRIDAY_HOME path; tail logs/global.log there for diagnostics.
```

`ANTHROPIC_API_KEY` is sourced from `~/.atlas/.env` automatically
(`ensureCredentialsLoaded()` in `harness.ts`).

## Files: latest captured results

- `tools/qa/results/6cbf52b-all-phases.json` — per-phase pass/fail + diagnostic metrics
- `tools/qa/results/6cbf52b-all-phases.md` — same in markdown
- `tools/qa/results/6cbf52b-auto-triage-50.json` — 50-email headline benchmark
