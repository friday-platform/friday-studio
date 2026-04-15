# Configurable Platform LLM Providers

Shipped: 2026-04-12, branch `eric/configurable-providers`.

Friday's platform LLM calls (session titles, triage classification, workspace
planning, conversation agent, etc.) are now configurable via `friday.yml`
instead of being hard-coded to Anthropic. Operators can declare models per
task archetype, and zero-config startup continues to work for Anthropic-only
users.

## What Changed

### New: PlatformModels resolver (`packages/llm/src/platform-models.ts`)

A `PlatformModels` interface with a single `.get(role)` method that returns a
pre-traced `LanguageModelV3`. The factory `createPlatformModels(config)` runs
eager validation at daemon startup and returns a fully-initialized resolver.

**Archetypes:**
- `labels` — short text (titles, progress strings), graceful fallback on failure
- `classifier` — structured output via `generateObject`, single-shot
- `planner` — multi-step synthesis, tool calling, large context
- `conversational` — streaming responses, multi-turn, conversation agents

**Default chains** for zero-config startup:
```ts
{
  labels: ["groq:openai/gpt-oss-120b", "anthropic:claude-haiku-4-5"],
  classifier: ["anthropic:claude-haiku-4-5"],
  planner: ["anthropic:claude-sonnet-4-6"],
  conversational: ["anthropic:claude-sonnet-4-6"],
}
```

### New: friday.yml models config (`packages/config/src/atlas.ts`)

```yaml
# friday.yml
models:
  labels: groq:openai/gpt-oss-120b
  classifier: anthropic:claude-haiku-4-5
  planner: anthropic:claude-sonnet-4-6
  conversational: anthropic:claude-sonnet-4-6
```

Any field may be omitted to accept the default chain. Missing friday.yml
entirely is valid.

### Changed: AgentContext (`packages/agent-sdk/src/types.ts`)

`AgentContext` gains a `platformModels: PlatformModels` field. Agent handlers
access models via `context.platformModels.get("classifier")` instead of
direct registry calls.

### Changed: smallLLM (`packages/llm/src/small.ts`)

Now requires explicit `platformModels` parameter. All callers thread it through.
Routes to `platformModels.get("labels")` internally.

### Changed: AtlasLLMProviderAdapter (`packages/fsm-engine/llm-provider-adapter.ts`)

Refactored to accept a resolved `LanguageModelV3` instead of a model string:
```ts
new AtlasLLMProviderAdapter(
  platformModels.get("conversational"),
  { providerOptions, maxSteps },
)
```

Per-call `params.model` overrides still work within the same provider scope.

### Migrated call sites

Direct registry/tracing calls replaced with `platformModels.get(role)`:
- `packages/system/agents/conversation/conversation.agent.ts`
- `packages/system/agents/workspace-chat/workspace-chat.agent.ts`
- `packages/system/agents/workspace-planner/workspace-planner.agent.ts`
- `packages/system/agents/skill-distiller/skill-distiller.agent.ts`
- `packages/system/agents/session-supervisor/session-supervisor.agent.ts`
- `packages/system/agents/workspace-improver/workspace-improver.agent.ts`
- `packages/workspace/src/triage-classifier.ts`
- `packages/hallucination/src/detector.ts`
- `packages/workspace-builder/planner/*.ts` (plan, dag, schemas, mappings)
- `packages/workspace/src/runtime.ts` (adapter instantiation)

Transitive via smallLLM (no per-site change required):
- `packages/llm/src/session-title.ts`
- `packages/activity/src/title-generator.ts`

### Daemon wiring (`apps/atlasd/src/atlas-daemon.ts`)

`initialize()` constructs a `FilesystemAtlasConfigSource`, loads config, calls
`createPlatformModels(config)`, and stores the resolver. Passed to
`WorkspaceManager`, `AgentRegistry`, and subsystems that build per-job deps.

## Key Decisions

**Dependency injection over singleton.** The resolver is constructed once at
daemon startup and threaded through the dependency graph. No module-level
cache, no test reset escape hatch needed. Tests construct their own
`PlatformModels` and pass it directly.

**Eager validation at startup.** Invalid provider names and missing
credentials fail startup with field-pathed errors naming the file, field,
value, and fix. Multiple errors accumulate and surface together.

**LITELLM_API_KEY as universal credential.** If set, every provider is
treated as credentialed. Matches existing smallLLM behavior for LiteLLM
proxy setups.

**Pre-traced models.** `.get(role)` returns a model with `traceModel()`
already applied. Call sites MUST NOT wrap again.

**workspace-planner default changed Haiku to Sonnet.** The `planner` archetype
profile (multi-step synthesis, complex schemas) matches Sonnet's capabilities.
Operators wanting Haiku can pin it in friday.yml.

## Error Handling

Config validation errors include file path, field path, offending value, and
concrete fix. Multiple errors surface together. Example:

```
friday.yml: models.classifier: provider 'anthropc' is not registered
  configured value: "anthropc:claude-haiku-4-5"
  known providers: anthropic, openai, google, groq, claude-code

friday.yml: models.planner: missing credentials
  configured value: "openai:gpt-4o"
  required env var: OPENAI_API_KEY (or LITELLM_API_KEY for proxied access)
```

## Out of Scope

- **Bundled agents** (email, Slack, data-analyst, etc.) — opinionated curation,
  not platform internals
- **WASM agent bridge** (`createLlmGenerateHandler`) — already configurable via
  `AgentLLMConfig`
- **FSM LLM actions** — workspace.yml compilation bakes in concrete model
  strings; archetypes don't replace this
- **Hot reload / config watching** — interface can be extended later
- **Presets** (`preset: anthropic` expanding to defaults) — deferred to v1.5
- **Env-var per-archetype overrides** (`ATLAS_MODEL_PLANNER`) — deferred to v1.5

## Test Coverage

**Factory tests** (`packages/llm/src/platform-models.test.ts`):
- Null config resolves to default chains
- Partial config merges with defaults
- Default chain walks credential checks
- LITELLM universal credential handling
- Pre-tracing verification
- Validation error accumulation

**Adapter tests** (`packages/fsm-engine/tests/llm-provider-adapter.test.ts`):
- Default model path (no params.model)
- Per-call override path with provider inference
- providerOptions and maxSteps passthrough

**Daemon startup integration**:
- Valid friday.yml → boot succeeds
- Invalid friday.yml → boot fails with field-pathed error
- No friday.yml → defaults apply
