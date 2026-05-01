# @atlas/evals

Agent evaluation harness. Integration tests that run real agents against real
LLMs and score the results.

## Running Evals

Evals run through a custom runner CLI, not `Deno.test`.

```bash
deno task evals run                              # all evals
deno task evals run -t tools/evals/agents/email/email.eval.ts  # one file
deno task evals run --filter "refusal"           # by name substring
deno task evals run --fail-fast                  # stop on first failure
deno task evals run --verbose                    # show stack traces
```

**Unit tests (`lib/*.test.ts`) → vitest**

Harness infrastructure tests (scoring, output, context) use vitest.

```bash
deno task test tools/evals/lib/scoring.test.ts
```

## Eval File Structure

Every eval file exports an `evals: EvalRegistration[]` array. The runner
imports the file, reads the export, and executes each registration through
`runEval()`.

```ts
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { defineEval, type BaseEvalCase, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

interface MyCase extends BaseEvalCase {
  expected: string;
}

const cases: MyCase[] = [
  { id: "basic", name: "basic test", input: "hello", expected: "world" },
];

export const evals: EvalRegistration[] = cases.map((c) =>
  defineEval({
    name: `my-agent/${c.id}`,
    adapter,
    config: {
      input: c.input,
      run: async () => await myAgent(c.input),
      assert: (result) => { assertEquals(result, c.expected); },
      score: (result) => [createScore("accuracy", 1, "exact match")],
    },
  })
);
```

## Key Types

- **`EvalRegistration`** — the unit of execution: `{ name, adapter, config }`
- **`BaseEvalCase`** — base case shape: `{ id, name, input }`. Extend with domain fields.
- **`defineEval<T>()`** — typed builder that preserves generics across `run`/`score`/`assert`

## runEval Lifecycle

Three phases, in order:

1. **run** — execute the agent (required)
2. **assert** — pass/fail gate, throw to fail (optional)
3. **score** — numeric 0–1 metrics, always runs even if assert fails (optional)

Results written to `__output__/{evalName}/{timestamp}.json`.

## CLI Commands

```bash
deno task evals run                  # Run evals
deno task evals list                 # List available eval files
deno task evals report               # Show summary of latest results
deno task evals report --failures    # Only failures
deno task evals inspect -e name      # Show full transcript for an eval
deno task evals compare --before <tag> --after <tag>  # Compare two runs
```

## Conventions

- Eval names use path-style: `"email/refusal/prompt-injection"`
- `loadCredentials()` at module top level, not inside eval callbacks
- Scoring uses `createScore(name, value, reason)` — value must be `[0, 1]`
- `llmJudge()` for semantic scoring when rule-based isn't enough
- Case interfaces extend `BaseEvalCase` — domain-specific fields go on the
  extending interface, assert/score logic stays in registration mapping

## Gotchas

- `defineEval<T>()` uses `as unknown as EvalRegistration` — accepted existential
  type workaround (TS lacks `∃T. EvalConfig<T>`)
- gunshi positional args in subcommands get consumed by parent arg parser — use
  named flags (`-e`, `-F`) for subcommand args
- `EvalResult` has no `pass` field — pass/fail is inferred from
  `metadata.error` presence. The `Score` type's optional `reason` field maps to
  `scoreReasons` in compare output.

## Adding a New Eval

1. Create `agents/{agent-name}/{agent-name}.eval.ts`
2. Follow the file structure above — export `evals: EvalRegistration[]`
3. Define cases extending `BaseEvalCase`, map to registrations with `defineEval()`
4. Run with `deno task evals run -t tools/evals/agents/{agent-name}/{agent-name}.eval.ts`
5. Check `__output__/` for results
