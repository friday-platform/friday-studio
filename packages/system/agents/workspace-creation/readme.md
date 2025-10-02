# Workspace Creation

Converts workspace plan artifacts into WorkspaceConfig via LLM enrichment. Generates agent implementations, job orchestrations, signal configurations, and MCP server selections.

## Architecture

### Parallel Enrichment Pipeline

The agent transforms high-level plans into executable configurations using parallel LLM calls:

**Input**: Workspace plan artifact (from workspace-planner agent)
**Output**: WorkspaceConfig + workspace created on filesystem

**Pipeline**:
1. Load plan artifact from storage
2. Enrich all components in parallel:
   - Signals → signal configs (schedule/http/fs-watch)
   - Agents → agent configs (bundled/LLM) + MCP domain extraction
   - Jobs → job specs (sequential/parallel execution)
3. Generate MCP server configs from collected domains
4. Construct WorkspaceConfig
5. Create workspace via API

Parallel enrichment reduces latency from ~15s (sequential) to ~5s (parallel) for typical workspaces.

### Key Files

- `workspace-creation.agent.ts` - Main orchestrator
- `enrichers/signals.ts` - Signal type classification (Haiku)
- `enrichers/agents.ts` - Agent implementation selection (Sonnet 4) + archetype mapping
- `enrichers/jobs.ts` - Job execution specification (Sonnet 4)
- `enrichers/mcp-servers.ts` - MCP server matching (Haiku)
- `enrichers/mcp-server-registry.ts` - Vetted MCP server catalog
- `types.ts` - WorkspaceSummary output schema

## How It Works

### 1. Load Plan Artifact

Fetches workspace plan by artifact ID. Validates type is `workspace-plan`.

```typescript
const plan: WorkspacePlan = {
  workspace: { name, purpose },
  signals: [{ id, name, description }],
  agents: [{ id, name, description, needs, configuration? }],
  jobs: [{ id, name, triggerSignalId, steps, behavior }]
};
```

### 2. Enrich Signals

**Model**: Haiku 3.5 (fast classification)

Classifies signal type and extracts config parameters:

- **schedule**: Cron expression + timezone
- **http**: Method + path
- **fs-watch**: Directory/file path

Example: "Runs every hour" → `{ provider: "schedule", schedule: "0 * * * *", timezone: "UTC" }`

### 3. Enrich Agents

**Model**: Sonnet 4 (requires reasoning for bundled agent matching)

Two-stage process:

**Stage 1 - Implementation Selection**:
- Check bundled agents for capability match (prefer bundled)
- If bundled: auto-configure required env vars with `"auto"` value
- If no match: select archetype (collector/reader/analyzer/evaluator/reporter/notifier/executor)
- Generate 3-5 line prompt

**Stage 2 - MCP Domain Collection** (LLM agents only):
- Extract required MCP domains from agent capabilities
- Filter out platform domains (email/filesystem/notifications)
- Bundled agents manage their own MCP connections

Archetype determines model and parameters:

| Archetype | Model | Temp | Max Tokens | Use Case |
|-----------|-------|------|------------|----------|
| collector | Haiku | 0.1 | 4000 | API data retrieval |
| reader | Haiku | 0.1 | 8000 | File content extraction |
| analyzer | Sonnet 3.7 | 0.3 | 8000 | Analysis and reasoning |
| evaluator | Sonnet 3.7 | 0.2 | 6000 | Decisions and recommendations |
| reporter | Haiku | 0.2 | 6000 | Report generation |
| notifier | Haiku | 0.1 | 3000 | External notifications |
| executor | Haiku | 0.1 | 3000 | System operations |

### 4. Enrich Jobs

**Model**: Sonnet 4 (context flow requires reasoning)

Converts job plans into JobSpecifications with:
- Execution strategy (sequential/parallel)
- Agent pipeline with context flow
- Trigger signal reference

Context flow patterns:
- **First agent**: `{ signal: true }` (receives signal data)
- **Sequential**: `{ steps: "previous" }` (receives prior agent output)
- **Parallel**: `{ signal: true }` for all (no cross-agent flow)
- **Fan-out/fan-in**: Parallel + final synthesizer with `{ steps: "all" }`

### 5. Generate MCP Servers

**Model**: Haiku 3.5 (simple domain matching)

Matches collected MCP domains to blessed MCP server registry. Only adds external servers (platform provides email/filesystem/notifications built-in).

Registry includes: GitHub, Azure, Stripe, Playwright, Git, Weather, Linear, Trello, RSS, PostHog, etc.

### 6. Construct Config & Create Workspace

Assembles final WorkspaceConfig:

