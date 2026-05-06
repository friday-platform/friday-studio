# QA + Eval Plan: melodic-strolling-seal

**Date:** 2026-05-06
**Branch:** `worktree-melodic-strolling-seal` (37 commits ahead of main)
**Architectural plan:** `/Users/kenneth/.claude/plans/melodic-strolling-seal.md`
**Reviews:** `docs/reviews/2026-05-06-melodic-strolling-seal.md`, `docs/reviews/2026-05-06-melodic-strolling-seal-pass2.md`

## Goal

Empirically validate the "fan-out without fan-in" architectural change against a live daemon. The unit + integration tests landing per phase verify in-process behavior; this plan adds a layer that exercises real JetStream/NATS, real session lifecycle, and (where possible) measures the actual fan-in delta vs main.

The original symptom — `auto-triage` taking 4m 33s for 50 emails with 109k uncached input tokens on the supervisor's next turn — is hard to recreate exactly without real Gmail credentials. The plan substitutes a **synthetic Gmail MCP stub** that returns canned email payloads of comparable shape and size, so the comparison is reproducible and CI-friendly.

## Methodology

**Baseline-then-validate.** Run the same scenario twice:

1. **On `main`** (`worktree status: pre-fix`) — capture metrics into a JSON file.
2. **On `worktree-melodic-strolling-seal` HEAD** (post-fix) — capture the same metrics.
3. **Diff** the two — that's the user-visible delta.

Each scenario must be deterministic given the synthetic stub. Real LLM calls remain (cost: ~$0.10–0.30 per scenario depending on input size), so the scenarios run on demand, not in CI.

## What we measure

For each scenario, capture:

| Metric | Source | Why |
|---|---|---|
| Total wall time | session-complete timestamp − signal-trigger timestamp | The headline UX number |
| Supervisor input tokens (next-turn after job-tool call) | Last `step:complete.usage.inputTokens` for `workspace-chat` after the job tool returns | The actual fan-in metric |
| Cache read tokens | Same `step:complete.usage` | Tells us if prompt caching is working |
| Validator call count | Count `validate-with-llm` log entries | Phase 4 should halve this |
| Job-tool result shape | Inspect SSE `job-complete` payload | Compact `{artifactIds, summary}` vs legacy `{output: Document[]}` |
| Artifact count | `GET /api/artifacts?workspaceId=...&sessionId=...` | Phase 2.B — non-zero post-fix |
| Memory injection presence | Look for `<memory>` blocks in agent prompt logs | Phase 5 |
| `<retrieved_content>` envelope | Same | Phase 9 |
| Per-action skill filter applied | Action-skill `requested` vs `matched` debug log | Phase 1 |
| Validator skip count | `Skipping validation for tool-passthrough trace` debug logs | Phase 4 |

## Test infrastructure

### Daemon-as-fixture

Pattern reused from `apps/atlas-cli/src/cli.integration.test.ts`. Spawn a fresh `atlasd` against an isolated `FRIDAY_HOME=/tmp/friday-qa-<run-id>`, wait for `GET /health`, tear down at end.

```bash
FRIDAY_HOME=/tmp/friday-qa-$(date +%s) deno task atlas daemon start --detached
# wait for /health
# run scenario
# kill the daemon, rm -rf $FRIDAY_HOME
```

Per-run isolation keeps NATS/JetStream state separate. No cross-run contamination.

### Synthetic Gmail MCP stub

New `tools/qa/synthetic-mcp/gmail-stub.ts`. A minimal MCP server that:
- Implements `search_gmail_messages` — returns N canned email IDs (configurable; default 50).
- Implements `get_gmail_messages_content_batch` — returns 50 canned email bodies (id + from + subject + body).
- Implements `modify_gmail_message_labels` and `batch_modify_gmail_message_labels` — no-op `{ ok: true }`.

The stub is registered as `google-gmail` in the QA fixture workspace's MCP registry. Same tool surface as the real Gmail MCP; the auto-triage agent doesn't notice the difference.

