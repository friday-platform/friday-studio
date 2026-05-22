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

`deno task evals:promptfoo` runs all suites in a **single** `promptfoo eval`
invocation — promptfoo's `-j` is a global worker pool, so one invocation across
N configs schedules better than N sequential invocations. The wrapper script
lives at `scripts/run-all.sh`.

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
| `EVAL_CONCURRENCY` | `-j N` (default 20). |
| `PROMPTFOO_PASS_RATE_THRESHOLD` | Promptfoo built-in: exit code 100 if pass rate < N. |

Anything after `--` is passed through to promptfoo:

```bash
deno task evals:promptfoo -- --filter-pattern simple-substitution
```

## CI integration

Promptfoo's `eval` command returns **exit 100** when there are test failures
*or* the pass rate is below `PROMPTFOO_PASS_RATE_THRESHOLD`. Standard CI shape:

```bash
EVAL_TIER='small|medium' \
PROMPTFOO_PASS_RATE_THRESHOLD=95 \
  deno task evals:promptfoo -- -o results.json
```

GitHub Actions step exits non-zero on pass-rate regression. No bespoke
threshold parsing required — promptfoo handles it.

## Layout

```
tools/evals/promptfoo/
├── shared/
│   ├── providers.yaml         # single source of truth — tier:* labels select subsets
│   └── defaultTest.yaml       # latency floor + pinned grader provider
├── litellm/
│   ├── litellm_config.yaml    # friday-sm / friday-md / friday-lg / friday-local
│   ├── start.sh               # docker run helper
│   └── README.md              # provider-by-provider env vars
├── scripts/
│   ├── render-all.ts          # discovers + runs every suite's render.ts (parallel)
│   ├── render-shared.ts       # shared types + writeGeneratedTests() helper
│   └── run-all.sh             # backs `deno task evals:promptfoo`
└── suites/
    ├── progress-line/           # static-prompt suite (status-line generation)
    ├── title-generation/        # static-prompt suite (conversation titles)
    ├── prompt-interpolation/    # function-wrapping suite
    │   ├── render.ts            # calls real interpolatePromptPlaceholders, writes tests.generated.yaml
    │   └── tests.generated.yaml # COMMITTED — regenerate via `deno task evals:render-promptfoo`
    └── agent-config-prompt/     # function-wrapping suite
        ├── render.ts            # calls real composeAgentPrompt, writes tests.generated.yaml
        └── tests.generated.yaml # COMMITTED — same workflow
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

## Adding a new model

1. Add a `- model_name: friday-<alias>` entry to `litellm/litellm_config.yaml`.
2. Add two provider entries to `shared/providers.yaml` (one `openai:chat:`
   variant, one `litellm:` variant) — both reuse the existing `*openai_config` /
   `*litellm_config` YAML anchors. Tag each label with the right
   `tier:small|medium|large`.
3. Restart the proxy. Every suite picks the new model up automatically — no
   per-suite edits.

## When NOT to migrate to promptfoo

Keep an eval in the Deno harness when:

- It needs `enterTraceScope` / `TraceEntry[]` inspection
- It calls `bundledAgentsRegistry` against `AgentContext`
- Scoring requires custom `llmJudge` semantics that don't map to
  promptfoo's `llm-rubric`

Move it here when:

- It's a pure system-prompt → response → assert loop
- Multi-model comparison adds signal
- Latency/cost regression matters

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
