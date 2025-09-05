# Workspace Creation Agent

Converts automation requirements into working Atlas workspace configurations.

## What It Does

Takes natural language automation requests and generates complete workspace configurations with signals (triggers), AI agents, orchestration jobs, and MCP server tool connections.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                            WORKSPACE GENERATION PIPELINE                       │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│ ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│ │   ANALYZE  │→ │   IDENTIFY │→ │  GENERATE  │→ │ ORCHESTRATE│→ │  VALIDATE  │ │
│ └────────────┘  └────────────┘  └────────────┘  └────────────┘  └────────────┘ │
│       ↓               ↓               ↓               ↓               ↓        │
│ Requirements    Workspace ID    Components      Jobs/Links     Export Config   │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘

INPUT:       "Monitor GitHub issues and send Slack notifications"
    ↓
ANALYZE:     Identify triggers (GitHub webhooks), processing (issue analysis), outputs (Slack)
    ↓
IDENTIFY:    Set workspace name/description
    ↓
GENERATE:    Create webhook signal, issue-analyzer agent, slack-notifier agent
    ↓
ORCHESTRATE: Connect webhook → analyzer → notifier via jobs
    ↓
VALIDATE:    Check all references exist, export final config
    ↓
OUTPUT:      Complete workspace.yml ready for Atlas daemon
```

### Core Pipeline Functions

**`workspaceCreationAgent()`** - Main agent using Claude Sonnet 4

- Executes 6-step pipeline with parallel tool calls
- Uses WorkspaceBuilder to accumulate components
- Creates workspace via Atlas API on completion

**`WorkspaceBuilder`** - Configuration accumulator

- Builds workspace config incrementally via tools
- Validates component references and completeness
- Exports final WorkspaceConfig format

### Tool Pipeline

**Identity Tools**

- `setWorkspaceIdentity` - Sets name/description from requirements

**Component Generation**

- `generateSignals` - Creates schedule/HTTP triggers using Haiku
- `generateAgent` - Picks bundled agents or generates LLM agents using Sonnet 4
- `generateMCPServers` - Adds tool servers from MCP registry

**Orchestration Tools**

- `generateJobs` - Links signals to agents via execution jobs
- `removeJob` - Removes invalid job configurations

**Validation Tools**

- `validateWorkspace` - Checks references, unused components, required fields
- `exportWorkspace` - Produces final WorkspaceConfig
- `getSummary` - Returns component counts and IDs

## Atlas Integration

Built as Atlas system agent using `@atlas/agent-sdk`:

- **Input**: `{prompt: string}` - Natural language automation requirements
- **Output**: `WorkspaceResult` with config, API response, and summary
- **Models**: Claude Sonnet 4 (orchestration), Haiku (signal generation)
- **API**: Creates workspace via Atlas `/api/workspaces/create`

## Agent Selection Strategy

### Bundled Agent Priority

Checks existing agents first:

- Email agents for notifications
- File system agents for monitoring
- API agents for external integrations
- Research agents for data gathering

### LLM Agent Generation

Creates custom agents when no bundled agent fits:

- Generates role-specific prompts with XML structure
- Adds tool requirements for MCP server matching
- Uses temperature 0.3 for consistent output

### Single Responsibility Decomposition

Breaks complex automation into focused agents:

- ❌ One agent: read files, analyze content, send notifications
- ✅ Three agents: file-reader, content-analyzer, slack-notifier

## Configuration Output

### Workspace Structure

```typescript
{
  version: "1.0",
  workspace: { name: string, description: string },
  signals: { [id: string]: SignalConfig },    // Triggers
  agents: { [id: string]: AgentConfig },      // AI executors
  jobs: { [id: string]: JobSpecification },   // Orchestration
  tools: {
    mcp: {
      servers: { [id: string]: MCPServerConfig }  // Tool access
    }
  }
}
```

### Signal Types

- **Schedule**: Cron expressions for time-based triggers
- **HTTP**: Webhook endpoints for event-based triggers

### Agent Types

- **Atlas**: References bundled agents by ID
  - See: `@atlas/bundled-agents`
- **LLM**: Generated agents with model/prompt configuration
  - See: `packages/core/src/agent-conversion/from-llm.ts`

## Usage Examples

**GitHub Integration**

```
"Monitor new GitHub issues and create Slack notifications"
→ HTTP signal for GitHub webhooks
→ issue-analyzer agent (LLM)
→ slack-notifier agent (bundled)
→ Job connecting webhook → analyzer → notifier
```

**Scheduled Reports**

```
"Generate daily sales reports from Salesforce data"
→ Schedule signal (daily cron)
→ salesforce-fetcher agent (LLM with Salesforce tools)
→ report-generator agent (LLM with PDF tools)
→ Job connecting schedule → fetcher → generator
```

**File Monitoring**

```
"Watch uploads folder and process new documents"
→ Schedule signal (periodic checks)
→ file-watcher agent (bundled)
→ document-processor agent (LLM with PDF/OCR tools)
→ Job connecting schedule → watcher → processor
```

## Validation Rules

**Required Components**

- At least one signal (trigger)
- At least one agent (executor)
- At least one job (orchestration)
- Valid workspace name/description

**Reference Integrity**

- Jobs must reference existing signals and agents
- No orphaned signals or agents
- MCP servers match agent tool requirements

**Naming Conventions**

- All IDs converted to kebab-case
- Component names must be MCP-compliant (letters, numbers, underscores, hyphens)

## Error Handling

- Invalid references fail validation with specific error messages
- Missing components trigger regeneration attempts
- MCP server mismatches suggest alternative tools
- API failures include response status and error details

## Setup

1. Agent auto-registers as system agent with Atlas daemon
2. Call via workspace: `agents.call("workspace-creation", {prompt: "your requirements"})`
3. Returns complete workspace configuration ready for deployment
