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

## Running

```
set -a && source ~/.atlas/.env && set +a
export OPENROUTER_API_KEY="$OPENAI_API_KEY"
cd tools/qa/complete-eval
for c in case-*.yaml; do
  echo "=== $c ==="
  npx promptfoo@latest eval --config "$c" --no-cache 2>&1 | tail -6
done
```

Required env: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (we alias from `OPENAI_API_KEY` since `~/.atlas/.env` stores an OpenRouter key under that name).

## Why not the daemon suite

The daemon-based `first-principles` suite exercises the *full* FSM pipeline — useful for end-to-end regression but burns 50K+ tokens per run and conflates `complete()` correctness with FSM context engineering. This suite isolates the `complete()` contract: one HTTP call per provider per case, ~17 seconds for the full 5×3 matrix, ~2K tokens total.

## Validated delta (PR #303)

Run on 2026-05-15: **pre-fix 12/15 (80%), post-fix 15/15 (100%)** across Anthropic claude-sonnet-4-6, Groq llama-4-scout, OpenRouter openai/gpt-oss-120b. Three failure modes the fix prevents:

- **Groq scout type coercion** (cases 2, 5): `count: "12"` (string) instead of `12` (number) without wire-level constrained decoding
- **Anthropic skipping the tool** (case 3): natural-text response instead of tool call without forced `tool_choice`
