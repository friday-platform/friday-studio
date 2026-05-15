# complete() tool-call eval

Targeted promptfoo eval for the FSM's auto-injected `complete()` tool — the code path PR #303 fixes. Each YAML is a self-contained provider-matrix run.

## What this tests

Whether a model, given a `complete` tool whose `inputSchema` matches a workspace `outputType:`, will call it once with all required fields populated and correctly typed. Mirrors the wire-level contract the FSM ships to the provider.

Five cases cover the schema shapes used by the workspace.yml fixtures:

| Case | Shape | Source schema |
|---|---|---|
| 1 | 1 required string | smoke test |
| 2 | 3 flat primitives | `ReviewResult` |
| 3 | primitive + `string[]` | `ArrayReviewResult` |
| 4 | primitive + array of nested objects | `EmailBatch` (regression surface for `additionalProperties` propagation) |
| 5 | 4 fields incl. boolean | `AgentHydrationResult` |

Each case has a `case-N-*.yaml` (post-PR-#303 wire shape: `additionalProperties: false` recursively, `strict: true`, `tool_choice: { type: tool, name: complete }`) and a `case-N-pre-fix.yaml` (pre-PR-#303 wire shape: permissive schema, no strict flag, no forced tool choice).

Both variants use the **same** tool description string the production FSM ships (`fsm-engine.ts:1461-1462`) — only the wire-level flags differ. Earlier revisions of these YAMLs gave the post-fix variant a tailored description that leaked schema info via prose, which inflated post-fix pass rates relative to what the FSM actually does at runtime.

## Running

```
set -a && source ~/.atlas/.env && set +a
export OPENROUTER_API_KEY="$OPENAI_API_KEY"
cd tools/qa/complete-eval
for c in case-*.yaml; do
  echo "=== $c ==="
  npx promptfoo@latest eval --config "$c" --no-cache --repeat 5 2>&1 | tail -6
done
```

`--repeat 5` runs each cell 5× so the pass rate carries signal (n=1 conflates a missed tool call with a real regression for non-deterministic models).

Required env: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (we alias from `OPENAI_API_KEY` since `~/.atlas/.env` stores an OpenRouter key under that name).

## Why not the daemon suite

The daemon-based `first-principles` suite exercises the *full* FSM pipeline — useful for end-to-end regression but burns 50K+ tokens per run and conflates `complete()` correctness with FSM context engineering. This suite isolates the `complete()` contract: one HTTP call per provider per case (×5 with `--repeat`), under a minute for the full 5×3×5 matrix, ~10K tokens total.

## Validated delta (PR #303)

Measured 2026-05-15 with the production description, n=5 per cell, across four providers:

- `anthropic:messages:claude-sonnet-4-6`
- `groq:meta-llama/llama-4-scout-17b-16e-instruct`
- `openrouter:openai/gpt-oss-120b` (free)
- `openrouter:nvidia/nemotron-3-super-120b-a12b:free`

| Case | Anthropic pre→post | Groq pre→post | OR gpt-oss-120b pre→post | OR nemotron-super pre→post |
|---|---|---|---|---|
| 1 (1-field smoke) | 5/5 → 5/5 | 5/5 → 5/5 | 5/5 → 5/5 | 5/5 → 5/5 |
| 2 (3 primitives, `ReviewResult`) | 4/5 → 5/5 | 0/5 → 0/5 | 5/5 → 5/5 | 5/5 → 5/5 |
| 3 (primitive + `string[]`) | **1/5 → 5/5** | 5/5 → 4/5 | 5/5 → 5/5 | 5/5 → 5/5 |
| 4 (array of nested objects) | 5/5 → 5/5 | 5/5 → 5/5 | 5/5 → 5/5 | 5/5 → 5/5 |
| 5 (4 fields incl. boolean) | 3/5 → 5/5 | 0/5 → 0/5 | 5/5 → 5/5 | 5/5 → 5/5 |
| **Totals** | **18/25 → 25/25 (72% → 100%)** | 15/25 → 14/25 (60% → 56%) | **25/25 → 25/25 (100%)** | **25/25 → 25/25 (100%)** |

**The fix's measurable effect in this eval is the Anthropic column.** Case 3 (Anthropic 1/5 → 5/5) is the cleanest signal: forced `tool_choice: { type: tool, name: complete }` stops sonnet from emitting a natural-text response instead of a tool call. Cases 2 and 5 show smaller Anthropic lifts via the same mechanism.

**Groq results don't validate the fix.** The post-fix YAMLs flip `strict: true` on the tool function (OpenAI's convention). The production FSM engages Groq strict mode via Vercel AI SDK's `providerOptions.groq.strictJsonSchema: true` (`llm-provider-adapter.ts:169-170`), which the SDK translates to a different wire shape (Groq's `response_format: json_schema`). Either path may or may not engage Groq's constrained-decoding for llama-4-scout — empirically, the eval's Groq column is dominated by the model emitting `"count": "12"` (string), which Groq's server-side tool-call validator rejects with HTTP 400 (`code: tool_use_failed`) regardless of which flag we send. Cases 2 and 5 are 0/5 in both columns for that reason. The case-3 one-cell drop (5/5 → 4/5) is within n=5 noise. The daemon-based `first-principles` suite, which uses the real FSM→AI-SDK→Groq path, is the authoritative Groq test.

The two OpenRouter columns are 100% on both sides — well-behaved models (`gpt-oss-120b` and `nemotron-3-super-120b-a12b`) follow the schema whether or not the wire flags are flipped. The earlier 4/5 on `gpt-oss-120b` case-2 post-fix did not replicate; treat it as n=5 noise.
