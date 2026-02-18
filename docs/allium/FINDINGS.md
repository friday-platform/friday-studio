# Codebase Inconsistency Audit

Distilled from 9 Allium behavioral specs. Each finding was verified against a
clean `main` branch. Organized by severity then by module.

---

## Bugs

### BUG-1: Session DELETE route param mismatch

**Module:** API Surface
**File:** `apps/atlasd/routes/sessions/index.ts`
**Severity:** Broken endpoint

`DELETE /api/sessions/:id` validates params as `z.object({ sessionId: z.string() })` but
the route parameter is named `id`. The handler reads `c.req.valid("param").sessionId` which
is always `undefined`.

**Fix:** Change the Zod schema to `z.object({ id: z.string() })` and update the handler
to destructure `{ id }`.

---

### BUG-2: AgentActionSchema missing `outputType` field

**Module:** FSM Engine
**Files:** `packages/fsm-engine/schema.ts:36-42`, `packages/fsm-engine/types.ts:82-88`, `packages/fsm-engine/fsm-engine.ts:982`

The Zod `AgentActionSchema` does not include `outputType`, but the TypeScript `AgentAction`
interface defines it and the runtime reads `action.outputType` for schema validation. Any
FSM definition loaded via `fromYAML()` has `outputType` stripped by Zod parsing, so agent
action output validation against document schemas silently never happens.

**Fix:** Add `outputType: z.string().optional()` to `AgentActionSchema`, matching the
`LLMActionSchema` pattern.

---

### BUG-3: Groq provider options sent to Anthropic model

**Module:** LLM Providers
**File:** `packages/system/agents/conversation/conversation.agent.ts:858`

The conversation agent uses `anthropic:claude-sonnet-4-6` but passes
`providerOptions: { groq: { reasoningFormat: "parsed", reasoningEffort: "medium" } }`.
These are silently ignored. Likely vestigial from a model switch.

**Fix:** Change to `providerOptions: { anthropic: { ... } }` with the appropriate Anthropic
options, or remove the `providerOptions` entirely if no provider-specific behavior is needed.

---

### BUG-4: Anthropic defaults hardcoded for all providers

**Module:** LLM Providers
**File:** `packages/core/src/agent-conversion/from-llm.ts:68`

`getDefaultProviderOpts("anthropic")` is always applied to system messages regardless of the
agent's configured provider. A workspace with `provider: "openai"` still gets Anthropic
cache control options injected into system messages.

**Fix:** Replace `getDefaultProviderOpts("anthropic")` with
`getDefaultProviderOpts(config.config.provider)`.

---

### BUG-5: Dead retry logic — swallowed errors prevent retries

**Module:** MCP Tools
**File:** `packages/mcp/src/registry.ts:506-521`

`getAllPlatformTools()` catches errors and returns `[]`. Its caller
`getAllPlatformToolsWithRetry()` retries on thrown exceptions. Since the inner function
never throws (returns `[]` on error), the retry loop sees a "successful" empty result
and never retries. The retry logic is dead code.

**Fix:** Have `getAllPlatformTools()` re-throw errors instead of returning `[]`, or change
the retry wrapper to check for empty results as a failure condition.

---

### BUG-6: Pool key collision ignores config differences

**Module:** MCP Tools
**File:** `packages/mcp/src/pool.ts` (GlobalMCPServerPool.generateConfigKey)

Config keys are generated from sorted server IDs only. Two different configurations for
the same set of server IDs (different URLs, different auth, different env) hash to the same
key and share a connection pool. This means workspace A's credentials could leak to
workspace B.

**Fix:** Include a hash of the full config (transport, auth, env) in the pool key, not just
server IDs.

---

## Dead / Stale Code

### DEAD-1: `agentTools` field on AgentExecutionContext

**Module:** Agent Orchestration
**File:** `packages/core/src/orchestrator/agent-orchestrator.ts:65`

