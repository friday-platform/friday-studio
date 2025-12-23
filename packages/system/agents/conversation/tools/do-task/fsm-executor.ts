/**
 * FSM Executor Wrapper - adapts TaskExecutionContext to direct executor
 */
import type { GlobalMCPServerPool } from "@atlas/core";
import type { MCPToolProvider } from "@atlas/fsm-engine";
import type { FSMDefinition } from "../../../../../workspace-builder/types.ts";
import { type ExecutionResult, executeTaskViaFSMDirect } from "./fsm-executor-direct.ts";
import type { EnhancedTaskStep } from "./planner.ts";
import type { TaskExecutionContext } from "./types.ts";

export type { ExecutionResult } from "./fsm-executor-direct.ts";

export function executeTaskViaFSM(
  fsmDefinition: FSMDefinition,
  steps: EnhancedTaskStep[],
  context: TaskExecutionContext,
  mcpServerPool?: GlobalMCPServerPool,
  mcpToolProvider?: MCPToolProvider,
): Promise<ExecutionResult> {
  return executeTaskViaFSMDirect(fsmDefinition, steps, {
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    streamId: context.streamId,
    userId: context.userId,
    daemonUrl: context.daemonUrl,
    mcpServerPool,
    mcpToolProvider,
    onProgress: context.onProgress,
    abortSignal: context.abortSignal,
  });
}
