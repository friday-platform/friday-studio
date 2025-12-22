# Conversation Task Execution - MVP Implementation & Discussion

> **Status**: MVP Implemented (2025-12-15)
> **Branch**: `chat-task-execution`
> **Related**: See `CONVERSATION_TASK_EXECUTION_DESIGN.md` for full design

## Executive Summary

**Problem**: Conversation agent picks wrong tools frequently, doesn't recognize existing workspaces, executes inconsistently ("different way every time").

**Root Cause**: Choice overload - 40+ agent tools → poor decision making → incorrect/inconsistent results.

**Hypothesis**: Limiting tools + focused planning layer → better agent decisions.

**MVP Approach**: Test hypothesis with minimal implementation - no FSM, no caching, no storage. Just: plan → execute → measure.

## Critical Context (Missing from Original Design)

The original design doc framed this as a "scaling problem" (too many tools), but the actual problem reported by user is:

1. **Wrong agent selection** - Picks suboptimal agents for tasks
2. **Workspace blindness** - Doesn't notice existing workspaces that could handle the task
3. **Inconsistent execution** - Same task executed differently each time
4. **Incorrect results** - Often produces wrong outcomes

This is a **decision quality problem**, not just a token cost problem.

## Design Review Discussion

### Initial Skepticism

Initial assessment of the design doc identified several concerns:

1. **Token cost increase**: 10x increase (500 → 4-5k tokens) seemed too expensive
2. **Complexity explosion**: ~8 new files, FSM generation, caching, retry logic
3. **Fragile caching**: Text normalization for cache keys could cause false hits
4. **Intent accumulation issues**: No way to remove intents, only accumulate
5. **Per-task orchestrator rationale**: Seemed backwards (why not share?)
6. **Multiple versions in 2 days**: Suggested rushed design

### Revised Assessment (With Context)

After understanding the decision quality problem, the design makes more sense:

**Token cost is acceptable** because:
- Current approach has hidden costs: retries + corrections + failed attempts
- If current fails 40% of the time, effective cost is higher than proposed
- Correctness > efficiency

**Separation of concerns helps** because:
- Conversation agent: workspace management + conversation flow
- Planning LLM: agent selection only (focused, specialized task)
- Reduces cognitive load on conversation agent

**FSM execution solves "different every time"**:
- Deterministic plan generation
- Stored plan enables consistent modification
- Forces systematic execution pattern

### Key Insights

1. **This solves a real problem** - not premature optimization
2. **Tradeoff is reasonable** - more tokens for better decisions
3. **But design needs simplification** - too much complexity for MVP

## MVP Implementation

### What We Built

**Three new files** (~250 lines total):

1. **`packages/mcp-server/src/tools/task/catalog.ts`**
   - Gets list of available agents from AgentRegistry
   - Filters out conversation agent (prevent recursion)
   - Returns simple list: id, name, description

2. **`packages/mcp-server/src/tools/task/planner.ts`**
   - Uses Sonnet 4.5 to select agents for a given intent
   - Input: intent string + agent catalog
   - Output: `PlanResult` (success with steps OR failure with reason)
   - Validates LLM output with type guards

3. **`packages/mcp-server/src/tools/task/do-task.ts`**
   - MCP tool that conversation agent can call
   - Flow: get catalog → plan → execute sequentially → return results
   - Creates AgentOrchestrator per-task, shuts down after
   - No caching, no storage, no retry - pure MVP

**Two modified files**:

1. **`packages/mcp-server/src/tools/index.ts`**
   - Registered `do_task` tool

2. **`packages/system/agents/conversation/conversation.agent.ts`**
   - Commented out agent server MCP connection
   - Commented out notification handlers
   - Commented out agent tool registration (40+ tools removed)
   - Added tool allowlist (~20 workspace mgmt tools + `do_task`)
   - Removed unused imports

### What We Cut (For MVP)

- ❌ FSM generation/execution - just loop over steps
- ❌ Active task storage - ephemeral execution only
- ❌ Caching/step reuse - re-execute every time
- ❌ Retry logic - fail on first error
- ❌ Intent accumulation - single intent per call
- ❌ Task modification - no "also email me" support
- ❌ MCP requirement validation - assume agents work
- ❌ Artifact tracking - basic results only
- ❌ Timeout handling - use default
- ❌ Streaming progress - results at end only

### Architecture

```
Conversation Agent (limited tools)
  ↓ do_task(intent)
Task Handler
  1. getAgentCatalog() → [agents]
  2. planTask(intent, agents) → plan | error
  3. for each step:
       - AgentOrchestrator.executeAgent()
       - collect results
  4. return results
```

No FSM, no storage, no state machines. Simple sequential execution.

## Key Technical Decisions

### 1. AgentRegistry Creation

