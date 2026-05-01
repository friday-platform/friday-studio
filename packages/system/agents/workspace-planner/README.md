# Workspace Planner

Translates user requirements into Atlas workspace plans (signals, agents, jobs). Supports creating new plans and revising existing ones.

## Architecture

### Two-Phase Generation

The planner uses a two-phase approach to prevent LLM hallucination of invalid references:

**Phase 1**: Generate workspace, signals, and agents with natural language names. Post-process to add kebab-case IDs programmatically with numeric deduplication (e.g., `daily-report`, `daily-report-2`).

**Phase 2**: Generate jobs using Zod enum constraints from Phase 1 IDs. The schema only allows valid signal/agent references, making hallucinated IDs a type error.

This pattern trades an extra LLM call for guaranteed referential integrity.

### Key Files

- `workspace-planner.agent.ts` - Main agent with two-phase generation logic
- `mod.ts` - Export

## How It Works

1. **Load Existing Plan** (if revising): Fetch artifact by ID, pass to LLM as context for minimal changes

2. **Phase 1 - Signals/Agents**: Sonnet 4 generates workspace structure with natural names. System prompt includes affinity principle to prevent over-decomposition. Code adds kebab-case IDs deterministically.

3. **Phase 2 - Jobs**: Sonnet 4 generates job orchestrations with Zod enum constraints:

   ```typescript
   triggerSignalId: z.enum(["daily-report", "manual-trigger"]);
   agentId: z.enum(["report-generator", "slack-notifier"]);
   ```

   Invalid references fail schema validation before reaching the database.

4. **Save Artifact**: Create or update workspace plan artifact. For revisions, Haiku generates a diff summary comparing old vs new.

5. **Return Metadata**: Send back artifact ID and revision number for client-side rendering.

## Design Decisions

### Why Two Phases?

Early versions generated everything in one call. LLMs would hallucinate job references like `daily-report-generator` when the agent was named `report-generator`. Two phases with enum constraints make this impossible - the schema enforces valid references.

### Why Programmatic IDs?

Asking LLMs to generate both names and IDs produces inconsistencies. Names are their strength (natural language). IDs are mechanical transformation (kebab-case, dedup). Separate concerns.

### Why Affinity Principle?

Users naturally over-decompose ("Nike Monitor" + "Adidas Monitor" instead of one "Shoe Monitor" with targets). The system prompt teaches consolidation by affinity - group similar work, split different systems. Target 1-6 agents total.

### Why Minimal Configuration?

Configuration captures user-specific values only (channel names, targets, preferences). Technical details (URLs, intervals, data structures) belong in agent implementation. This keeps plans focused on "what" not "how".

## Configuration

### Models

- **Planner**: Sonnet 4 (requires reasoning for affinity decisions and constraint understanding)
- **Summarizer**: Haiku 4.5 (fast diff summaries for revision messages)

### System Prompt Sections

- Agent Affinity Principle (consolidation rules with examples)
- Configuration Boundary (what belongs in config vs code)
- Planning Guidelines (identify triggers, apply affinity, connect flows)
- Writing Guidelines (direct prose, no buzzwords)

### Example Plans

**Simple** (1-2 agents):

- "Send me daily GitHub issue summaries" → signal: cron, agent: issue-aggregator, job: sequential

**Moderate** (3-4 agents):

- "Monitor sneaker drops and notify Slack" → signal: schedule, agents: [site-scraper, slack-notifier], job: sequential

**Complex** (5-6 agents):

- "Daily standup prep from calendar + GitHub + Slack" → signal: cron, agents: [calendar-reader, github-analyzer, slack-digester, report-compiler], job: parallel → sequential
