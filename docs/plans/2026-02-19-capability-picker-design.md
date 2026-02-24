# Capability Picker Redesign

Shipped 2026-02-20 on `improve-agent-selection`.

Replaced the lossy `needs` keyword matching system with direct capability ID
selection via `z.enum`. The planner LLM now picks from a constrained menu of
real capability IDs instead of emitting freeform keywords that a classifier
tries to decode. This eliminated misroutes (grocery CRUD → data-analyst, Gmail
read → SendGrid email) and removed ~300 lines of keyword extraction/matching
code.

## What Changed

### Schema rename: `needs` → `capabilities`

The `Agent` schema field was renamed from `needs: string[]` to
`capabilities: string[]` across all consumers: `@atlas/agent-sdk` types,
workspace-builder planner, classify-agents, FSM workspace creator enrichers,
evals, and test fixtures. The field is constrained at plan time to a dynamic
`z.enum` built from both static registries (bundled agents + MCP servers) and
dynamic servers from KV.

### Classification simplified to registry lookup

`classifyAgents()` in `workspace-builder/planner/classify-agents.ts` now does
direct registry lookups instead of keyword extraction/matching. For each
capability ID: check bundled registry → check MCP registry → check dynamic
servers → emit `unknown-capability` clarification. Removed functions:
`extractKeywordsFromNeed()`, `matchBundledAgents()`, `findFullBundledMatch()`,
`removeSubsumedKeywords()`, `needsReferenceMCPServer()`.

### Dynamic MCP server support

`getCapabilityIds()` in `plan.ts` builds the enum from static registries plus
dynamic servers passed via `ClassifyOpts.dynamicServers`. The production config
generators (`mcp-servers.ts` enricher, `classifyAgents`) accept dynamic servers
and merge them with the static registry, static taking precedence on ID
collision.

### Capabilities XML improvements

`getCapabilitiesSection()` now generates:
- Precise descriptions with execution model details for each bundled agent
- `<constraints>` tags on every agent/server (what it CANNOT do)
- `<builtin_capabilities>` section listing built-in tools (resource_read/write,
  webfetch, artifacts) with guidance on when `capabilities: []` is correct
- Removed `domains` attribute from XML elements (kept on data model for API)

### Dead code removal

Removed from `mcp-registry`: `getAvailableIntegrationsPrompt()`,
domain-matching functions, and unused registry methods. The
`deterministic-matching.ts` module was pruned to only retained functions still
used by the conversation agent path.

### Routing eval suite

New eval at `tools/evals/agents/planner/routing.eval.ts` covering:
- "None" cases (CRUD, data transforms → `capabilities: []`)
- Bundled agent cases (analytics, Slack, email sending, research)
- MCP server cases (Gmail read, GitHub, Google Sheets)
- Disambiguation (email send vs Gmail read, Slack vs email notifications)

## Key Decisions

**Direct ID selection over keyword matching.** The LLM already sees the full
capabilities menu — encoding its decision as keywords and decoding them back is
a lossy round-trip. Removing the indirection eliminates an entire class of
routing bugs.

**`z.enum` constraint at plan time.** The enum is built dynamically from
registries, so adding a new capability automatically makes it available. Invalid
IDs fail at schema validation rather than producing silent misroutes.

**Bundled + MCP mutual exclusivity preserved.** If an agent's capabilities
array contains both a bundled ID and an MCP server ID, a `mixed-bundled-mcp`
clarification is emitted. This hasn't changed — descriptions are clear enough
that it shouldn't happen.

**Domains removed from XML, kept on data model.** Domain keywords served no
routing purpose with direct ID selection and risked giving the LLM false
disambiguation signals. The HTTP API and connect-mcp-server flow still
read/write domains.

## Out of Scope

- **Resource-aware routing** — Teaching the planner that workspace resources
  influence capability selection. The picker mechanics are fixed; resource
  awareness layers on top.
- **Runtime tool search / deferred loading** — Planning-time registry has ~30
  items. BM25/embedding search not needed yet.
- **Tool-based selection with error correction** — YAGNI until eval data shows
  z.enum isn't sufficient.
- **Domain keyword data model cleanup** — Domains stay on metadata for API
  consumers. Only prompt-facing XML dropped them.

## Test Coverage

- `classify-agents.test.ts` — 29 tests covering bundled lookup, MCP lookup,
  unknown capability clarifications, mixed-type clarifications, dynamic server
  resolution, config requirement extraction, and format helpers.
- `mcp-servers.test.ts` (enricher) — 12 tests covering registry lookup,
  dynamic server resolution, credential binding application, deduplication.
- `routing.eval.ts` — LLM eval suite testing end-to-end plan generation
  routing decisions against real `generatePlan()`.
- `agent-classifier-email-gmail.test.ts` and
  `email-gmail-classification-pipeline.test.ts` — Updated to use `capabilities`
  field with registry-lookup assertions.
