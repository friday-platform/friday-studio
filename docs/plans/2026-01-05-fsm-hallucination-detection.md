<!-- v2 - 2026-01-05 - Generated via design-review swarm from docs/plans/2026-01-05-fsm-hallucination-detection.md -->

# FSM Hallucination Detection

**Date:** 2026-01-05
**Status:** Draft
**Owner:** TBD

## Problem

PR #826 replaced the XState orchestration with FSM Engine. The old hallucination
detection in `SessionSupervisor` was deleted but never wired into the new
architecture.

Ad-hoc LLM steps in do-task (e.g., "tell me who's in my Linear team") become FSM
`type: "llm"` actions. These execute in `packages/fsm-engine/fsm-engine.ts` via
`llmProvider.call()` and store `{ ...response.data, content: response.content }`
into an `LLMResult` document.

Today, `AtlasLLMProviderAdapter` captures tool execution traces into
`LLMResponse.data` (`toolCalls` + `toolResults`), but **nothing consumes that
trace to validate whether the final `content` is actually supported by tool
outputs**. When tools return empty/partial data, the model can fabricate and the
FSM happily persists it.

### Current Validation Coverage

| Path | Validated? |
|------|------------|
| FSM `type: "llm"` actions | **No** (this PR fixes) |
| FSM `type: "agent"` → LLM agent | Yes (`validateAgentOutput` in agent-helpers.ts) |
| FSM `type: "agent"` → SDK/system agent | No (intentional - code-based) |

## Solution

Add optional `validateOutput` callback to `FSMEngineOptions`. Called after every
`type: "llm"` action, with access to the prompt actually used (including injected
document context) and the tool execution trace.

**Behavior:**
- If validation fails: retry the same LLM action once, injecting feedback into the prompt
- If validation fails again: throw to abort the current transition (FSMEngine is already transactional per-signal; throwing prevents commit + persistence)
- If the validator itself errors (network, model outage): **fail-closed** (throw) - validation is required when enabled

**Design principle:** Adapt FSM data to existing hallucination detector interface, don't change the detector's signature.

## Changes

### 1. New Types (`packages/fsm-engine/types.ts`)

Add these types (note: `ValidationResult` already exists in `validator.ts`, so we use distinct names):

```typescript
/**
 * Trace data from an LLM action, capturing what's needed for hallucination detection.
 * Matches structure of LLMResponse.data from llm-provider-adapter.ts.
 */
export interface LLMActionTrace {
  content: string;
  /** Tool calls made during execution */
  toolCalls?: Array<{ name: string; input: unknown }>;
  /** Tool results returned - separate from calls per AI SDK convention */
  toolResults?: Array<{ toolName: string; toolCallId: string; output: unknown }>;
  model: string;
  prompt: string;
}

/**
 * Result of validating LLM output.
 * Named distinctly to avoid collision with ValidationResult in validator.ts.
 */
export interface LLMOutputValidationResult {
  valid: boolean;
  /** Required when valid=false - feedback for retry prompt */
  feedback?: string;
}

export type OutputValidator = (trace: LLMActionTrace) => Promise<LLMOutputValidationResult>;
```

Add to `FSMEngineOptions` in `packages/fsm-engine/fsm-engine.ts` (line 64-70):

```typescript
export interface FSMEngineOptions {
  llmProvider?: LLMProvider;
  documentStore: DocumentStore;
  scope: DocumentScope;
  agentExecutor?: AgentExecutor;
  mcpToolProvider?: import("./mcp-tool-context.ts").MCPToolProvider;
  validateOutput?: OutputValidator; // NEW
}
```

### 2. Validation Hook (`packages/fsm-engine/fsm-engine.ts`)

In `executeAction()` case `"llm"`, after `llmProvider.call()` (around line 610):

