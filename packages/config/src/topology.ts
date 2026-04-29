/**
 * Derives a renderable topology (nodes + edges) from workspace configuration.
 *
 * Pure function — no side effects. The pipeline diagram component renders this output.
 */

import { JobSpecificationSchema } from "./jobs.ts";
import { extractFSMAgents, type FSMAgentResponse } from "./mutations/fsm-agents.ts";
import { parseInlineFSM } from "./mutations/fsm-types.ts";
import type { WorkspaceConfig } from "./workspace.ts";

// ==============================================================================
// TYPES
// ==============================================================================

type TopologyNodeType = "signal" | "agent-step" | "terminal";

export interface TopologyNode {
  id: string;
  type: TopologyNodeType;
  jobId?: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface TopologyEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  unsupportedJobs?: string[];
}

// ==============================================================================
// DERIVATION
// ==============================================================================

/**
 * Derives a renderable topology from workspace configuration.
 *
 * Converts signals into entry-point nodes, FSM states into agent-step/terminal
 * nodes, and FSM transitions into edges. Execution-mode jobs are excluded and
 * flagged in `unsupportedJobs`.
 *
 * @param config - Workspace configuration to derive topology from
 * @returns Topology with nodes, edges, and unsupported job flags
 */
export function deriveTopology(config: WorkspaceConfig): Topology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const unsupportedJobs: string[] = [];

  // Extract FSM agent metadata for enriching agent-step nodes
  const fsmAgents = extractFSMAgents(config);

  // Build signal → job mapping from triggers
  const signalToJobs = new Map<string, string[]>();
  if (config.jobs) {
    for (const [jobId, rawJob] of Object.entries(config.jobs)) {
      const job = JobSpecificationSchema.safeParse(rawJob);
      if (!job.success) continue;
      for (const trigger of job.data.triggers ?? []) {
        const existing = signalToJobs.get(trigger.signal) ?? [];
        existing.push(jobId);
        signalToJobs.set(trigger.signal, existing);
      }
    }
  }

  // Build signal nodes with job associations
  if (config.signals) {
    for (const [signalId, signal] of Object.entries(config.signals)) {
      nodes.push({
        id: `signal:${signalId}`,
        type: "signal",
        label: signalId,
        metadata: {
          provider: signal.provider,
          jobIds: signalToJobs.get(signalId) ?? [],
          ...(signal.title ? { title: signal.title } : {}),
          ...(signal.description ? { description: signal.description } : {}),
        },
      });
    }
  }

  // Build job topologies
  if (config.jobs) {
    for (const [jobId, rawJob] of Object.entries(config.jobs)) {
      const job = JobSpecificationSchema.safeParse(rawJob);
      if (!job.success) continue;

      // Execution-mode jobs are unsupported for topology
      if (job.data.execution) {
        unsupportedJobs.push(jobId);
        continue;
      }

      if (!job.data.fsm) continue;

      const parsed = parseInlineFSM(job.data.fsm, jobId);
      if (!parsed.success) continue;
      const fsm = parsed.data;

      // Build nodes for each FSM state
      for (const [stateId, state] of Object.entries(fsm.states)) {
        const nodeId = `${jobId}:${stateId}`;

        if (state.type === "final") {
          nodes.push({ id: nodeId, type: "terminal", jobId, label: stateId, metadata: {} });
        } else {
          // Check if this state has an agent/llm action
          const agentKey = `${jobId}:${stateId}`;
          const agentMeta = fsmAgents[agentKey];

          if (agentMeta) {
            nodes.push({
              id: nodeId,
              type: "agent-step",
              jobId,
              label: stateId,
              metadata: buildAgentMetadata(agentMeta),
            });
          } else {
            // State without agent action (e.g., idle state with only code actions)
            nodes.push({ id: nodeId, type: "agent-step", jobId, label: stateId, metadata: {} });
          }
        }

        // Build edges from transition definitions
        if (state.on) {
          for (const [event, transition] of Object.entries(state.on)) {
            const transitions = Array.isArray(transition) ? transition : [transition];
            for (const t of transitions) {
              edges.push({ from: nodeId, to: `${jobId}:${t.target}`, label: event });
            }
          }
        }
      }
    }
  }

  return { nodes, edges, ...(unsupportedJobs.length > 0 ? { unsupportedJobs } : {}) };
}

/**
 * Builds metadata record from FSM agent response for topology node enrichment.
 */
function buildAgentMetadata(agent: FSMAgentResponse): Record<string, unknown> {
  const meta: Record<string, unknown> = { type: agent.type };

  if (agent.type === "agent") {
    if (agent.agentId) meta.agentId = agent.agentId;
    if (agent.prompt) meta.prompt = agent.prompt;
    if (agent.outputTo) meta.outputTo = agent.outputTo;
  } else {
    if (agent.provider) meta.provider = agent.provider;
    if (agent.model) meta.model = agent.model;
    if (agent.prompt) meta.prompt = agent.prompt;
    if (agent.tools) meta.tools = agent.tools;
    if (agent.outputTo) meta.outputTo = agent.outputTo;
    if (agent.outputType) meta.outputType = agent.outputType;
  }

  return meta;
}