```typescript
// Not a singleton - create new instance
const registry = new AgentRegistry({ includeSystemAgents: false });
await registry.initialize();
const agents = await registry.listAgents();
```

### 2. Per-Task Orchestrator

```typescript
// Create new orchestrator per task
const orchestrator = new AgentOrchestrator({
  agentsServerUrl: `${ctx.daemonUrl}/agents`,
  mcpServerPool: undefined, // MVP: not needed
  daemonUrl: ctx.daemonUrl,
  requestTimeoutMs: 300000,
}, logger);

try {
  // execute steps
} finally {
  await orchestrator.shutdown(); // Always cleanup
}
```

**Why per-task?** MCP connections are pooled separately. Orchestrator is lightweight wrapper. Clean lifecycle is simpler than shared orchestrator management.

### 3. Planning LLM Prompt

Key elements:
- Lists all available agents with descriptions
- Asks LLM to think through: what's needed? which agents? what order?
- Requests JSON output with explicit structure
- Includes examples of good planning
- Allows LLM to return error if no agents match

### 4. Tool Allowlist (Not Blocklist)

```typescript
const ALLOWED_TOOLS = new Set([
  "atlas_workspace_list",
  "atlas_workspace_create",
  // ... ~20 workspace/session/job/signal tools
  "do_task", // NEW
]);
```

**Fail-closed security**: New tools excluded by default until explicitly added.

## Testing the MVP

### Test Cases

1. **Simple single-agent task**
   ```
   "what's on my calendar today?"
   Expected: google-calendar agent only
   ```

2. **Multi-step task**
   ```
   "check my calendar and email me the results"
   Expected: google-calendar → gmail-send
   ```

3. **Consistency test**
   ```
   "send a message to the team"
   Expected: Same choice (slack OR email) every time
   ```

4. **Failure mode**
   ```
   "translate to Klingon using Duolingo API"
   Expected: Planning fails with clear reason
   ```

5. **Workspace awareness** (conversation agent responsibility)
   ```
   User has "daily-standup" workspace
   "what's my standup status?"
   Expected: Uses workspace, NOT do_task
   ```

### Success Metrics

Track for 1-2 weeks:

**Agent Selection Accuracy**
- Does planner pick the right agents?
- Compare to baseline (current approach)

**Consistency**
- Same intent → same plan?
- Measure variance in agent selection

**User Correction Rate**
- How often does user say "no, wrong agent"?
- Compare to baseline

**First-Attempt Success Rate**
- Task succeeds without retries?
- Compare to current retry rate

### Decision Criteria

**If planning quality is BETTER:**
- Proceed with full design
- Add FSM execution (deterministic, resumable)
- Add caching (reuse step results)
- Add active task storage (modify intents)
- Add retry logic
- Add streaming progress

**If planning quality is SAME/WORSE:**
- Don't build the rest
- Problem isn't tool count
- Investigate alternatives:
  - Better tool descriptions?
  - Few-shot examples in conversation prompt?
  - Different agent discovery mechanism?
  - Hybrid approach (workspaces for multi-step, direct for simple)?

**If planning is BETTER but TOO SLOW:**
- Try Haiku for planning (faster, cheaper)
- Cache plans for common intents
- Optimize before adding features

## Issues with Original Design (To Fix If We Proceed)

### 1. Type System Issues

**Problem**: `ActiveTask.status` includes "idle" but tasks execute immediately.

```typescript
// WRONG
status: "idle" | "running" | "failed" | "completed"

// CORRECT
status: "running" | "failed" | "completed"
```

**Problem**: `ExecutionResult.error` conflates planning and execution failures.

```typescript
// WRONG
error?: { type: "timeout" | "cancelled" | "agent_error" | "planning_failed" }

// CORRECT - Split into two types
type TaskResult =
  | { success: true; execution: ExecutionResult }
  | { success: false; stage: "planning" | "execution"; error: Error }
```

### 2. Cache Key Fragility

**Problem**: Text normalization causes false cache hits.

```typescript
// WRONG - too aggressive normalization
const normalized = step.description.toLowerCase().replace(/\s+/g, " ").trim();
return `${step.agentId}:${hashString(normalized)}`;

// "Fetch today's events" → same hash as "Fetch yesterday's events"
```

**Solutions**:
- Option A: No normalization - force planner to be consistent
- Option B: Use semantic similarity (embeddings) instead of text matching
- Option C: Don't rely on description - use explicit step IDs from planner

### 3. Intent Modification Logic

**Problem**: How does planner know "also X" vs "instead of X, do Y" vs "forget X"?

**Solution**: Add explicit reasoning to planning prompt:

```typescript
Intent relationships:
- "also X" → append (add step)
- "instead of X, do Y" → replace X step with Y step
- "actually Z" → analyze context, likely replacement
- "forget that" → remove most recent intent
```

Or simpler: For MVP, don't support modification - each `do_task` call is fresh.

