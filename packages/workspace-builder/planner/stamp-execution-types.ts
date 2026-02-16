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
 * Stamp each DAG step with `executionType` and `tools` based on its agent's
 * classification. Bundled agents get `executionType: "bundled"` with their
 * `agentId` resolved to the registered bundled ID. LLM agents get
 * `executionType: "llm"` with tools populated from MCP server IDs.
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
        return { ...step, agentId: agent.bundledId, executionType: "bundled" };
      }

      const mcpServerIds = agent?.mcpServers?.map((s) => s.serverId);
      return {
        ...step,
        executionType: "llm",
        ...(mcpServerIds && mcpServerIds.length > 0 ? { tools: mcpServerIds } : {}),
      };
    }),
  }));
}
