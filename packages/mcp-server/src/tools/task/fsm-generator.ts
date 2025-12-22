/**
 * FSM generation for task execution
 *
 * Converts EnhancedTaskPlan → FSM Definition by wrapping workspace-creator infrastructure
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import { mapNeedToMCPServers } from "@atlas/core/mcp-registry/deterministic-matching";
import { logger } from "@atlas/logger";
import { fail, type Result, success } from "@atlas/utils";
import { validateFSMStructure } from "../../../../fsm-engine/validator.ts";
import { generateFSMCode } from "../../../../system/agents/fsm-workspace-creator/fsm-generation-core.ts";
import type { SimplifiedAgent } from "../../../../system/agents/fsm-workspace-creator/types.ts";
import { executeCodegen } from "../../../../workspace-builder/mcp-tools/codegen.ts";
import type { BuildError, FSMDefinition } from "../../../../workspace-builder/types.ts";
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
 * @returns Result with FSM definition or build errors
 */
export async function generateTaskFSM(
  plan: EnhancedTaskPlan,
  intent: string,
): Promise<Result<FSMDefinition, Error>> {
  logger.info("Generating FSM from task plan", {
    stepCount: plan.steps.length,
    needsCount: plan.needs.length,
  });

  // 1. Convert plan steps to SimplifiedAgent[]
  const agents: SimplifiedAgent[] = plan.steps.map((step, index) => {
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
        executionType: "bundled",
        bundledAgentId: agentId,
      };
    } else {
      // Ad-hoc LLM agent with MCP tools
      // Map capability names to server IDs using registry
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
        executionType: "llm",
        mcpTools: serverIds,
      };
    }
  });

  // 2. Build job plan structure
  const jobPlan: WorkspaceJobPlan = {
    id: "task-job",
    name: "Task Execution",
    triggerSignalId: "task-job-trigger", // Must match signal ID below
    steps: plan.steps.map((step) => ({
      agentId: step.agentId || `llm-step-${plan.steps.indexOf(step)}`,
      description: step.description,
    })),
    behavior: "sequential",
  };

  // 3. Create trigger signal (ID must match what executor will send)
  const triggerSignal: WorkspaceSignal = {
    id: "task-job-trigger", // Matches fsmId.replace(/-fsm$/, "-trigger")
    name: "Task Trigger",
    description: intent,
  };

  // 4. Generate FSM code via LLM
  logger.debug("Generating FSM code via LLM");
  let fsmCode: string;
  try {
    fsmCode = await generateFSMCode(jobPlan, agents, triggerSignal);
    logger.debug("FSM code generated", { codeLength: fsmCode.length });
  } catch (error) {
    logger.error("FSM code generation failed", { error });
    return fail(
      new Error(`FSM generation failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  // 5. Compile and validate via worker
  logger.debug("Compiling FSM code via worker");
  const codegenResult = await executeCodegen({ code: fsmCode, timeout: 30000 });

  if (!codegenResult.success) {
    logger.error("FSM compilation failed", { error: codegenResult.error });
    return fail(
      new Error(
        `FSM compilation failed: ${codegenResult.error.type} - ${codegenResult.error.message}`,
      ),
    );
  }

  const buildResult = codegenResult.result;
  if (!buildResult.success) {
    logger.error("FSM build failed", { errors: buildResult.error });
    const errorMessages = buildResult.error
      .map((e: BuildError) => `${e.type}: ${e.message}`)
      .join("; ");
    return fail(new Error(`FSM build failed: ${errorMessages}`));
  }

  const fsmDefinition = buildResult.value;

  // 6. Validate FSM structure
  logger.debug("Validating FSM structure");
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
    logger.error("FSM validation failed", {
      errors: validation.errors,
      warnings: validation.warnings,
      fsmId: fsmDefinition.id,
      triggerSignalId,
      initialState: fsmDefinition.initial,
    });
    return fail(
      new Error(
        `FSM validation failed:\n${validation.errors.join(
          "\n",
        )}\n\nGenerated FSM has structural issues that would prevent execution.`,
      ),
    );
  }

  if (validation.warnings.length > 0) {
    logger.warn("FSM validation warnings", {
      warnings: validation.warnings,
      fsmId: fsmDefinition.id,
    });
  }

  logger.info("FSM generation succeeded", {
    stateCount: fsmDefinition.states.length,
    fsmId: fsmDefinition.id,
  });

  return success(fsmDefinition);
}
