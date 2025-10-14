# Session Supervisor

Filters context before each agent execution to prevent token bloat. Makes binary include/exclude decisions about signal payloads and previous agent outputs.

## The Problem

Agents in multi-step workflows receive unfiltered outputs from previous agents. Agent 1 produces 2000 tokens → passed to Agent 2. Agent 2 produces 2000 more → both passed to Agent 3. By Agent 5, you're passing 8000+ tokens of accumulated noise.

This causes:

- Bloated contexts that exceed token limits
- Performance degradation from irrelevant information
- Agents spending budget on parsing noise instead of doing work

## How It Works

The session supervisor runs before each agent execution:

1. **Receives execution context**:
   - Workflow intent (what this workflow accomplishes)
   - Target agent's system prompt and input source
   - Signal payload (the trigger data)
   - Previous agent results (task, summary, artifact refs, token count)
   - Token budget constraints

2. **Makes binary decisions**:
   - Include signal payload? (If target agent uses "signal" or "combined" input)
   - Include each previous result? (Is it relevant to target agent's task AND workflow goal?)
   - Apply recency bias (recent results more likely relevant)
   - Get aggressive when token budget is tight (<25% available)

3. **Expands artifacts** (optional):
   - If previous results reference artifacts, fetches latest revisions
   - Injects artifact payloads directly into context
   - Avoids round-trips for agents that need artifact data

4. **Formats optimized context**:
   - Single coherent string ready for target agent
   - Workflow intent first
   - Relevant signal data second
   - Previous results last (most recent first)
   - Expanded artifacts copied verbatim (no modification)
   - Uses markdown for clarity

5. **Returns structured output**:
   - `optimizedContext`: The formatted context string
   - `metadata`: Token estimate, what was included
   - `reasoning`: Why these decisions were made (2-3 sentences)

## Design Decisions

### Why Binary Decisions?

Early versions used confidence scoring (0-100%). LLMs are bad at calibrating confidence. Binary forces clear reasoning: "Does this agent need this information? Yes or no."

### Why Expand Artifacts Here?

Agents can't make tool calls during execution in the current architecture. If Agent 3 needs an artifact from Agent 1, the supervisor expands it now. When agents get structured input support, this will move to lazy fetching by the agent itself.

### Why Include Reasoning?

Debugging context problems is hard when decisions are invisible. The reasoning field shows why the supervisor included/excluded each piece of context. Check logs when agents get irrelevant or missing information.

## Configuration

### Model

- **Filter**: Haiku 3.5 (fast binary decisions)

### System Prompt Highlights

- Binary include/exclude framework (no confidence scoring)
- Recency bias for previous results
- Token budget awareness (get selective when constrained)
- Artifact expansion instructions (copy verbatim, don't modify)
- Output formatting guidelines (markdown, clear sections)

### Token Budget Strategy

- **Adequate** (>25% available): Include all relevant context
- **Tight** (<25% available): Exclude borderline cases, keep only critical information

## Example Optimization

**Input**:

- Workflow intent: "Send daily sales report to Slack"
- Target agent: "You send Slack messages"
- Previous results:
  1. data-collector (150 tokens): "Collected sales metrics: revenue $45k, 23 customers"
  2. report-formatter (200 tokens): "Created HTML report artifact"
  3. schema-updater (180 tokens): "Updated database schema"

**Decision**:

- Include data-collector ✓ (provides content for message)
- Include report-formatter ✓ (contains the artifact to send)
- Exclude schema-updater ✗ (database changes irrelevant to Slack posting)

**Result**: 350 tokens of relevant context instead of 530 tokens with noise.

## Integration

This agent runs inside SessionSupervisor's `buildAgentPrompt()` logic. It's not exposed to users or workspace configurations. It's platform infrastructure.

When SessionSupervisor prepares to execute an agent:

```typescript
// Build workflow intent from workspace.yml descriptions
const workflowIntent = buildWorkflowIntent();

// Invoke session supervisor agent
const result = await sessionSupervisorAgent.execute({
  workflowIntent,
  agentSystemPrompt: agentConfig.systemPrompt,
  agentInputSource: agentTask.inputSource,
  signalPayload: sessionContext.payload,
  previousResults: enrichedResults,
  tokenBudget: calculateBudget(),
});

// Use optimized context directly
const agentPrompt = result.data.optimizedContext;
```
