/**
 * FSM generation for task execution
 *
 * Converts EnhancedTaskPlan → FSM Definition by wrapping workspace-creator infrastructure
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import { mapNeedToMCPServers } from "@atlas/core/mcp-registry/deterministic-matching";
import { type FSMDefinition, validateFSMStructure } from "@atlas/fsm-engine";
import { logger } from "@atlas/logger";
import { fail, type Result, success } from "@atlas/utils";
import { type BuildError, executeCodegen } from "@atlas/workspace-builder";
import { enrichAgentsWithPipelineContext } from "../../../fsm-workspace-creator/agent-helpers.ts";
import {
  generateFSMCode,
  type PreviousAttempt,
} from "../../../fsm-workspace-creator/fsm-generation-core.ts";
import type { SimplifiedAgent } from "../../../fsm-workspace-creator/types.ts";
import type { EnhancedTaskPlan } from "./planner.ts";

type WorkspaceJobPlan = WorkspacePlan["jobs"][0];
type WorkspaceSignal = WorkspacePlan["signals"][0];

/**
 * Map capability names to MCP server IDs
 *
 * @param needs - Array of capability names (e.g., ["slack", "github"])
 * @returns Array of server IDs that match those capabilities
 */
function mapCapabilitiesToServerIds(needs: string[]): string[] {
  const serverIds = new Set<string>();

  for (const need of needs) {
    const matches = mapNeedToMCPServers(need);
    for (const match of matches) {
      serverIds.add(match.serverId);
    }
  }

  return Array.from(serverIds);
}

/**
 * Generate FSM definition from enhanced task plan
 *
 * Converts task plan steps into FSMBuilder code via LLM,
 * then compiles and validates it via worker.
 *
 * @param plan - Enhanced task plan with execution types and MCP needs
 * @param intent - User's original intent (for context)
 * @param abortSignal - Optional signal to cancel generation
 * @returns Result with FSM definition or build errors
 */
