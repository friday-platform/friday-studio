# Friday Promptfoo Suites

Daemon-free, multi-model, parallel-runnable evals for pure prompt/agent
behavior. Sits alongside the trace-aware custom harness in
`tools/evals/lib/` + `tools/evals/agents/`, which stays the home for
evals that need `AgentContextAdapter` or full `@atlas/llm` trace plumbing.

## What lives where

| | tools/evals/agents/*.eval.ts | tools/evals/promptfoo/suites/* | tools/qa/live-daemon/promptfoo/* |
|---|---|---|---|
| Runner | custom Deno harness | promptfoo CLI | promptfoo CLI |
| Daemon required | no | **no** | yes |
| Multi-model | hand-rolled per suite | shared provider matrix | single provider per suite |
| Parallel | `-j N` (default 1) | `-j N` global pool | sequential |
| Trace capture | `enterTraceScope` | none | none |

## Quickstart

```bash
# 1. Start the LiteLLM proxy once (routes friday-sm/md/lg → real providers)
cd tools/evals/promptfoo/litellm && ./start.sh   # see litellm/README.md for env vars

# 2. Run every suite × every model in one parallel sweep
deno task evals:promptfoo

# 3. Or just the small tier (PR-CI cost profile)
EVAL_TIER=small deno task evals:promptfoo

# 4. Or a single suite the long way
npx promptfoo@latest eval \
  -c tools/evals/promptfoo/suites/progress-line/promptfooconfig.yaml \
  --no-cache --no-share -j 20
```

`deno task evals:promptfoo` launches every suite as a parallel background
`promptfoo eval` invocation, captures per-suite JSON output, and prints a
pass-rate table at the end. The wrapper script lives at `scripts/run-all.sh`.

Per-suite (not merged) invocation is deliberate — promptfoo's multi-config
merge uses the first config's `basePath` to resolve `file://` vars across ALL
configs, which breaks suites that reference per-suite prompts like
`file://prompts/claude-code.txt`.

## Picking a model tier

Every provider entry in `shared/providers.yaml` has a `tier:<small|medium|large>`
tag baked into its label:

```yaml
- id: openai:chat:friday-sm
  label: 'groq-8b (openai) | tier:small'
```

Pick a subset at run time — `EVAL_TIER` accepts a regex alternation:

```bash
EVAL_TIER=small               deno task evals:promptfoo    # cheap CI
EVAL_TIER='small|medium'      deno task evals:promptfoo    # PR matrix
EVAL_TIER=large               deno task evals:promptfoo    # nightly quality run
# unset                       → full matrix
```

Under the hood the wrapper forwards
`--filter-providers 'tier:(small|medium|large)'` to promptfoo, which regex-matches
provider id/label. Add a new tier by tagging providers — no config files to fork.

Other knobs the wrapper honors:

| Env var | Effect |
|---|---|
| `EVAL_TIER` | Forwarded as `--filter-providers 'tier:<regex>'`. |
| `EVAL_CONCURRENCY` | `-j N` PER suite (default 20). |
| `PROMPTFOO_SUITE_FLOOR` | Exit 100 if **any** suite's pass rate < N (default 70). Suites that errored out with no parseable JSON count as failing the floor. |
| `PROMPTFOO_AGGREGATE_CEILING` | Exit 100 if the **aggregate** pass rate across all suites < N (default 85). |

Anything after `--` is passed through to promptfoo:

```bash
deno task evals:promptfoo -- --filter-pattern simple-substitution
```

## CI integration

The wrapper aggregates per-suite JSON output and exits 100 if EITHER any
single suite falls below `PROMPTFOO_SUITE_FLOOR` OR the aggregate pass rate
across all suites falls below `PROMPTFOO_AGGREGATE_CEILING`. Per-suite floors
catch a single-suite regression that would otherwise be diluted into the
aggregate (e.g. a complete elicitation breakage is ~6% of the aggregate, well
within a 90% ceiling). Standard CI shape:

```bash
EVAL_TIER='medium' \
PROMPTFOO_SUITE_FLOOR=70 \
PROMPTFOO_AGGREGATE_CEILING=85 \
  deno task evals:promptfoo
```

Per-suite JSON outputs land in a temp dir printed at the top of the run (`▶
outputs: …`), kept so individual results can be diffed across runs.

## Layout

```
tools/evals/promptfoo/
├── shared/
│   ├── providers.yaml              # stock-provider matrix (4 text-only suites)
│   ├── defaultTest.yaml            # pinned grader provider (no floor assertions)
│   └── providers/
│       ├── deno-worker.cjs         # Node↔Deno bridge for tool-capturing suites
│       └── worker.ts               # long-lived Deno dispatcher (JSON Lines on stdin/stdout)
├── litellm/
│   ├── litellm_config.yaml         # friday-sm / friday-md / friday-lg / friday-local
│   ├── start.sh                    # uv-run helper
│   └── README.md                   # provider-by-provider env vars
├── scripts/
│   ├── render-all.ts               # discovers + runs every suite's render.ts (parallel)
│   ├── render-shared.ts            # shared types + writeGeneratedTests() helper
│   └── run-all.sh                  # backs `deno task evals:promptfoo`
└── suites/
    ├── progress-line/              # static-prompt — status-line generation
    ├── title-generation/           # static-prompt — conversation titles
    ├── prompt-interpolation/       # function-wrapping — interpolatePromptPlaceholders
    │   ├── render.ts               # writes tests.generated.yaml
    │   └── tests.generated.yaml    # COMMITTED — regenerate via `deno task evals:render-promptfoo`
    ├── agent-config-prompt/        # function-wrapping — composeAgentPrompt
    │   ├── render.ts
    │   └── tests.generated.yaml
    ├── workspace-chat-elicitation/    # tool-capturing — request_tool_access shapes
    │   └── handler.ts              # Deno code, runs via shared/providers/deno-worker.cjs
    ├── workspace-chat-bundled-agent/  # tool-capturing — bundled-atlas vs MCP choice
    │   └── handler.ts
    └── workspace-chat-agent-type/     # tool-capturing — atlas|user|llm choice
        ├── handler.ts
        └── assertions/check.js     # shared per-case constraint check
```

## The "pre-render" pattern

Two of the three suites wrap a real Friday prompt-building function
(`interpolatePromptPlaceholders` in `@atlas/fsm-engine`,
`composeAgentPrompt` in `apps/atlasd/src/agent-helpers.ts`). Those
functions live in Deno workspace packages; promptfoo runs in Node.

Each such suite ships a `render.ts` that:
1. Defines its cases as data (templates, configs, expectations)
2. Calls the real function once per case
3. Writes a `tests.generated.yaml` via `writeGeneratedTests()` from
   `scripts/render-shared.ts`

The generated YAML is committed — promptfoo runs zero-build at eval time.
Edit cases → `deno task evals:render-promptfoo` → run the eval.

The renderer also enforces structural pre-checks (e.g. "this template,
after interpolation, must contain X" / "must not contain `{{`"). If the
function regresses, the renderer fails before promptfoo calls any model
— same protection the original eval's `assert:` callback provided, just
hoisted to generation time.

Suites whose user-message is hand-authored (e.g. `progress-line`) skip
the renderer.

## Adding a new suite

**Static-prompt suite** (like `progress-line`):

1. `mkdir suites/<name> && touch suites/<name>/promptfooconfig.yaml`
2. Point `providers: file://../../shared/providers.yaml` and
   `defaultTest: file://../../shared/defaultTest.yaml`.
3. Write prompts under `prompts/` (one file per system-prompt variant).
4. Write `tests.yaml` with one entry per case (`vars`, `description`,
   per-case `assert`).
5. Run with `deno task evals:promptfoo` — auto-discovered.

**Function-wrapping suite** (like `prompt-interpolation` /
`agent-config-prompt`):

1. Create `suites/<name>/render.ts` — imports the Friday function,
   defines cases, calls the function, writes via
   `writeGeneratedTests(import.meta.url, "<fn name>", tests)`.
2. Point `tests: file://tests.generated.yaml` in the config.
3. Run `deno task evals:render-promptfoo` once to produce the file.
4. Commit the generated file. Regenerate whenever cases or the
   underlying function change.

## Tool-capturing suites (workspace-chat-*)

These suites assert on the model's **tool calls**, not just text. The
contract is:

- A per-suite `handler.ts` (Deno) defines the synthetic tool surface with
  `execute()` closures that capture call args, then runs `streamText` with
  the real `@atlas/llm` registry and real production prompts. No daemon,
  no real side effects.
- The shared `shared/providers/deno-worker.cjs` (Node) spawns ONE
  long-lived Deno worker per handler, talks JSON-Lines on stdin/stdout,
  and is reused across all provider entries in the suite.
- Assertions in `tests.yaml` use `type: javascript` to parse the handler's
  JSON output (text + captures) and check structural constraints.

Provider entries in these suites reference the bridge directly:

```yaml
providers:
  - id: file://../../shared/providers/deno-worker.cjs
    label: 'friday-md (haiku via registry) | tier:medium'
    config:
      handler: tools/evals/promptfoo/suites/<suite>/handler.ts
      registryId: 'anthropic:friday-md'
```

The handler resolves the model by calling
`registry.languageModel(req.config.registryId)`. The registry transparently
routes through the LiteLLM proxy when `LITELLM_API_KEY` is set — see
`packages/llm/src/registry.ts`.

These suites omit `tier:small` because Groq llama-3.1-8b's free-tier
6k TPM cap can't fit the workspace-chat system prompt (9k+ tokens).
Re-enable when a higher-context small-tier provider lands.

## Adding a new model

1. Add a `- model_name: friday-<alias>` entry to `litellm/litellm_config.yaml`.
2. Add a provider entry to `shared/providers.yaml` (uses the existing
   `*openai_config` anchor). Tag the label with `tier:small|medium|large`.
3. For tool-capturing suites, add the alias to each workspace-chat
   `promptfooconfig.yaml`'s `providers:` block as
   `registryId: '<sdk-provider>:friday-<alias>'`.
4. Restart the proxy.

## When NOT to migrate to promptfoo

Keep an eval in the Deno harness when:

- It needs `enterTraceScope` / `TraceEntry[]` inspection (this is why
  `agents/web/web.eval.ts` is still custom — it scores on
  `snapshotBeforeInteract`, `stepEfficiency`, `errorRecovery` metrics that
  parse intermediate trace entries).
- Scoring requires custom `llmJudge` semantics that don't map to
  promptfoo's `llm-rubric`.

Move it here when:

- The signal is text or tool-call shape (both fit promptfoo via stock or
  deno-worker providers).
- Multi-model comparison adds signal.

## Gotchas discovered during integration

- **Python 3.14 breaks `uvloop`.** Install with `uv tool install --python
  3.13 'litellm[proxy]'`. The bare `uv tool install` picks 3.14 on this
  machine and crashes on import.
- **Promptfoo `cost` assertion can't read LiteLLM cost headers.** Cost
  is in `x-litellm-response-cost`, not the OpenAI response body. The
  shared `defaultTest.yaml` omits `cost` for this reason; add it
  per-suite only when the provider surfaces cost in-band.
- **Promptfoo passes assertion `value` through Nunjucks.** Bare `{{` or
  `}}` in a `not-contains` value crashes with "expected expression, got
  end of file". Use `not-regex` with escaped braces (`\\{\\{`) instead.
- **JS `RegExp` doesn't support inline `(?i)`.** Use character classes
  (`[Ii]`) for case-insensitivity in `regex`/`not-regex` assertions, or
  switch to `not-icontains` for literals.
- **`prompts:` listing N files cross-products with every test.** For
  multi-system-prompt suites use a single `chat.json` template with
  `{{system_prompt}}` injected per-test via `vars`.
- **`--filter-providers` is a regex against id + label.** The
  `tier:<size>` tag in each provider's label is what makes
  `EVAL_TIER=small` work — keep the tag intact when editing labels.
