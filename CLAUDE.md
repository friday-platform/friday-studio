# Friday

AI agent orchestration platform. Workspaces run autonomous agents triggered by
signals (HTTP, cron).

## Your Role

Challenge assumptions. Push back on complexity. Ask "who needs this?" and what's
the simplest version?" before building. Be a sparring partner, not a yes-man.

## Tech Stack

- Deno + TypeScript (core platform)
- Go (operator, auth, supporting services)
- @atlas/fsm-engine (state machines, workflows)
- Zod v4 (all external input validation)
- Hono (HTTP framework)

## Active vs Deprecated UI / Agent Paths

**Active:** `agent-playground` (SvelteKit web client) uses `workspace-chat.agent.ts`
exclusively. All chat UI work goes here.

**Deprecated (reference only):** `conversation-agent` and the old `web-ui` are no
longer used. Do not add features to them or treat their patterns as canonical — they
exist only as historical reference.

## Commands

```bash
# Deno/TypeScript
deno task typecheck       # Type check (deno check + svelte-check)
deno task lint          # Lint
deno task test $file    # Run tests (vitest)
deno task evals run                 # Run evals (custom runner CLI)
deno task start         # Run daemon

# Go
go fmt ./...            # Format
golangci-lint run       # Lint
go test -race ./...     # Test with race detector
go build                # Build
```

## Hard Rules

- When fixing lint errors, remove dead code entirely — don't just prefix unused
  variables with `_` to silence the linter. Trace the dependency chain and
  delete everything that's only reachable from the unused symbol.

- Use `@atlas/logger`, never `console.*` (`proto/` and `tools/` CLI tools are
  exempt)
- No `any` types - use `unknown` or proper types
- No `as` assertions - use Zod schemas for parsing. `as const` on string
  literals for discriminated unions is OK. `!` (non-null assertion) is same
  family — use `?? fallback` or `if (!x) throw` instead.
  Exceptions: `ValidatedJSONSchema` properties (typed `unknown` from `z.lazy`)
  and `JSON.parse` in test helpers before immediate Zod parse
- Static imports only (top of file) - no `import("@pkg")` in type positions
- Validate all external input with Zod
- Use `node:*` builtins (`node:path`, `node:process`, etc.), not Deno APIs
  (`Deno.env`) — migrating away from Deno APIs
- Dependencies go in `package.json`, not `deno.json` (use `deno add npm:pkg`)
- All database queries acting on behalf of a user MUST use `withUserContext()`
  — never construct raw SQL outside an RLS-enforced transaction. This sets
  `SET LOCAL ROLE authenticated` and `request.user_id`, so RLS policies enforce
  row-level isolation even if app code has a bug. Cross-user lookups (e.g.
  ownership checks) use SECURITY DEFINER functions, not superuser queries.
  See `apps/link/src/adapters/rls.ts` for the implementation.

## Gotchas

### Zod v4

- `z.object()` strips unknown keys by default — removing fields from a schema
  is sufficient to reject them, no `.strict()` needed
- `z.discriminatedUnion` rejects duplicate discriminator values — use `z.union`
  as fallback (`z.infer` produces identical TS union types)
- `Omit<ZodInferredType, "field">` triggers TS2589 with `strictObject` types —
  define explicit interfaces for derived types instead
- `z.toJSONSchema()` returns deeply typed JSON Schema — parse through a Zod
  schema to avoid TS2589 when converting to `ValidatedJSONSchema`
- Zod discriminated unions cause deep type instantiation with AI SDK's
  `generateObject` generic — split into per-type schemas
- `z.record()` requires two args (key schema, value schema) — v3 accepted one
- `as const` on whole objects makes arrays readonly — incompatible with `string[]`
  from Zod infer; annotate with target type or use targeted `as const` on
  individual literal fields
- `z.enum()` requires `[string, ...string[]]` (non-empty tuple) — cast needed
  when building from dynamic arrays
- `z.infer` on schemas containing `z.lazy()` triggers TS2589 — use explicit
  interfaces instead
- `z.strictObject().extend()` — adding a required field breaks ALL downstream
  fixture/test data; coordinate changes in the same commit

### AI SDK (Vercel) v5

- `tool()` requires `jsonSchema()` for `inputSchema`, not `z.object()` for
  `parameters` — wrong one causes overload resolution to fail silently
- `TypedToolCall` uses `input` property, not `args`
- `stopWhen: stepCountIs(N)` replaces `maxSteps`, `maxOutputTokens` replaces
  `maxTokens`