```typescript
{
  version: "1.0",
  workspace: { name, description },
  signals: { [id]: config },
  agents: { [id]: config },
  jobs: { [id]: spec },
  tools: { mcp: { client_config, servers } }
}
```

Creates workspace via API, returns path + summary:

```typescript
{
  workspaceName: string,
  workspacePath: string,
  config: WorkspaceConfig,
  summary: {
    signalCount, signalTypes, signalIds,
    agentCount, agentTypes, agentIds,
    jobCount, jobIds,
    mcpServerCount, mcpServerIds
  }
}
```

## Design Decisions

### Why Parallel Enrichment?

Early versions enriched components sequentially. This was simple but slow (~15s). Signals, agents, and jobs are independent - enriching in parallel cuts latency by 60-70%.

### Why LLM-Based Agent Selection?

Agent implementation (bundled vs generated, archetype, MCP domains) requires semantic matching. Rule-based systems fail on edge cases. LLM with structured output (Zod schemas) provides reliable classification with natural language flexibility.

### Why Separate MCP Domain Collection?

Initial approach had agents specify MCP domains during implementation selection. This caused hallucinated domains and platform domain leakage. Two-stage process (implementation → domain extraction) with explicit platform filtering prevents this.

### Why Archetype System?

Different agent types need different model capabilities and token budgets:
- Simple tasks (collection, notification) → Haiku (fast, cheap)
- Complex tasks (analysis, evaluation) → Sonnet (reasoning, depth)

Archetype maps to optimal model config without per-agent tuning.

### Why Blessed MCP Registry?

Allowing arbitrary MCP servers creates security and reliability risks. Curated registry ensures:
- Known-good server implementations
- Documented authentication patterns
- Tested tool interfaces
- Security review

### Why Platform Domain Filtering?

Atlas provides email/filesystem/notifications via built-in MCP server. Adding external servers for these domains causes conflicts and redundancy. Explicit filtering keeps configs clean.

## Progress Streaming

Agent emits progress events during execution:
- "Loading plan" - Fetching artifact from storage
- "Enriching components" - Parallel LLM enrichment in progress
- "Adding MCP servers" - Generating MCP server configs
- "Creating workspace" - API call to create workspace

## Error Handling

Failures at any stage abort the entire operation:
- **Artifact not found**: Returns error if artifact ID doesn't exist or isn't workspace-plan type
- **Enrichment failure**: Any LLM call failure (after 3 retries) aborts creation
- **Unknown MCP server**: Throws if domain matching returns unregistered server ID
- **API failure**: Workspace creation API errors propagate to caller

All errors include context (artifact ID, component being enriched, etc.) for debugging.

## Configuration

### Models

| Component | Model | Reason |
|-----------|-------|--------|
| Signal enrichment | Haiku 3.5 | Fast classification, simple config |
| Agent selection | Sonnet 4 | Bundled agent matching requires reasoning |
| Domain extraction | Haiku 3.5 | Simple domain mapping |
| Job enrichment | Sonnet 4 | Context flow requires execution planning |
| MCP matching | Haiku 3.5 | Registry lookup |

### Retries & Timeouts

All LLM calls use:
- `maxRetries: 3`
- `abortSignal` propagation for cancellation

MCP client timeout:
- `progressTimeout: 30s` (per-tool)
- `maxTotalTimeout: 300s` (session)

## Example Workflows

### Simple Sequential Job

**Input Plan**:
```
Signal: "Daily at 9am"
Agents: [issue-reader, slack-notifier]
Job: Read GitHub issues, post to Slack
```

**Output Config**:
- Signal: `{ provider: "schedule", schedule: "0 9 * * *" }`
- Agents: `issue-reader` (bundled: research), `slack-notifier` (LLM: notifier)
- Job: Sequential, context flow: signal → previous → previous
- MCP: GitHub (from bundled research agent)

### Parallel Analysis Job

**Input Plan**:
```
Signal: "On webhook"
Agents: [sentiment-analyzer, topic-classifier, report-generator]
Job: Analyze feedback from multiple angles, synthesize report
```

**Output Config**:
- Signal: `{ provider: "http", method: "POST", path: "/webhook" }`
- Agents: All LLM (analyzer archetype)
- Job: Parallel + sequential synthesizer, context: all parallel → synthesizer gets "all"
- MCP: None (analysis only)

### File Watcher Job

**Input Plan**:
```
Signal: "Watch ./uploads for new files"
Agents: [file-processor, email-notifier]
Job: Process uploaded files, email results
```

**Output Config**:
- Signal: `{ provider: "fs-watch", config: { path: "./uploads" } }`
- Agents: `file-processor` (LLM: reader), `email-notifier` (LLM: notifier)
- Job: Sequential
- MCP: None (platform provides email + filesystem)