export async function generateTaskFSM(
  plan: EnhancedTaskPlan,
  intent: string,
  abortSignal?: AbortSignal,
): Promise<Result<FSMDefinition, Error>> {
  if (abortSignal?.aborted) {
    return fail(new Error("FSM generation cancelled"));
  }

  logger.info("Generating FSM from task plan", {
    stepCount: plan.steps.length,
    needsCount: plan.needs.length,
  });

  // 1. Build job steps structure (needed for both jobPlan and enrichment)
  const jobSteps = plan.steps.map((step, index) => ({
    agentId: step.agentId || `llm-step-${index}`,
    description: step.description,
  }));

  // 2. Convert plan steps to SimplifiedAgent[] with raw descriptions
  const rawAgents: SimplifiedAgent[] = plan.steps.map((step, index) => {
    if (step.executionType === "agent") {
      const agentId = step.agentId;
      if (!agentId) {
        throw new Error(`Step ${index} has executionType "agent" but no agentId`);
      }
      return {
        id: agentId,
        name: agentId,
        description: step.description,
        config: {},
        executionType: "bundled" as const,
        bundledAgentId: agentId,
      };
    }
    // Ad-hoc LLM agent with MCP tools
    const serverIds = mapCapabilitiesToServerIds(step.needs);
    logger.debug("Mapped capabilities to server IDs", {
      stepIndex: index,
      capabilities: step.needs,
      serverIds,
    });
    return {
      id: `llm-step-${index}`,
      name: step.description,
      description: step.description,
      config: {},
      executionType: "llm" as const,
      mcpTools: serverIds,
    };
  });

  // 3. Enrich agents with downstream data requirements (fixes TEM-3625)
  const agents = await enrichAgentsWithPipelineContext(rawAgents, jobSteps, abortSignal);

  // 4. Build job plan structure
  const jobPlan: WorkspaceJobPlan = {
    id: "task-job",
    name: "Task Execution",
    title: "Execute Task",
    triggerSignalId: "task-job-trigger",
    steps: jobSteps,
    behavior: "sequential",
  };

  // 5. Create trigger signal (ID must match what executor will send)
  const triggerSignal: WorkspaceSignal = {
    id: "task-job-trigger", // Matches fsmId.replace(/-fsm$/, "-trigger")
    name: "Task Trigger",
    title: "Triggers task execution",
    signalType: "http",
    description: intent,
  };

  // 6. Generate FSM code via LLM with retry on validation failures
  const MAX_RETRIES = 2;
  let previousAttempt: PreviousAttempt | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortSignal?.aborted) {
      return fail(new Error("FSM generation cancelled"));
    }

    logger.debug("Generating FSM code via LLM", {
      attempt: attempt + 1,
      maxAttempts: MAX_RETRIES + 1,
      isRetry: attempt > 0,
    });

    let fsmCode: string;
    try {
      fsmCode = await generateFSMCode(
        jobPlan,
        agents,
        triggerSignal,
        undefined,
        abortSignal,
        previousAttempt,
      );
      logger.debug("FSM code generated", { codeLength: fsmCode.length, attempt: attempt + 1 });
    } catch (error) {
      // Use warn for intermediate failures - only error after all retries exhausted
      logger.warn("FSM code generation failed (will retry)", { error, attempt: attempt + 1 });
      lastError = new Error(
        `FSM generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    // 5. Compile and validate via worker
    logger.debug("Compiling FSM code via worker", { attempt: attempt + 1 });
    const codegenResult = await executeCodegen({ code: fsmCode, timeout: 30000 });

    if (!codegenResult.success) {
      const errorMsg = `${codegenResult.error.type} - ${codegenResult.error.message}`;
      // Use warn for intermediate failures - only error after all retries exhausted
      logger.warn("FSM compilation failed (will retry)", {
        error: codegenResult.error,
        attempt: attempt + 1,
      });
      lastError = new Error(`FSM compilation failed: ${errorMsg}`);
      previousAttempt = { code: fsmCode, error: errorMsg };
      continue;
    }

    const buildResult = codegenResult.result;
    if (!buildResult.success) {
      const errorMessages = buildResult.error
        .map((e: BuildError) => `${e.type}: ${e.message}`)
        .join("; ");
      // Use warn for intermediate failures - only error after all retries exhausted
      logger.warn("FSM build failed (will retry)", {
        errors: buildResult.error,
        attempt: attempt + 1,
      });
      lastError = new Error(`FSM build failed: ${errorMessages}`);
      previousAttempt = { code: fsmCode, error: errorMessages };
      continue;
    }

    const fsmDefinition = buildResult.value;

    // 6. Validate FSM structure
    logger.debug("Validating FSM structure", { attempt: attempt + 1 });
    const validation = validateFSMStructure(fsmDefinition);

    // Additional validation: Check if initial state can receive trigger signal
    const initialState = fsmDefinition.states[fsmDefinition.initial];
    const triggerSignalId = triggerSignal.id;
    const hasInitialTransition =
      initialState?.on && Object.keys(initialState.on).includes(triggerSignalId);

    if (!hasInitialTransition) {
      validation.valid = false;
      validation.errors.push(
        `Initial state "${fsmDefinition.initial}" has no transition for trigger signal "${triggerSignalId}". ` +
          `Fix: Add transition from "${fsmDefinition.initial}" on "${triggerSignalId}" event.`,
      );
    }

    if (!validation.valid) {
      const errorMessages = validation.errors.join("\n");
      // Use warn for intermediate failures - only error after all retries exhausted
      logger.warn("FSM validation failed (will retry)", {
        errors: validation.errors,
        warnings: validation.warnings,
        fsmId: fsmDefinition.id,
        triggerSignalId,
        initialState: fsmDefinition.initial,
        attempt: attempt + 1,
      });
      lastError = new Error(
        `FSM validation failed:\n${errorMessages}\n\nGenerated FSM has structural issues that would prevent execution.`,
      );
      previousAttempt = { code: fsmCode, error: errorMessages };
      continue;
    }

    // Success!
    if (validation.warnings.length > 0) {
      logger.warn("FSM validation warnings", {
        warnings: validation.warnings,
        fsmId: fsmDefinition.id,
      });
    }

    logger.info("FSM generation succeeded", {
      stateCount: Object.keys(fsmDefinition.states).length,
      fsmId: fsmDefinition.id,
      attempts: attempt + 1,
    });

    return success(fsmDefinition);
  }

  // All retries exhausted
  logger.error("FSM generation failed after all retries", {
    maxRetries: MAX_RETRIES,
    lastError: lastError?.message,
  });
  return fail(lastError ?? new Error("FSM generation failed after all retries"));
}
