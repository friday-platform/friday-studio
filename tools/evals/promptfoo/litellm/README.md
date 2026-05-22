# LiteLLM proxy for Friday evals

One proxy on `localhost:4000` routes all friday-* model aliases to their
real backend. Promptfoo only knows the alias name — adding a new model
provider is a one-line edit to `litellm_config.yaml`, no code change in
any suite.

## Quickstart

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GROQ_API_KEY=gsk_...
export OPENAI_API_KEY=sk-...
export LITELLM_MASTER_KEY=sk-friday-evals-dev

./start.sh
# proxy listening on http://localhost:4000
```

## Model aliases

| Alias | Backend | Tier | Used in |
|---|---|---|---|
| `friday-sm` | `groq/llama-3.1-8b-instant` | cheap/fast | PR CI matrix |
| `friday-md` | `anthropic/claude-haiku-4-5` | balanced | PR CI matrix + dev default |
| `friday-lg` | `anthropic/claude-sonnet-4-6` | quality | nightly only |
| `friday-gpt` | `openai/gpt-4.1-mini` | cross-vendor signal | nightly only |
| `friday-local` | `ollama/llama3.1` | offline fallback | local dev only |
| `friday-embed` | `openai/text-embedding-3-small` | embeddings | `similar:` assertions |

## Why aliases (not raw model names)?

Because the suites should NOT change when:

- you swap Haiku 4.5 → Haiku 5 → Sonnet for the "balanced" tier
- you migrate from Anthropic native API to Bedrock
- you point local-dev runs at Ollama instead of paying for tokens

The alias is the contract: `friday-md` means "balanced quality, single
digit cents per call". Everything else is plumbing.

## Adding a new model

1. Add a `- model_name: friday-...` entry to `litellm_config.yaml`
2. Add a corresponding provider entry to `../shared/providers.yaml`
   (and `providers.pr.yaml` if cheap enough for PR CI)
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