`AgentExecutionContext.agentTools` is declared and documented ("Filter workspace tools to
only these names") but never read or consumed anywhere. Likely a remnant from an earlier
per-agent tool filtering design.

**Fix:** Remove the field.

---

### DEAD-2: Stale SignalProvider enum

**Module:** Configuration
**File:** `packages/config/src/base.ts:20`

`SignalProvider = z.enum(["http", "schedule", "system"])` is missing `"fs-watch"`. The
actual discriminated union in `signals.ts` includes all four. The enum is not used as a
constraint. Confirmed independently by both the signal and config agents.

**Fix:** Either add `"fs-watch"` to the enum or delete it if unused.

---

### DEAD-3: Vestigial Workspace domain class

**Module:** Workspace Lifecycle
**File:** `src/core/workspace.ts`

`Workspace` class has methods for managing signals, agents, workflows, sources, actions,
and `snapshot()`. In practice, `Workspace.fromConfig()` is called during runtime creation
but the object is only used to pass an ID and members to `WorkspaceRuntime`. None of the
management methods are called in the production runtime path.

**Fix:** Replace with a simple value object or pass workspace ID and members directly.

---

### DEAD-4: Unused MCP server override mechanism

**Module:** MCP Tools
**File:** `packages/mcp/src/registry.ts` (MCPServerOverrides type)

`MCPServerOverrides` type exists with granular tools and `timeout_ms` overrides but is
never used in the actual agent context builder, which does a flat config replacement.

**Fix:** Remove the type or implement the granular override path.

---

## Inconsistencies: Same Thing Done Differently

### INCON-1: Three competing session status enums

**Module:** Workspace Lifecycle
**Files:** `src/core/workspace-runtime.ts`, `src/types/core.ts`, `packages/core/`

- `WorkspaceRuntime` produces: `active | completed | failed | skipped`
- `IWorkspaceSession` interface declares: `pending | running | completed | cancelled`
- `WorkspaceSessionStatus` (daemon idle check): `PENDING | EXECUTING | COMPLETED | CANCELLED`

The idle check looks for `EXECUTING` and `PENDING`, which WorkspaceRuntime never produces.

**Fix:** Unify to a single enum. The runtime's `active | completed | failed | skipped` is
the source of truth — align the interface and daemon types to match.

---

### INCON-2: Six different API response envelope patterns

**Module:** API Surface
**Files:** `apps/atlasd/routes/*`

Pattern A: named key wrapper `{ artifact: ... }`. Pattern B: success boolean
`{ success: true }`. Pattern C: raw arrays. Pattern D: raw objects. Pattern E: structured
mutation errors. Pattern F: MCP JSON-RPC. Even within Pattern E, success uses `{ ok: true }`
but errors use `{ success: false }`.

**Fix:** Adopt a single envelope. Suggestion: `{ data: T }` for success,
`{ error: { code: string, message: string } }` for errors. Migrate incrementally per route
group.

---

### INCON-3: Four distinct tool filtering mechanisms

**Module:** MCP Tools
**Files:** per-server config, `atlas.yml` tool_policy, FSM `PLATFORM_TOOL_ALLOWLIST`, deny-list concatenation during merge

These operate at different layers with no unified model. A new tool must be added to or
excluded from up to four separate lists.

**Fix:** Define a single layered filtering pipeline: server-level allow/deny -> workspace
policy -> agent-level override. Remove the FSM hardcoded allowlist in favor of the config-
driven approach.

---

### INCON-4: Opposite tool filtering strategies (DENY vs ALLOW)

**Module:** Agent Orchestration
**Files:** `packages/core/src/agent-conversion/agent-tool-filters.ts`, `packages/system/agents/conversation/conversation.agent.ts:584`

LLM agents use a DENY list (21 tools blocked). Conversation agent uses an ALLOW list (22
tools permitted). These are not composable. A new platform tool is implicitly available to
LLM agents unless manually denied, but implicitly blocked from conversation agent unless
manually allowed.

**Fix:** Pick one strategy. ALLOW list is safer (explicit > implicit). If DENY list is
preferred for LLM agents, at least document the maintenance obligation.

---

### INCON-5: Three divergent retry policies

**Module:** Agent Orchestration
**Files:** `packages/core/src/orchestrator/agent-orchestrator.ts:608` (11 retries), `packages/core/src/agent-conversion/from-llm.ts:37` (3 retries), `packages/system/agents/conversation/conversation.agent.ts:856` (3 retries)

Wrapped agents: 11 attempts, 1s-30s exponential backoff. LLM agents: 3 (AI SDK default).
MCP agents: 0 retries (20-min timeout only).

**Fix:** Define a retry policy per transport type. Wrapped (in-process) agents don't need 11
retries — that's likely masking flaky initialization. Reduce to 3 with shorter backoff.
Add at least 1 retry for MCP agents.

---

### INCON-6: Agent action bypasses document validation

**Module:** FSM Engine
**File:** `packages/fsm-engine/fsm-engine.ts:943-984`

The main engine uses `makeUpdateDocFn`/`makeCreateDocFn` which call
`validateDocumentData()`. The agent action handler builds inline `updateDoc`/`createDoc`/
`deleteDoc` that do raw map operations with no validation. Agent-emitted document mutations
are unvalidated.

**Fix:** Reuse `makeUpdateDocFn`/`makeCreateDocFn`/`makeDeleteDocFn` in the agent action
context, same as the code action path.

---

### INCON-7: Dual-write with divergent semantics (merge vs replace)

**Module:** FSM Engine
**File:** `packages/fsm-engine/fsm-engine.ts:909,980`

Both LLM and agent actions dual-write to `results` (replace: `results.set(key, data)`) and
`documents` (merge: `{ ...existingDoc.data, ...data }`). Over multiple writes, `results`
has only the latest data while `documents` has the union. They can silently diverge.

**Fix:** Deprecation is already planned (documents is the legacy path). Add a comment
documenting the divergence risk, and add a runtime warning when the two values differ.

---

### ~~INCON-8: `strictObject` vs `object` across agent config variants~~ RESOLVED

Changed `AtlasAgentConfigSchema` to `z.strictObject()` to match LLM/system agent schemas.

---

### ~~INCON-9: Temperature range mismatch~~ RESOLVED

All agent config schemas now use `0..2` range, matching the standard LLM provider range.

---

### INCON-10: Session timeout uses raw milliseconds

**Module:** Configuration
**File:** `packages/config/src/atlas.ts:116-124`

`RuntimeConfig.sessions.timeout` uses `z.number().int().min(60000).max(86400000)` (raw ms).
Every other timeout in the config system uses the `Duration` string format (`"30s"`, `"5m"`).

**Fix:** Migrate to `DurationSchema` and convert to ms at runtime.

---

### INCON-11: Three different input validation approaches in API

**Module:** API Surface
**Files:** `apps/atlasd/routes/*`

1. `@hono/zod-validator` `zValidator()` — most routes
2. `hono-openapi` `validator()` — agents, library, config, scratchpad
3. Manual body parsing with no validation — `/workspaces/add`, `/workspaces/add-batch`
4. `z.any()` — workspace update body

**Fix:** Standardize on one approach. `zValidator()` is simplest and most common. Add Zod
validation to the manual routes and replace `z.any()` with the actual schema.

---

### INCON-12: Inconsistent error handling contracts (throws vs Result)

**Module:** Session & Artifacts
**Files:** `packages/document-store/`, `packages/core/src/artifacts/`

`DocumentStore.read()` throws on Zod validation failure. `ArtifactStorageAdapter.get()`
returns `Result<Artifact|null, string>`. Both are typed JSON retrieval with schema
validation but use opposite error strategies.

**Fix:** Pick one. `Result` is more explicit and composable — migrate DocumentStore to
return Result types.

---

### INCON-13: Duplicate session-completion logic

**Module:** Workspace Lifecycle
**File:** `src/core/workspace-runtime.ts`

`processSignal()` and `executeJobDirectly()` both contain identical post-session logic
(persist to history, emit completion event, handle completion). Copy-pasted with minor
differences.

**Fix:** Extract a shared `finalizeSession()` method.

---

### INCON-14: AgentRegistry recreated per request

**Module:** API Surface
**Files:** `apps/atlasd/routes/agents/list.ts:30`, `apps/atlasd/routes/agents/get.ts:35`

`GET /api/agents` creates a fresh `AgentRegistry()` and initializes it on every request.
The daemon already maintains a shared `this.agentRegistry`.

**Fix:** Pass the daemon's shared registry to the route handler via Hono context.

---

### INCON-15: Triple atlas-platform MCP server injection

**Module:** MCP Tools
**Files:** `packages/mcp/src/registry.ts:110`, `packages/core/src/agent-context/index.ts:217`, `packages/fsm-engine/mcp-tool-context.ts:83`

The atlas-platform server is independently injected in three places, each creating its own
config. If the platform URL logic changes, all three must be updated.

**Fix:** Extract a single `getAtlasPlatformServerConfig()` function and call it from all
three sites.

---

### INCON-16: Dual MCP client libraries

**Module:** MCP Tools
**File:** `packages/mcp/src/registry.ts`

Registry initialization uses `@modelcontextprotocol/sdk` Client to list platform tools.
Runtime tool fetching uses `@ai-sdk/mcp` createMCPClient. Two different MCP client
implementations talking to the same server.

**Fix:** Consolidate on `@ai-sdk/mcp` since that's the runtime client.

---

### INCON-17: Inconsistent retry strategies per MCP transport

**Module:** MCP Tools
**File:** `packages/mcp/src/manager.ts`

Stdio: 10 retries, 500ms apart, 2s timeout. HTTP: 3 retries with exponential backoff, plus
a separate connect retry. Two independent retry loops for HTTP.

**Fix:** Unify retry policy per transport. HTTP should have one retry loop (connect +
verify together), not two stacked loops.

---

### INCON-18: FSM adapter excludes Groq

**Module:** LLM Providers
**File:** `packages/fsm-engine/llm-provider-adapter.ts:19`

Provider type is `"anthropic" | "openai" | "google"`. Groq is a valid registry provider
but cannot be used in FSM LLM actions.

**Fix:** Add `"groq"` to the union type, or document why FSM intentionally excludes it.

---

### INCON-19: FSM adapter omits all provider options

**Module:** LLM Providers
**File:** `packages/fsm-engine/llm-provider-adapter.ts:46-53`

No `providerOptions`, `temperature`, or `maxOutputTokens` passed. This is the only LLM
call site that skips Anthropic cache control defaults.

**Fix:** Apply `getDefaultProviderOpts(provider)` like every other call site.

---

### INCON-20: Inconsistent status codes for creation

**Module:** API Surface
**Files:** `apps/atlasd/routes/artifacts.ts`, `apps/atlasd/routes/workspaces/`

Artifact `POST /` returns 200, `POST /upload` returns 201. Workspace create returns 200.
Skill create returns 201. MCP registry create returns 201.

**Fix:** All creation endpoints should return 201.

---

### INCON-21: Inconsistent pagination

**Module:** API Surface
**Files:** `apps/atlasd/routes/chat.ts`, `apps/atlasd/routes/library/`

Chat uses cursor-based. Library uses offset-based. Most list endpoints have no pagination.

**Fix:** Pick one pattern (cursor-based is more scalable) and apply it to all list
endpoints that can return large result sets.

---

## Missing Validation

### VAL-1: Payload schema declared but never enforced

**Module:** Signal Ingestion
**Files:** `packages/config/src/signals.ts:19`, `src/core/workspace-runtime.ts`

Signal configs accept an optional `schema` field (JSON Schema) for payload validation, but
`WorkspaceRuntime.processSignal()` never validates incoming payloads against it.

**Fix:** Call `validateSignalPayload()` in `processSignal()` before dispatching to the FSM.

---

### VAL-2: Unvalidated FSM state persistence

**Module:** Session & Artifacts
**File:** `packages/document-store/src/document-store.ts`

`saveState()`/`loadState()` stores raw JSON without schema validation, unlike
`write()`/`read()` which validate with Zod. State format evolution could produce
unreadable data.

**Fix:** Add schema versioning to state files, or validate state on load.

---

### VAL-3: `as` type assertion in Cortex adapter

**Module:** Session & Artifacts
**File:** `packages/core/src/artifacts/cortex-adapter.ts:828`

`cortexObject.metadata.artifact_type as Artifact["type"]` bypasses type safety. Old Cortex
data with unrecognized types would silently produce invalid values.

**Fix:** Replace with Zod parsing: `ArtifactTypeSchema.parse(cortexObject.metadata.artifact_type)`.

---

### VAL-4: MCP environment validation timing gap

**Module:** Workspace Lifecycle
**File:** `packages/workspace/src/manager.ts`

`validateMCPEnvironmentForWorkspace` runs at registration time but not at runtime creation.
If env vars become unavailable between registration and runtime creation (e.g., daemon
restart without the env var), the error surfaces as a cryptic runtime failure.

**Fix:** Re-validate MCP environment at runtime creation time.

---

### VAL-5: Hardcoded LLM step limit

**Module:** FSM Engine
**File:** `packages/fsm-engine/llm-provider-adapter.ts:37`

`stepCountIs(10)` is hardcoded. An LLM action needing more than 10 tool-call rounds
silently stops. Not configurable, not documented.

**Fix:** Make it configurable via the FSM definition or LLM action config. At minimum,
log a warning when the limit is hit.

---

### VAL-6: AgentExpertise schema violation during MCP discovery

**Module:** Agent Orchestration
**File:** Agent discovery path

The SDK schema requires `domains` to have min 1 element, but MCP discovery falls back to
empty arrays `{ domains: [], capabilities: [], examples: [] }`, silently violating the
schema constraint.

**Fix:** Provide a default domain like `["general"]` for MCP-discovered agents.

---

### VAL-7: Hallucination detection silently skippable

**Module:** Agent Orchestration
**File:** `packages/core/src/orchestrator/`

`validateAgentOutput` only runs hallucination checks when `agentType === "llm"`, but
`agentType` is a string parameter the caller must pass. No automatic derivation from the
agent itself. If the caller omits it, detection is silently skipped.

**Fix:** Derive `agentType` from the agent's registered metadata rather than relying on
the caller to pass it correctly.

---

## Architecture Observations

### ARCH-1: atlas.yml config is parsed but largely unused

**Module:** Workspace Lifecycle / Configuration
**Files:** `packages/config/src/atlas.ts`, `src/core/workspace-runtime.ts`

`AtlasConfig` extends `WorkspaceConfig` with `supervisors`, `planning`, and `runtime`
fields. These are parsed and stored in `MergedConfig.atlas`, but `WorkspaceRuntime` only
reads from `config.workspace.*`. The atlas-specific fields appear unused at the runtime
level.

**Fix:** Either wire up the atlas-specific fields or remove them from the schema.

---

### ARCH-2: Wrapped agents lack workspace isolation

**Module:** Agent Orchestration
**File:** `packages/core/src/orchestrator/agent-orchestrator.ts:116`

`wrappedAgents` Map uses flat `agentId` keys with no workspace namespacing. Two workspaces
executing the same wrapped agent share the same instance.

**Fix:** Key by `${workspaceId}:${agentId}` or use per-workspace orchestrator instances.

---

### ARCH-3: Session files grow unboundedly

**Module:** Session & Artifacts
**File:** `packages/core/src/session/history-storage.ts`

Events are appended to session JSON files that are fully read and rewritten on every
append. Large sessions could produce multi-megabyte files with degrading write performance.

**Fix:** Consider append-only JSONL format (one event per line) or periodic compaction.

---

### ARCH-4: Cortex list operations miss artifacts during update window

**Module:** Session & Artifacts
**File:** `packages/core/src/artifacts/cortex-adapter.ts`

During artifact update, there's a ~50-200ms window where both old and new revisions have
`is_latest=false`. The `get()` method has a fallback query, but `listByWorkspace`,
`listByChat`, and `listAll` do not.

**Fix:** Apply the same fallback logic to list operations, or use a transaction in Cortex.

---

### ARCH-5: Deno.createHttpClient usage violates migration policy

**Module:** LLM Providers
**File:** `packages/llm/src/util.ts:10`

`createProxyFetch()` calls `Deno.createHttpClient()` which is a Deno-specific API,
contradicting the migration-away-from-Deno-APIs policy.

**Fix:** Replace with Node.js `http.Agent` with proxy support, or use the `undici`
ProxyAgent.

---

### ARCH-6: MCPManager singleton vs pool instances

**Module:** MCP Tools
**File:** `packages/mcp/src/manager.ts`

`MCPManager` has a static `getInstance()` singleton, but `GlobalMCPServerPool` creates
fresh `new MCPManager()` instances. The singleton is exported but the pool ignores it.

**Fix:** Remove the singleton pattern from MCPManager. The pool is the correct lifecycle
manager.

---

### ARCH-7: Config hot-reload is a full restart

**Module:** Workspace Lifecycle
**File:** `src/core/workspace-runtime.ts`

Config changes destroy the runtime entirely. The workspace is marked `inactive`, and the
next signal recreates everything from scratch. Active sessions are terminated.

Not necessarily wrong (simplicity wins), but worth documenting as an explicit design choice.

---

### ARCH-8: Validator warns about unimplemented pattern

**Module:** FSM Engine
**File:** `packages/fsm-engine/validator.ts:166-179`

The validator warns "Agent actions detected but no AGENT_FAILED event handling found." The
engine actually throws on agent failure (aborting the transition) — there is no signal-based
error recovery path. The warning implies a pattern the engine doesn't implement.

**Fix:** Remove the warning, or implement the signal-based recovery pattern.

---

## Summary

| Category | Count |
|---|---|
| Bugs | 6 |
| Dead/stale code | 4 |
| Inconsistencies | 21 |
| Missing validation | 7 |
| Architecture observations | 8 |
| **Total** | **46** |

*Note: The original spec analysis found ~69 items. This document consolidates duplicates
(e.g., stale SignalProvider enum found by both signal and config agents) and excludes one
false positive (HTTPSignalProvider was reported as orphaned but is actively used).*
