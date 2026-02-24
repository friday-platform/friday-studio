/**
 * Stamps DAG steps with execution metadata after agent classification.
 *
 * Pure function — builds new objects, does not mutate inputs. Bridges the gap
 * between classification (which annotates Agent objects) and compilation
 * (which needs to know how each step executes).
 */

import type {
  ClassifiedDAGStep,
  Conditional,
  DocumentContract,
  PrepareMapping,
} from "@atlas/schemas/workspace";
import type { Agent, JobWithDAG } from "../types.ts";

/** JobWithDAG with steps promoted to ClassifiedDAGStep. */
export interface ClassifiedJobWithDAG {
  id: string;
  name: string;
  title: string;
  triggerSignalId: string;
  steps: ClassifiedDAGStep[];
  documentContracts: DocumentContract[];
  prepareMappings: PrepareMapping[];
  conditionals?: Conditional[];
}

/**
 * Stamp each DAG step with execution metadata based on its agent's classification.
 *
 * Two-field identity model:
 * - `agentId` — preserved as the planner-assigned ID, used for schema/mapping lookups
 * - `executionRef` — execution target (bundled registry key for bundled agents,
 *   same as agentId for LLM agents)
 *
 * Bundled agents: `executionType: "bundled"`, `executionRef` = `agent.bundledId`
 * LLM agents: `executionType: "llm"`, `executionRef` = `step.agentId`, `tools` from MCP servers
 *
 * @param jobs - Jobs with raw DAGStep arrays (from the dag generation phase)
 * @param agents - Classified agents (post-classifyAgents, with bundledId/mcpServers set)
 * @returns New job objects with ClassifiedDAGStep arrays
 */
export function stampExecutionTypes(jobs: JobWithDAG[], agents: Agent[]): ClassifiedJobWithDAG[] {
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  return jobs.map((job) => ({
    ...job,
    steps: job.steps.map((step): ClassifiedDAGStep => {
      const agent = agentMap.get(step.agentId);

      if (agent?.bundledId) {
        return { ...step, executionType: "bundled", executionRef: agent.bundledId };
      }

      const mcpServerIds = agent?.mcpServers?.map((s) => s.serverId);
      return {
        ...step,
        executionType: "llm",
        executionRef: step.agentId,
        ...(mcpServerIds && mcpServerIds.length > 0 ? { tools: mcpServerIds } : {}),
      };
    }),
  }));
}