### 4. Error Classification

**Problem**: Retry logic assumes all errors are transient.

**Solution**: Add error classification:

```typescript
interface AgentError {
  type: "transient" | "auth" | "invalid_input" | "not_found";
  retryable: boolean;
  agentId: string;
  message: string;
}

// Only retry if error.retryable === true
```

### 5. MCP Connection Lifecycle

**Clarification**: mcpServerPool is shared, orchestrator is per-task.

```typescript
// Per-task orchestrator, shared connection pool
const orchestrator = new AgentOrchestrator({
  mcpServerPool: ctx.mcpServerPool, // SHARED (expensive connections)
  // ... other per-task config
});
```

The design doc was correct here - just needed clarification.

## Hybrid Approach (Future Consideration)

If single-agent tasks don't need planning overhead:

```typescript
const plan = await planTask(...);

// Optimization: skip FSM for simple cases
if (plan.agents.length === 1 && plan.steps.length === 1) {
  // Direct execution (faster path)
  const result = await orchestrator.executeAgent(
    plan.agents[0].id,
    plan.steps[0].description,
    ctx
  );
  return result;
}

// Complex tasks use FSM
const fsmCode = await generateFSMCode(...);
// ...
```

This cuts token cost for common case while keeping FSM benefits for complex workflows.

## Implementation Notes

### Lessons Learned

1. **Context is critical** - "too many tools" framing hid the real problem (decision quality)
2. **YAGNI applies to design docs too** - 4 versions in 2 days was a red flag
3. **MVP first** - test hypothesis before building 8 files of FSM infrastructure
4. **Type errors reveal design issues** - "idle" status revealed execution model confusion

### Code Quality

All files pass type checking:
```bash
deno check packages/mcp-server/src/tools/task/*.ts
deno check packages/system/agents/conversation/conversation.agent.ts
```

Total new code: ~250 lines
Total modified code: ~50 lines
Implementation time: ~4 hours

### What Worked Well

- Separation into three small, focused files
- Using existing AgentRegistry and AgentOrchestrator
- Tool allowlist pattern (fail-closed security)
- Discriminated union for PlanResult
- Explicit type guards for LLM output validation

### What Could Be Better

- Planning prompt could use more examples
- Error messages could be more user-friendly
- Synthetic session IDs (`task-${Date.now()}`) are fragile
- No telemetry/metrics built in (need to add for evaluation)

## Next Steps

### 1. Deploy & Test (This Week)

- Start daemon with MVP changes
- Test with real conversations
- Collect metrics (agent selection, consistency, corrections)
- Note failure modes and edge cases

### 2. Evaluate (End of Week)

- Compare metrics to baseline
- Gather user feedback
- Decide: proceed with full design, iterate on MVP, or pivot?

### 3. If Proceeding (Next Week)

Phase 1: Add FSM execution
- Reuse `generateFSMCode()` from workspace-creator
- Add FSM compilation worker
- Test deterministic execution

Phase 2: Add caching
- Implement cache key strategy (decision from evaluation)
- Add InMemoryDocumentStore for step results
- Test cache hit rate

Phase 3: Add task storage
- Active task artifact storage
- Intent accumulation with modification logic
- Test "also email me" flows

Phase 4: Polish
- Error recovery
- Streaming progress
- Timeout handling
- MCP requirement validation

### 4. If Pivoting

Alternative approaches to explore:
- **Smart tool filtering**: Pre-filter 40+ tools to top 5-10 for context
- **Better descriptions**: Improve agent descriptions to help current selection
- **Few-shot examples**: Add examples of good agent choices to conversation prompt
- **Workspace preference hints**: Teach conversation agent to check workspaces first

## References

- Original design: `docs/CONVERSATION_TASK_EXECUTION_DESIGN.md`
- Agent SDK: `packages/agent-sdk/`
- Agent orchestrator: `packages/core/src/orchestrator/agent-orchestrator.ts`
- Agent registry: `packages/core/src/agent-loader/registry.ts`
- FSM generation (for phase 1): `packages/system/agents/fsm-workspace-creator/`

## Open Questions

1. **Should planning cache common intents?** "check my calendar" is probably asked often
2. **How to handle multi-turn tasks?** "check calendar" → "also email me" requires state
3. **Workspace awareness**: Should do_task know about workspaces? Or only conversation agent?
4. **Agent descriptions**: Are current descriptions good enough for planning?
5. **Failure attribution**: How to tell if failure is planner's fault vs agent's fault?

## Changelog

**2025-12-15**: MVP implemented
- Created catalog, planner, do_task files
- Modified conversation agent to use tool allowlist
- All type checks passing
- Ready for testing

---

**Remember**: This is an MVP to test a hypothesis. Don't add features until we know if the approach works. Speed of learning > completeness of implementation.