- When agents switch from MCP-routed to direct `tool({ execute })` invocation,
  output shape changes from MCP envelope (`result.content[].text`) to raw
  payload — downstream parsers silently fail
- `@ai-sdk/provider` is not re-exported by the `ai` package — add as explicit
  dep, pin to `^3.0.8` for ai@6 compatibility (`LanguageModelV3` lives there)
- `@atlas/llm` re-exports `LanguageModelV3` from `@ai-sdk/provider` — but
  `@atlas/agent-sdk` is a leaf node (no `@atlas/*` deps allowed), so it defines
  `PlatformModels`/`PlatformRole` locally instead of importing from `@atlas/llm`
- `LanguageModelV2ToolCall.input` is stringified JSON, not parsed — must
  `JSON.parse` for extraction
- `LanguageModelV2`'s `doGenerate`/`doStream` return `PromiseLike<T>` — `async`
  is structurally required even without `await`, use lint-ignore not removal

### Hono

- `.use()` middleware validators run at runtime but don't propagate input types
  to chained route handlers — `c.req.valid("param")` only resolves when
  `zValidator("param", ...)` is inline on the route handler itself

### Deno

- `deno check` with multiple entry points sharing recursive `z.lazy()` types
  can trigger TS2589 — check files separately
- deno.json import map only maps root (`@atlas/pkg` → `mod.ts`) — subpath
  imports like `@atlas/pkg/sub/path` don't resolve; re-export from `mod.ts`
- Package-level deno.json needs explicit import map entries for cross-package
  `@atlas/*` deps — root deno.json handles runtime, but `deno check` within
  package scope needs them
- `@atlas/core` barrel import (`mod.ts`) pulls `@db/sqlite` (FFI) — web client
  and test code must use subpath exports (e.g. `@atlas/core/session/types`) to
  avoid vitest/browser failures
- Deno workspace resolution reads both `deno.json` AND `package.json`
  workspaces — both must stay in sync or you get "Could not find package.json
  for workspace member" errors
- deno.json with `name` but no `exports` triggers warning — add
  `"exports": "./mod.ts"`
- Some packages resolve `@atlas/*` through root deno.json import map without
  explicit `package.json` dep — adding them creates duplicate resolution paths
- gunshi `required: true` on CLI args still produces `string | undefined` at the
  type level — add a runtime guard even for required args
- `deno check` cannot parse `.svelte` files — `deno task typecheck` handles
  this by running `deno check` then `deno task -r check` for svelte-check
- `deno-lint-ignore` directives parse everything after the rule name as
  additional rule codes — don't add inline comments (e.g.,
  `// deno-lint-ignore require-await -- reason` breaks; put reason on line above)
- `deno check` pulls transitive deps — type errors in unrelated packages surface
  when checking a single file; check error file paths, not just exit code
- `@types/deno` only covers the `Deno.*` namespace — it doesn't augment DOM
  interfaces like `WorkerOptions` or `ReadableStream` that Deno extends at
  runtime; use separate `.d.ts` augmentations (see `types/deno-compat.d.ts`)

### TypeScript

- `[key: string]: unknown` index signature on typed interfaces enables
  assignment to `Record<string, unknown>` without `as` casts — clean widening
  pattern
- Explicit named exports shadow wildcard re-exports from the same barrel —
  remove old wildcards when replacing modules to prevent silent type mismatches
- Adding a variant to a discriminated union requires updating all exhaustive
  handlers in the same commit — splitting them creates a broken intermediate
  state
- `.svelte.ts` files have looser `JSON.parse` inference (returns any-ish) —
  plain `.ts` files enforce `unknown`, so extracted code needs explicit Zod
  parsing for `JSON.parse` results
- `arr[i]` is `T | undefined` under Deno's strict index checks — use `for...of`
  or destructured iteration instead of indexed access to avoid unnecessary
  null guards
- `"key" in obj` on `object` narrows to `Record<"key", unknown>` — use `in`
  checks instead of `as Record<string, unknown>` casts for property access

### Vitest

- `vi.fn()` without type parameter produces `Mock<Procedure | Constructable>` —
  always type mocks: `vi.fn<(arg: T) => R>()`
- `vi.restoreAllMocks()` does not clear call history for `vi.hoisted()` mocks —
  use `mockReset()` on each hoisted mock in `beforeEach`