```typescript
let response = await this.options.llmProvider.call({
  model: action.model,
  prompt: contextPrompt,
  tools,
  toolChoice: "required",
});

// Check if LLM called failStep
if (response.calledTool?.name === "failStep") {
  throw new Error(`LLM step failed: ${JSON.stringify(response.calledTool.args)}`);
}

// Validate output if validator provided
if (this.options.validateOutput) {
  const trace: LLMActionTrace = {
    content: response.content,
    toolCalls: response.data?.toolCalls?.map((tc: { name: string; input: unknown }) => ({
      name: tc.name,
      input: tc.input,
    })),
    toolResults: response.data?.toolResults?.map((tr: { toolName: string; id: string; output: unknown }) => ({
      toolName: tr.toolName,
      toolCallId: tr.id,
      output: tr.output,
    })),
    model: action.model,
    prompt: contextPrompt,
  };

  const validation = await this.options.validateOutput(trace);
  // Note: If validator throws, error propagates and aborts the action (fail-closed)

  if (!validation.valid) {
    logger.warn("LLM action failed validation, retrying with feedback", {
      state: currentState,
      model: action.model,
      feedback: validation.feedback,
    });

    const retryPrompt =
      `${contextPrompt}\n\n` +
      `<validation-feedback>\n${validation.feedback ?? "Output failed validation."}\n</validation-feedback>\n` +
      `IMPORTANT: Use only data from tool results. If you cannot comply, call failStep.`;

    response = await this.options.llmProvider.call({
      model: action.model,
      prompt: retryPrompt,
      tools,
      toolChoice: "required",
    });

    // Build trace from retry response
    const retryTrace: LLMActionTrace = {
      content: response.content,
      toolCalls: response.data?.toolCalls?.map((tc: { name: string; input: unknown }) => ({
        name: tc.name,
        input: tc.input,
      })),
      toolResults: response.data?.toolResults?.map((tr: { toolName: string; id: string; output: unknown }) => ({
        toolName: tr.toolName,
        toolCallId: tr.id,
        output: tr.output,
      })),
      model: action.model,
      prompt: retryPrompt,
    };

    const retryValidation = await this.options.validateOutput(retryTrace);

    if (!retryValidation.valid) {
      logger.error("LLM action failed validation after retry", {
        state: currentState,
        model: action.model,
        feedback: retryValidation.feedback,
      });
      throw new Error(
        `LLM action failed validation after retry: ${retryValidation.feedback ?? "no feedback"}`
      );
    }

    logger.info("LLM action passed validation on retry", {
      state: currentState,
      model: action.model,
    });
  }
}

// Continue with existing code to store result...
```

### 3. Validator Factory (`src/core/services/fsm-output-validator.ts`)

New file that adapts `LLMActionTrace` to the existing `AgentResult` interface:

```typescript
import type { AgentResult } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import type { LLMActionTrace, LLMOutputValidationResult } from "@atlas/fsm-engine";
import {
  analyzeResults,
  containsSeverePatterns,
  getSevereIssues,
  type HallucinationDetectorConfig,
} from "./hallucination-detector.ts";
import { SupervisionLevel } from "../supervision-levels.ts";

/**
 * Convert FSM LLM action trace to AgentResult for hallucination detection.
 *
 * The hallucination detector expects AgentResult with toolCalls/toolResults.
 * We adapt the FSM trace format to match without changing the detector.
 */
function traceToAgentResult(trace: LLMActionTrace): AgentResult {
  return {
    agentId: "fsm-llm-action",
    task: trace.prompt,
    input: trace.prompt,
    output: trace.content,
    toolCalls: trace.toolCalls?.map((tc) => ({
      toolName: tc.name,
      toolCallId: `tc-${crypto.randomUUID().slice(0, 8)}`,
      input: tc.input,
    })),
    toolResults: trace.toolResults?.map((tr) => ({
      toolName: tr.toolName,
      toolCallId: tr.toolCallId,
      result: tr.output,
    })),
    duration: 0,
  };
}

/**
 * Create a validator function for FSM LLM actions.
 *
 * Uses existing hallucination detector infrastructure.
 * Adapts LLMActionTrace -> AgentResult at the boundary.
 */
export function createFSMOutputValidator(
  supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD,
): (trace: LLMActionTrace) => Promise<LLMOutputValidationResult> {
  return async (trace: LLMActionTrace): Promise<LLMOutputValidationResult> => {
    const agentResult = traceToAgentResult(trace);

    const config: HallucinationDetectorConfig = {
      logger: logger.child({ component: "fsm-output-validator" }),
    };

    const analysis = await analyzeResults([agentResult], supervisionLevel, config);

    const isSevere = analysis.averageConfidence < 0.3 || containsSeverePatterns(analysis.issues);

    if (isSevere) {
      const severeIssues = getSevereIssues(analysis.issues);
      return {
        valid: false,
        feedback: severeIssues.length > 0 ? severeIssues.join("; ") : analysis.issues.join("; "),
      };
    }

    return { valid: true };
  };
}
```

