# Agent Playground

Local dev tool for executing and debugging Friday agents and workspaces. Runs as
a SvelteKit app with a Hono API backend. No daemon, no database, no external
services — agents execute in hermetic isolation.

## Getting Started

```bash
deno task playground     # from monorepo root — starts on http://localhost:5200
```

Open `http://localhost:5200` in a browser. The sidebar has four sections:

- **Agents > Bundled** — Select a registered agent, enter a prompt, click Execute
- **Agents > Custom** — Build an ad-hoc agent (provider, model, system prompt, MCP tools)
- **Workspaces > Inspector** — Load or generate a workspace, inspect its structure
- **Workspaces > History** — Browse previous pipeline runs

Agents that call external APIs need credentials via the Environment section.
Agents like Table Generator work without credentials.

### CLI Mode

Headless pipeline execution for workspace generation:

```bash
deno task sim "prompt"                   # full pipeline (plan → compile → run)
deno task sim "prompt" --stop-at=plan    # stop after blueprint generation
deno task sim "prompt" --stop-at=fsm     # stop after FSM compilation
deno task sim "prompt" --real            # execute with real MCP agents
```

Run artifacts are saved to `runs/workspaces/<timestamp>-<slug>/`.

## Routes

```
/                         → redirects to /agents/bundled
/agents/bundled           → bundled agent execution
/agents/custom            → custom agent configuration + execution
/workspaces               → workspace inspector (load YAML or generate from prompt)
/workspaces/history       → list of past pipeline runs
```

## API Endpoints

All routes defined in `src/lib/server/router.ts`. The SvelteKit catch-all at
`src/routes/api/[...paths]/+server.ts` forwards all HTTP methods to Hono's
`.fetch()`.

### Agent Routes

**`GET /api/agents`** — Returns metadata for all bundled agents (id,
displayName, description, constraints, examples, schemas, required/optional
config).

**`POST /api/execute`** — Execute a bundled agent. Returns SSE stream.

```json
{ "agentId": "table", "input": "Make a table of planets", "env": {} }
```