- Mocking constructable classes requires class syntax or regular functions —
  arrow functions in `vi.fn().mockImplementation()` fail with "not a constructor"

### SvelteKit (web-client)

- `+layout.server.ts` / `+page.server.ts` in an `adapter-static` app causes
  SvelteKit's client router to fetch `__data.json` on navigation — with nginx's
  `try_files` fallback, this returns `index.html` instead of JSON, crashing
  `JSON.parse`. The dev server masks this because it executes server load
  functions properly. An architecture test enforces this constraint.
- Svelte scoped CSS: `:global(.class) svg` — the `svg` combinator is still
  scope-hashed when the SVG is rendered by a child component. Icon components
  embed their own dimensions, so external sizing rules become dead code after
  swapping inline SVGs for component-based icons.

### SQLite (@db/sqlite)

- `Database.exec()` handles multi-statement strings (semicolon-separated);
  `prepare()` only handles single statements
- PRAGMAs cannot be used as subqueries — `SELECT * FROM (PRAGMA x)` fails
- `busy_timeout` is per-connection, not per-file — read-only connections need it
  set independently

## Test Quality

Use the `testing` skill for guidance.

## Git Workflow

Never push directly to `main` - it's protected.

```bash
git checkout -b feature/your-feature-name
# make changes, commit
git push -u origin feature/your-feature-name
gh pr create
```

**Shared worktrees:** `git add` picks up other teammates' staged files — always
use `git add <specific-files> && git commit -m "msg"`, never `git add .` or
`git add -A`. Do NOT use `git commit -- <files> -m` — `--` terminates option
parsing and git treats `-m` as a pathspec.

`git diff HEAD~1` includes uncommitted working tree changes — use
`git show <hash>` or `git diff HEAD~1 HEAD` for clean single-commit review.

`git stash` in shared worktrees is dangerous — stash pop can fail on lock file
conflicts; use a temp branch instead.

If you accidentally commit to main locally:

```bash
git checkout -b feature/rescue-branch   # save your work
git checkout main
git reset --hard origin/main            # reset main
git checkout feature/rescue-branch
git push -u origin feature/rescue-branch
gh pr create
```

## Config Files

- `friday.yml` - Platform-wide settings (loaded from workspace directory,
  optional)
- `workspace.yml` - Per-workspace config (agents, signals, MCP servers)
- `docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml` - Example friday.yml with all available
  options

## Environment Variables

- `ATLAS_EXPOSE_KERNEL=1` — when set, the kernel workspace (`thick_endive`)
  becomes visible in the workspace picker and `/api/workspaces` list. When unset
  (the default), the kernel is hidden from all user-facing surfaces. Internal
  paths (cron, session dispatch, planner) always address the kernel directly by
  ID and are unaffected by this flag.

## Architecture Gotchas

**Worker context:** Worker-executed code actions can't read Context properties
unless explicitly serialized in `WorkerRequest.contextData` AND reconstructed in
`function-executor.worker.ts` — adding a Context field requires changes in 4
places: types.ts interface, fsm-engine.ts context building, worker-executor.ts
serialization, worker reconstruction.

**LLM output format:** Keep LLM output format simple (flat field lists) and
convert to JSON Schema in code — more reliable than asking LLMs to produce JSON
Schema directly.

**FSM dual execution paths:** Agent actions (`workspace-runtime.ts`) and LLM
actions (`fsm-engine.ts`) build prompts independently — changes to one don't
propagate to the other. Both need explicit wiring for new context.

**Agent identity:** `agent.name` is display text, `agent.id` is stable
kebab-case identifier — use `agent.id` for planner identity, never
`agent.name`.

## Local Development with CLI

Daemon runs on `localhost:8080`. Auto-restarts on code changes.

```bash
# Check and see if the daemon is already running
deno task atlas daemon status

# Start daemon
deno task atlas daemon start --detached

# Send test prompt - returns chatId in cli-summary JSON
deno task atlas prompt "test your changes"

# Continue conversation
deno task atlas prompt --chat <chatId> "follow up"

# View transcript
deno task atlas chat <chatId>              # JSON
deno task atlas chat <chatId> --human      # readable

# List recent chats
deno task atlas chat

# Stop daemon
deno task atlas daemon stop
```

**CLI gaps:** Not all APIs have CLI commands. Check `apps/atlasd/routes/` and
curl `localhost:8080` directly when needed.

**Debugging:** Use the `debugging-friday` skill for log analysis (local + GCS).

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->