### 4. Wire Up Integration Points

**`packages/system/agents/conversation/tools/do-task/fsm-executor-direct.ts`** (around line 181-187):

```typescript
import { createFSMOutputValidator } from "../../../../../../src/core/services/fsm-output-validator.ts";
import { SupervisionLevel } from "../../../../../../src/core/supervision-levels.ts";

// Inside executeTaskViaFSMDirect function:
const engine = createEngine(fsmDefinition, {
  documentStore: docStore,
  llmProvider: new AtlasLLMProviderAdapter("claude-sonnet-4-5"),
  scope,
  agentExecutor,
  mcpToolProvider: context.mcpToolProvider,
  validateOutput: createFSMOutputValidator(SupervisionLevel.STANDARD),
});
```

**`src/core/workspace-runtime.ts`** (around line 352-358):

```typescript
import { createFSMOutputValidator } from "./services/fsm-output-validator.ts";
import { SupervisionLevel } from "./supervision-levels.ts";

// Inside initializeJobEngine method:
const engineOptions = {
  documentStore: job.documentStore,
  scope,
  llmProvider: new AtlasLLMProviderAdapter("claude-sonnet-4-5"),
  agentExecutor,
  mcpToolProvider,
  validateOutput: createFSMOutputValidator(SupervisionLevel.STANDARD),
};
```

### 5. Export New Types

**`packages/fsm-engine/mod.ts`** - add exports:

```typescript
// Add to existing exports
export type {
  LLMActionTrace,
  LLMOutputValidationResult,
  OutputValidator,
} from "./types.ts";
```

## Files Changed

| File | Change |
|------|--------|
| `packages/fsm-engine/types.ts` | Add `LLMActionTrace`, `LLMOutputValidationResult`, `OutputValidator` |
| `packages/fsm-engine/fsm-engine.ts` | Add `validateOutput` to options interface, add validation hook in `case "llm"` |
| `packages/fsm-engine/mod.ts` | Export new types |
| `src/core/services/fsm-output-validator.ts` | **New file** - validator factory with trace→AgentResult adapter |
| `packages/system/.../fsm-executor-direct.ts` | Wire up `validateOutput` |
| `src/core/workspace-runtime.ts` | Wire up `validateOutput` |

**NOT changed:**
- `src/core/services/hallucination-detector.ts` - signature unchanged, adapter handles conversion
- `src/core/agent-helpers.ts` - continues working as-is
- `tools/evals/.../fabrication-detection.eval.ts` - no changes needed

## Testing Requirements

### Unit Tests (`packages/fsm-engine/validation.test.ts` - new file)

1. **Validator called after LLM action completes**
   - Mock validator, verify it receives correct trace structure

2. **Retry with feedback on validation failure**
   - First validation fails → verify retry prompt includes feedback
   - Second validation passes → verify success

3. **Throw on second validation failure**
   - Both validations fail → verify error thrown with feedback

4. **Validation skipped when no validator provided**
   - No `validateOutput` in options → verify no validation occurs

5. **Fail-closed on validator error**
   - Validator throws → verify error propagates and action aborts

6. **Trace builder handles missing toolResults**
   - LLM returns no tools → verify trace built correctly with undefined fields

### Integration Tests

Add FSM-based test scenarios to existing eval infrastructure:
- LLM action with fabricated data → should fail validation
- LLM action with valid tool usage → should pass
- LLM action with no tools but external claims → should fail

## Future Work

- Add `validateOutput` support for FSM `type: "agent"` actions
- Make supervision level configurable per-workspace via `workspace.yml`
- Metrics/observability for validation failures and retries
- Per-action validation opt-out for performance-critical paths

## Design Decisions

1. **Fail-closed on validator errors:** If the validator itself throws (network, model outage), the error propagates and aborts the action. Validation is required when enabled.

2. **Performance accepted:** Validation adds another LLM call (haiku) per step. This is acceptable overhead for the safety it provides.

3. **Retry uses new tool results:** On retry, validation compares against the new tool results from the retry response, not the original results.

4. **Hardcoded STANDARD supervision:** Both integration points use `SupervisionLevel.STANDARD`. Configurable per-workspace deferred to future work.

5. **Throwing is sufficient for rollback:** FSM engine's existing transactional behavior (throwing prevents commit) is sufficient - no explicit rollback needed.