**`POST /api/custom/execute`** — Execute a custom agent configuration. Returns
SSE stream.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "systemPrompt": "You are a helpful assistant.",
  "input": "What is 2+2?",
  "mcpServerIds": ["github"],
  "env": { "GH_TOKEN": "ghp_..." }
}
```

**`GET /api/mcp/servers`** — Available MCP servers from the registry.

**`POST /api/mcp/tools`** — Start MCP servers in-process, return tool
definitions. Connections are ephemeral.

### Workspace Routes

**`POST /api/workspace/parse`** — Validate a workspace.yml string, return parsed
structure.

```json
{ "yaml": "workspace:\n  name: my-workspace\n  ..." }
```

**`POST /api/workspace/execute`** — Run the full pipeline via SSE streaming.
Saves artifacts to `runs/workspaces/`.

```json
{ "prompt": "build a data pipeline", "stopAt": "fsm", "real": false }
```

**`GET /api/workspace/runs`** — List recent runs (last 30) with summary and
error status.

**`GET /api/workspace/runs/:slug`** — Load all artifacts for a specific run
(input.json, phase3.json, fsm.json, workspace.yml, execution-report.json,
summary.txt).

### SSE Event Protocol

Both agent and workspace execute endpoints return `text/event-stream`:

| Event      | Payload                                              | Frequency |
| ---------- | ---------------------------------------------------- | --------- |
| `progress` | `AtlasUIMessageChunk` (text deltas, tool calls, etc) | 0..N      |
| `log`      | `{ level, message, context? }`                       | 0..N      |
| `trace`    | `{ spanId, name, durationMs, modelId, usage }`       | 0..N      |
| `result`   | Agent return value (`AgentPayload`)                  | once      |
| `done`     | `{ durationMs, totalTokens?, stepCount? }`           | once      |
| `error`    | `{ error: string }`                                  | 0..1      |

Workspace execute also emits:

| Event      | Payload                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `artifact` | `{ name: "blueprint"\|"fsm"\|"workspace.yml"\|"execution-report", content: string }` |

## File Structure

```
tools/agent-playground/
├── cli.ts                                 # Headless pipeline CLI
├── runs/workspaces/                       # Pipeline run artifacts
├── src/
│   ├── lib/
│   │   ├── client.ts                      # Typed Hono RPC client
│   │   ├── components/
│   │   │   ├── sidebar.svelte             # App navigation
│   │   │   ├── agent-selector.svelte      # Bundled agent dropdown
│   │   │   ├── custom-config.svelte       # Model/prompt/MCP picker
│   │   │   ├── env-editor.svelte          # Key-value env var editor
│   │   │   ├── execution-stream.svelte    # SSE streaming output
│   │   │   ├── execution-panel.svelte     # Mock/real toggle + run controls
│   │   │   ├── mcp-picker.svelte          # MCP server multi-select
│   │   │   ├── trace-panel.svelte         # Stats bar + trace inspector
│   │   │   ├── mermaid-diagram.svelte     # Mermaid SVG renderer
│   │   │   ├── fsm-state-diagram.svelte   # FSM diagram with stepper
│   │   │   ├── results-accumulator.svelte # Live JSON view per FSM step
│   │   │   └── action-trace.svelte        # Actions grouped by state
│   │   └── server/
│   │       ├── router.ts                  # Hono app with all routes
│   │       ├── routes/
│   │       │   ├── agents.ts              # GET /agents
│   │       │   ├── execute.ts             # POST /execute (bundled)
│   │       │   ├── custom.ts              # POST /custom/execute
│   │       │   ├── mcp.ts                 # MCP server/tool routes
│   │       │   └── workspace.ts           # Workspace pipeline routes
│   │       └── lib/
│   │           ├── context.ts             # PlaygroundContextAdapter
│   │           ├── sse.ts                 # createSSEStream helper
│   │           └── workspace/
│   │               ├── pipeline.ts        # Pipeline phases (pure functions)
│   │               ├── run-fsm.ts         # FSM execution harness
│   │               ├── mock-executor.ts   # Deterministic agent stubs
│   │               └── direct-executor.ts # Real MCP agent execution
│   └── routes/
│       ├── +layout.svelte                 # CSS Grid shell with sidebar
│       ├── +page.server.ts                # Root redirect → /agents/bundled
│       ├── agents/
│       │   ├── bundled/+page.svelte
│       │   └── custom/+page.svelte
│       ├── workspaces/
│       │   ├── +page.svelte               # Inspector (load/generate)
│       │   └── history/+page.svelte
│       └── api/[...paths]/+server.ts      # Catch-all → Hono
```

## Key Internals

### PlaygroundContextAdapter

Creates hermetic `AgentContext` instances with callback-based streaming. No
database, no daemon — same isolation as the eval framework but with real-time
event emission.

```typescript
const adapter = new PlaygroundContextAdapter();
const { context } = adapter.createContext({
  env: { API_KEY: "..." },
  onStream: (chunk) => {
    /* real-time progress */
  },
  onLog: (entry) => {
    /* log capture */
  },
  abortSignal: controller.signal,
});
await agent.execute(input, context);
```

### createSSEStream

Framework-agnostic SSE response helper. Takes an async executor, provides a
typed emitter, returns a streaming `Response`.

```typescript
return createSSEStream(async (emitter, signal) => {
  emitter.progress(chunk);
  emitter.result(payload);
  emitter.done({ durationMs: 100 });
});
```

### Workspace Pipeline

Pure functions extracted into `src/lib/server/lib/workspace/pipeline.ts`. Four
phases, each with explicit parameters and results:

1. **generateBlueprint** — LLM-backed workspace design from natural language
2. **compileFSMs** — Compile blueprint jobs into FSM definitions (pure)
3. **assembleWorkspaceYml** — Build workspace.yml from blueprint + FSMs (pure)
4. **executeFSMs** — Run FSMs through mock or real MCP executors

`runPipeline()` chains all four with `stopAt` support for partial execution.

### Hono + SvelteKit Integration

The `Router` type is exported from `router.ts` — `hc<Router>()` provides full
type inference for API calls on the client.

```typescript
const client = getClient();
const res = await client.api.agents.$get();
const { agents } = await res.json(); // fully typed
```

## Tests

```bash
deno task test tools/agent-playground/src/lib/server/    # all server tests
deno task test tools/agent-playground/src/lib/server/lib/workspace/  # workspace harness
```

## Conventions

- `console.*` is allowed — dev tool exemption from `@atlas/logger` rule
- No production deployment — local only
- Use `makeClient(fetch)` in load functions, `getClient()` in browser code
- Components use Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`)
- Design tokens from `@atlas/ui/tokens.css`