Email payloads are sized to match real-world distribution (subject ~80 chars, body ~600 chars, total ~30KB for 50 emails — matches the original 4m 33s scenario's input shape).

### QA fixture workspace

`tools/qa/fixtures/inbox-zero-qa/workspace.yml` — a copy of the real Inbox Zero with:
- `google-gmail` server pointing at the synthetic stub
- `auto-triage` job unchanged
- No real credentials

### Harness scripts

`tools/qa/live-daemon/`:

- `harness.ts` — spins up the daemon, registers the fixture, exposes `runScenario(name)` that triggers + measures + tears down.
- `scenarios/auto-triage-baseline.ts` — runs `auto-triage` once, captures metrics, writes `tools/qa/results/<git-sha>-auto-triage.json`.
- `scenarios/<phase>.ts` — per-phase scenarios (see table below).
- `compare.ts <baseline.json> <branch.json>` — diffs two result files, prints the delta table.

Run:

```bash
# baseline on main
git checkout main
deno run -A tools/qa/live-daemon/scenarios/auto-triage-baseline.ts

# diff on this branch
git checkout worktree-melodic-strolling-seal
deno run -A tools/qa/live-daemon/scenarios/auto-triage-baseline.ts
deno run -A tools/qa/live-daemon/compare.ts tools/qa/results/MAIN_SHA-auto-triage.json tools/qa/results/HEAD_SHA-auto-triage.json
```

## Per-phase QA scenarios

Each scenario is one script under `tools/qa/live-daemon/scenarios/`. All run against the daemon-as-fixture; assertions print pass/fail; exit code reflects status so they can be chained in CI later.

| Phase | Scenario | Setup | Assertion |
|---|---|---|---|
| **1** | `phase-1-allowlist.ts` | Workspace + job whose action declares `tools: ["google-gmail/search_gmail_messages"]`. Trigger. | Agent fails to call `send_message` (not in allowlist) — `tools-list` event excludes it. Validator log shows the per-action filter ran. |
| **1.B** | `phase-1-bypass.ts` | Same workspace + `permissions: { dangerouslySkipAllowlist: true }` at job level. | All gmail tools available; `Bypassing per-agent tool allowlist` info-log present. |
| **2.A** | `phase-2-summary-field.ts` | Workspace with action declaring `summary: "Hand-written summary."` | `job-complete.summary` contains the author-declared text. |
| **2.B** | `phase-2-artifact-persist.ts` | Trigger auto-triage on synthetic Gmail. | `GET /api/artifacts?workspaceId=...&sessionId=...` returns ≥1 artifact tagged `source: fsm-engine:auto-triage:...`. |
| **2.C** | `phase-2-supervisor-flip.ts` | Trigger auto-triage from chat. | Workspace-chat's tool result is the **compact shape**: `{ success, sessionId, status, artifactIds: [...], summary: "..." }`, no `output` key. |
| **3** | `phase-3-scrubber.ts` | Workspace whose agent calls a stub MCP returning a >4KB blob. | `tool-output-available` event payload contains an `<artifact-ref:...>` placeholder, not the bytes. Artifact in object store. |
| **4** | `phase-4-validation-source-type.ts` | Multi-step FSM. Run twice — once with synthetic Gmail returning bulky tool-passthrough, once with structured LLM output. | Validator skips on tool-passthrough actions (`Skipping validation for tool-passthrough trace` count > 0); runs on LLM-generated content. |
| **5** | `phase-5-fsm-memory-injection.ts` | Workspace with a `notes` store pre-populated with 3 entries. Trigger an FSM action whose `tools:` does NOT declare `memory_save`. | Action prompt (visible in stream events) includes `<memory store="notes">` blocks. Action successfully calls `memory_save`. |
| **6** | `phase-6-ephemeral-cleanup.ts` | Trigger a job that creates an ephemeral artifact. Wait for session-complete. Force-tick the sweeper with `intervalMs: 100, now: completedAt + 25h`. | Artifact deleted from object store. |
| **6.B** | `phase-6b-promotion.ts` | Same as Phase 6 but the agent calls `memory_save` referencing the artifact id. | Artifact promoted to `kind: durable`, persists past sweep. |
| **7** | `phase-7-delegate.ts` | FSM action with `tools: [..., "delegate"]`. Delegate spawns a child. | Child's stream events flow through `data-delegate-chunk`. Parent's message buffer doesn't grow proportionally to child output. |
| **8** | `phase-8-budgets.ts` | Set `delegation.max_wall_time_ms: 5000`. Trigger a delegate that intentionally runs longer. | Clean failure: `{ ok: false, reason: "budget_exhausted: max_wall_time_ms" }` to parent. |
| **9** | `phase-9-retrieval-injection.ts` | Create 2 artifacts during a session, then trigger another LLM action in the same session. | Action prompt includes `<retrieved_content provenance="artifact:..." ...>` blocks for both artifacts. Cap respected (≤10). |
| **11** | `phase-11-provenance.ts` | Chat → triggers a job → job spawns a delegate. | Walk session lineage: chat sessionId → job sessionId via `parentSessionId`. `step:complete.usage` populated on each LLM call. |
| **12** | `phase-12-elicitations.ts` | Workspace WITHOUT bypass. FSM action calls `request_tool_access(toolName="forbidden_tool", reason="...")`. | `GET /api/elicitations?workspaceId=...` returns the new elicitation with `kind: "tool-allowlist"`. POST `/api/elicitations/:id/answer { value: "deny" }`; verify status flips. SSE feed receives the create + answer events. |
| **12.bypass** | `phase-12-bypass.ts` | Same FSM action with `permissions: { dangerouslySkipAllowlist: true }`. | Tool returns `{ ok: true, granted: true, reason: "bypass" }` immediately. No elicitation created. Info-log present. |

## Baseline benchmark — the auto-triage delta

The headline scenario. Run this on `main` to get the "before" numbers, then on the branch.

`tools/qa/live-daemon/scenarios/auto-triage-baseline.ts`:

```ts
const stub = await startSyntheticGmail({ emailCount: 50 });
const daemon = await startDaemon({ home: tmpDir });
await registerFixture(daemon, "inbox-zero-qa");

const t0 = Date.now();
const result = await triggerSignal(daemon, "fizzy-cauliflower-qa", "auto-triage", {});
const t1 = Date.now();

const metrics = {
  gitSha: await currentSha(),
  branchHasFanInFix: await brachHasCommit("90864b9"),  // supervisor flip
  wallTimeMs: t1 - t0,
  supervisorInputTokensNextTurn: extractFromLogs(daemon, "step:complete.usage.inputTokens", "workspace-chat"),
  supervisorCacheReadTokens: extractFromLogs(daemon, "step:complete.usage.cacheReadTokens", "workspace-chat"),
  validatorCallCount: countLogLine(daemon, "validate-with-llm completed"),
  validatorSkipCount: countLogLine(daemon, "Skipping validation for tool-passthrough"),
  jobToolResultShape: result.output !== undefined ? "legacy" : "compact",
  artifactCount: result.artifactIds?.length ?? 0,
  artifactCountInJetStream: await countArtifactsByWorkspace(daemon, "fizzy-cauliflower-qa"),
};

await writeFile(`tools/qa/results/${metrics.gitSha}-auto-triage.json`, JSON.stringify(metrics, null, 2));

await stopDaemon(daemon);
await stopSyntheticGmail(stub);
```

**Expected deltas (post-fix vs main):**

| Metric | Pre-fix (main) | Post-fix (this branch) | Delta |
|---|---|---|---|
| Wall time | ~4m–5m | ~3m–4m (validator skips + scrubber buy back ~30–60s) | -10–25% |
| Supervisor input tokens (next-turn) | ~5–10k (full Document[]) | ~200–500 (artifactIds + summary) | **-95%** |
| Validator call count | 1 per LLM action | 0 on tool-passthrough actions | -50% on multi-step jobs |
| `jobToolResultShape` | `legacy` | `compact` | shape flip |
| `artifactCount` | 0 (no real artifacts persisted, just labeled) | ~50 (real JetStream-backed) | n × |

The token-count delta is the load-bearing claim. If post-fix supervisor input drops <90%, something is wrong with the supervisor flip and this scenario will surface it.

## Evals

The repo has an eval framework at `tools/evals/` with two existing files in `agents/workspace-chat/`. Adding two more for prompt-behavior surfaces this branch introduced. Evals run **only** when `ANTHROPIC_API_KEY` is set; CI gates on `if: env.ANTHROPIC_API_KEY`.

### `tools/evals/agents/workspace-chat/prompt-behavior.eval.ts` (new)

The plan's `composeArtifactBlocks` introduces a `<retrieved_content>` envelope into the LLM prompt. This eval verifies the LLM **uses** the envelope correctly:

- **Case: `cites artifact when retrieved_content present`** — inject one `<retrieved_content provenance="artifact:abc123">` block, ask "summarize the artifact." Expect the response to mention `abc123` or content from the block. Fails if the LLM ignores the envelope.
- **Case: `parse_artifact when summary insufficient`** — inject a `<retrieved_content>` with summary "this is a long doc" and a hint that detail is needed. Expect a `parse_artifact(abc123)` tool call.
- **Case: `temporal facts respected`** — inject the standard temporal-facts block with a fixed date. Ask "what year is it?" Expect response cites the injected year, not the LLM's training cutoff.

### `tools/evals/agents/workspace-chat/elicitation-behavior.eval.ts` (new)

The plan's `request_tool_access` tool introduces a structured-denial response shape. This eval verifies the LLM responds correctly:

- **Case: `acknowledges pending_user_approval`** — set up: agent calls a tool not in allowlist; tool returns `{ ok: false, granted: false, elicitationId: "elic_xyz", reason: "pending_user_approval" }`. Expect: LLM responds with a user-facing acknowledgment ("I've requested permission; you should see a prompt") and either fails the step or routes around. Fails if the LLM retries or ignores.
- **Case: `uses bypass result silently`** — same setup but tool returns `{ ok: true, granted: true, reason: "bypass" }`. Expect: LLM proceeds with the tool call without surfacing the bypass to the user (operator-only signal).

## Sequencing

1. **Phase 1: harness primitives** — `harness.ts` + `daemon-as-fixture` + synthetic Gmail stub. Land first; everything else depends on it.
2. **Phase 2: baseline benchmark** — `auto-triage-baseline.ts`. Run on main, capture; run on branch, capture; commit results to `tools/qa/results/`.
3. **Phase 3: per-phase scenarios** — start with the highest-leverage (Phases 2.C, 1, 12); land the rest as time permits.
4. **Phase 4: evals** — write the two new eval files; gate on env var.
5. **Phase 5: doc the deltas** — append a "Measured outcomes" section to the architectural plan with the actual numbers.

## What this is NOT

- **Not full integration test coverage.** Existing vitest suites cover that; this plan is daemon-backed end-to-end validation.
- **Not a CI gate today.** Cost (real LLM calls) and runtime (each scenario takes 2–5 minutes) make it a manual / nightly run, not a per-commit gate.
- **Not a replacement for the real Gmail scenario.** The synthetic stub mimics the *shape* of the workload; live Gmail can still surface integration bugs that the stub won't (auth refresh, rate limits, real attachment bytes). Real-Gmail validation is a separate manual session.

## Files to create

| Path | Purpose |
|---|---|
| `tools/qa/live-daemon/harness.ts` | daemon spin-up/tear-down + signal trigger + log scrape |
| `tools/qa/synthetic-mcp/gmail-stub.ts` | canned-response Gmail MCP server |
| `tools/qa/synthetic-mcp/gmail-stub.fixtures.json` | 50 canned email payloads |
| `tools/qa/fixtures/inbox-zero-qa/workspace.yml` | QA fixture workspace |
| `tools/qa/live-daemon/scenarios/auto-triage-baseline.ts` | the headline benchmark |
| `tools/qa/live-daemon/scenarios/phase-{1,1-bypass,2-A,2-B,2-C,3,4,5,6,6b,7,8,9,11,12,12-bypass}.ts` | per-phase smoke tests |
| `tools/qa/live-daemon/compare.ts` | diff two result files |
| `tools/qa/results/.gitkeep` | results land here per-sha; gitignore the JSON |
| `tools/evals/agents/workspace-chat/prompt-behavior.eval.ts` | retrieval-content envelope eval |
| `tools/evals/agents/workspace-chat/elicitation-behavior.eval.ts` | request_tool_access response shape eval |

## Risks / known holes

- **Synthetic Gmail bypasses real auth-refresh path.** Phase 12 auth-refresh elicitation kind isn't yet implemented; when it is, real Gmail (or a stub that fakes a 401 once) is needed to validate.
- **Real LLM cost.** Each scenario triggers the auto-triage agent against a real model. Budget ~$0.10–0.30 per run. Scenarios are scripted so a full sweep is ~$5; acceptable for milestone runs, not per-commit.
- **Cache-warming variance.** First-run vs subsequent-run cache-read tokens differ by orders of magnitude. The benchmark should run each scenario twice and report the second-run number for consistency.
- **NATS server cold-start.** The daemon-as-fixture pattern includes embedded NATS startup (~2s). Factor into wall-time measurement; subtract from the metric or run a warm-up trigger first.
- **Per-phase scenarios assume the synthetic stub is unsurprising.** If the stub's response shape drifts from real Gmail, scenarios may pass while production fails. Cross-check the stub's tool-result shape against real Gmail responses periodically.

## Followups (not in scope)

- **CI integration** — wire the harness into a nightly GitHub Action with `ANTHROPIC_API_KEY` from secrets. Cap to a budget (max 10 scenarios per run).
- **Crystallization input layer** — Phase 11's parent-linkage data is now captured; a future eval validates that prior-run conditioning improves a follow-up run's path-fidelity.
- **Real-Gmail full-loop validation** — a separate manual scenario file that uses real credentials; runs once per release, not per-commit.
- **Web-client Activity page** — Phase 12.D (UI) lives in a different codebase; QA there is separate.
