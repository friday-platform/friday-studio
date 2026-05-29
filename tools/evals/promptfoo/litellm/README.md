# LiteLLM proxy for Friday evals

One proxy on `localhost:4000` routes all friday-* model aliases to their
real backend. Promptfoo only knows the alias name — adding a new model
provider is a one-line edit to `litellm_config.yaml`, no code change in
any suite.

## Quickstart

Prerequisite: a running Docker daemon (`docker info` should succeed).
`start.sh` runs the upstream `ghcr.io/berriai/litellm` image pinned to a
concrete version (`v1.86.2`) with `litellm_config.yaml` mounted in, so no
local Python toolchain is needed.

The tag is pinned (not `:main-stable`) so eval cost/behavior stays
reproducible — a moving tag is what caused the `x-litellm-response-cost`
header rename to silently break cost capture. To bump: change the tag in
`start.sh`, then confirm the cost-header name the proxy emits still matches
what the elicitation handler reads (LiteLLM renamed it at `>=1.86`).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GROQ_API_KEY=gsk_...
export LITELLM_MASTER_KEY=sk-friday-evals-dev
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"  # runner uses same bearer the proxy validates

./start.sh
# proxy listening on http://localhost:4000
```

## Model aliases

| Alias | Backend | Tier label | Use |
|---|---|---|---|
| `friday-sm` | `groq/llama-3.1-8b-instant` | `tier:small` | cheap CI / smoke runs |
| `friday-md` | `anthropic/claude-haiku-4-5` | `tier:medium` | PR matrix + dev default |
| `friday-lg` | `anthropic/claude-sonnet-4-6` | `tier:large` | nightly quality run |
| `friday-local` | `ollama/llama3.1` | (no tier) | offline fallback |

Tier labels live in `../shared/providers.yaml` and gate
`--filter-providers` selection — see the parent README for `EVAL_TIER` usage.

## Why aliases (not raw model names)?

Because the suites should NOT change when:

- you swap Haiku 4.5 → Haiku 5 → Sonnet for the "balanced" tier
- you migrate from Anthropic native API to Bedrock
- you point local-dev runs at Ollama instead of paying for tokens

The alias is the contract: `friday-md` means "balanced quality, single
digit cents per call". Everything else is plumbing.

## Adding a new model

1. Add a `- model_name: friday-...` entry to `litellm_config.yaml`
2. Add a corresponding provider entry to `../shared/providers.yaml`,
   tagged `tier:small|medium|large` in its label so `EVAL_TIER`
   filtering keeps working
3. Restart the proxy (`Ctrl+C` then `./start.sh` again)
4. Run a suite to confirm — every test now also runs against the new
   model with no per-suite edits

## Health check

```bash
curl -s http://localhost:4000/health \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq
```

## Gotchas

- **`apiBaseUrl` suffix**: promptfoo's `openai:` provider expects
  `http://localhost:4000/v1`; the native `litellm:` provider expects
  `http://localhost:4000` (no `/v1`). Mixing them is the #1 cause of
  404s. The shared providers file gets both right.
- **Proxy cache disabled**: `cache: false` in `litellm_config.yaml`.
  Promptfoo's `--no-cache` only disables its own disk cache; a Redis
  cache here would mask the `latency` assertion.
- **Tool calls**: `modify_params: true` lets prompts written for
  OpenAI's tool-call shape pass through to Anthropic. Drop this
  setting once all suites use a single canonical tool shape.
- **Streaming-only models**: some Ollama/Bedrock combos only stream,
  leaving `usage` empty. The shared `defaultTest.yaml` sets
  `stream: false` to keep cost assertions honest.
