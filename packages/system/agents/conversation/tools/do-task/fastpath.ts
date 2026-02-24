/**
 * Fastpath gate and data construction for do_task.
 *
 * Determines whether a planned job qualifies for the single-agent fastpath,
 * which builds a trivial 3-state FSM directly instead of running the full
 * compiler pipeline. When eligible, builds the minimal FSM definition and
 * executor data structures needed by executeTaskViaFSMDirect.
 */

import { randomUUID } from "node:crypto";
import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import type {
  Agent,
  AgentClarification,
  DAGStep,
  DocumentContract,
  FSMDefinition,
} from "@atlas/workspace-builder";
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, stateName } from "@atlas/workspace-builder";
import type { DatetimeContext, EnhancedTaskStep } from "./types.ts";

/**
 * Returns true when a plan qualifies for the single-agent fastpath:
 * exactly one agent, no classification ambiguity, and the agent is
 * either bundled or backed by at least one MCP server.
 *
 * @param plan - The planned job containing agents
 * @param classifyResult - Classification result with any clarifications
 */
export function isFastpathEligible(
  plan: { agents: Agent[] },
  classifyResult: { clarifications: AgentClarification[] },
): boolean {
  if (plan.agents.length !== 1) return false;
  if (classifyResult.clarifications.length > 0) return false;

  const agent = plan.agents[0];
  if (!agent) return false;

  if (agent.bundledId) return true;
  if (agent.mcpServers && agent.mcpServers.length > 0) return true;
  if (agent.capabilities.length === 0) return true;

  return false;
}

/**
 * Build a minimal DAGStep for a single-agent fastpath dispatch.
 *
 * @param agent - The classified agent from the plan
 * @param intent - The user's original task intent
 */
export function buildFastpathDAGStep(agent: Agent, intent: string): DAGStep {
  const slug = agent.name.replace(/\s+/g, "-");
  return { id: `${slug}-step`, agentId: agent.id, description: intent, depends_on: [] };
}

/**
 * Build a minimal EnhancedTaskStep for executor progress reporting.
 * Maps bundled agents to executionType "agent" (matching blueprintToTaskPlan convention).
 *
 * @param agent - The classified agent from the plan
 * @param intent - The user's original task intent
 */
export function buildFastpathStep(agent: Agent, intent: string): EnhancedTaskStep {
  return {
    agentId: agent.id,
    executionRef: agent.bundledId ?? agent.id,
    description: intent,
    executionType: agent.bundledId ? "agent" : "llm",
    capabilities: agent.capabilities,
    friendlyDescription: agent.description,
  };
}

/**
 * Build a minimal DocumentContract so the executor's primary result lookup
 * path works. Without this, outputTo: "result" data is silently lost.
 *
 * @param dagStep - The DAGStep whose id becomes producerStepId
 */
export function buildFastpathContract(dagStep: DAGStep): DocumentContract {
  return {
    producerStepId: dagStep.id,
    documentId: "result",
    documentType: "result",
    schema: { type: "object" } as ValidatedJSONSchema,
  };
}

/**
 * Build a context-aware prompt matching the agent executor format.
 * Injects datetime facts and "Task:" framing so the LLM has grounding
 * context identical to what bundled agents receive.
 *
 * @param intent - The user's original task intent
 * @param datetime - Optional datetime context from the session
 */
function buildGroundedPrompt(intent: string, datetime?: DatetimeContext): string {
  const datetimeSection = datetime
    ? `## Context Facts\n- Current Date: ${datetime.localDate}\n- Current Time: ${datetime.localTime} (${datetime.timezone})\n- Timestamp: ${datetime.timestamp}\n- Timezone Offset: ${datetime.timezoneOffset}\n\n`
    : "";
  return `${datetimeSection}Task: ${intent}`;
}

/**
 * Build a trivial 3-state FSM (idle -> step -> completed) for single-agent dispatch.
 * Branches on agent type: bundled agents use an agent action, LLM agents use an llm action.
 * Both set outputTo: "result" — critical for result collection.
 *
 * @param agent - The classified agent from the plan
 * @param dagStep - The DAGStep (used for state naming)
 * @param intent - The user's original task intent (used as action prompt)
 * @param datetime - Optional datetime context for prompt grounding
 */
export function buildFastpathFSM(
  agent: Agent,
  dagStep: DAGStep,
  intent: string,
  datetime?: DatetimeContext,
): FSMDefinition {
  const stateId = stateName(dagStep.id);
  const prompt = agent.bundledId
    ? intent // executor adds datetime + Task: framing
    : buildGroundedPrompt(intent, datetime);

  const action = agent.bundledId
    ? { type: "agent" as const, agentId: agent.bundledId, prompt, outputTo: "result" }
    : {
        type: "llm" as const,
        provider: DEFAULT_LLM_PROVIDER,
        model: DEFAULT_LLM_MODEL,
        prompt,
        tools: agent.mcpServers?.map((s) => s.serverId) ?? [],
        outputTo: "result",
      };

  return {
    id: `task-fastpath-${randomUUID().slice(0, 8)}`,
    initial: "idle",
    states: {
      idle: { on: { "adhoc-trigger": { target: stateId } } },
      [stateId]: {
        entry: [action, { type: "emit", event: "ADVANCE" }],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    },
  };
}
