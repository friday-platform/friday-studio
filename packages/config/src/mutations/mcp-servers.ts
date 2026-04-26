/**
 * MCP server mutation functions for workspace configuration partial updates.
 *
 * Pure functions that transform WorkspaceConfig to enable or disable MCP servers,
 * with reference-safety guards for LLM agent tool arrays.
 */

import type { MCPServerConfig } from "@atlas/agent-sdk";
import { produce } from "immer";
import { JobSpecificationSchema } from "../jobs.ts";
import type { WorkspaceConfig } from "../workspace.ts";
import { parseFSMDefinition } from "./fsm-types.ts";
import {
  type AgentCascadeTarget,
  conflictError,
  type DeleteOptions,
  type JobCascadeTarget,
  type MutationResult,
  notFoundError,
} from "./types.ts";

// ==============================================================================
// TYPES
// ==============================================================================

/** References to a given MCP server found in workspace configuration. */
export interface ServerReference {
  agentIds: string[];
  jobIds: string[];
}

// ==============================================================================
// REFERENCE WALKER
// ==============================================================================

/**
 * Find all workspace agents and FSM job steps that reference a given MCP server.
 *
 * Walks:
 * 1. Top-level LLM agents (`config.agents` with `type === "llm"`), checking
 *    their `config.tools` arrays.
 * 2. FSM job actions (`config.jobs[].fsm.states[].entry[]` with `type === "llm"`),
 *    checking their `tools` arrays.
 *
 * @param config - Workspace configuration to search
 * @param serverId - MCP server identifier to look for
 * @returns Agent and job IDs that reference the server
 */
export function findServerReferences(config: WorkspaceConfig, serverId: string): ServerReference {
  const agentIdSet = new Set<string>();
  const jobIdSet = new Set<string>();

  // 1. Top-level LLM agents
  if (config.agents) {
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.type !== "llm") continue;
      const tools = agentConfig.config.tools;
      if (tools && tools.includes(serverId)) {
        agentIdSet.add(agentId);
      }
    }
  }

  // 2. FSM job actions
  if (config.jobs) {
    for (const [jobId, rawJob] of Object.entries(config.jobs)) {
      const job = JobSpecificationSchema.safeParse(rawJob);
      if (!job.success) continue;
      if (!job.data.fsm) continue;

      const parsed = parseFSMDefinition(job.data.fsm);
      if (!parsed.success) continue;
      const fsm = parsed.data;
      if (!fsm.states) continue;

      for (const [, state] of Object.entries(fsm.states)) {
        if (!state.entry) continue;

        for (const action of state.entry) {
          if (action?.type === "llm") {
            const tools = action.tools;
            if (Array.isArray(tools) && tools.includes(serverId)) {
              jobIdSet.add(jobId);
              break; // deduplicate per job
            }
          }
        }
      }
    }
  }

  return { agentIds: Array.from(agentIdSet), jobIds: Array.from(jobIdSet) };
}

// ==============================================================================
// ENABLE MUTATION
// ==============================================================================

/**
 * Enable an MCP server in the workspace configuration.
 *
 * Idempotent: if the server is already present, returns `ok: true` with the
 * unchanged config. Otherwise adds the server under `tools.mcp.servers` with
 * the provided `configTemplate`.
 *
 * @param config - Current workspace configuration
 * @param serverId - MCP server identifier
 * @param configTemplate - Server configuration to add
 * @returns MutationResult with updated config
 */
export function enableMCPServer(
  config: WorkspaceConfig,
  serverId: string,
  configTemplate: MCPServerConfig,
): MutationResult<WorkspaceConfig> {
  const existingServers = config.tools?.mcp?.servers ?? {};

  if (serverId in existingServers) {
    return { ok: true, value: config };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      draft.tools ??= {};
      draft.tools.mcp ??= {
        client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
      };
      draft.tools.mcp.servers ??= {};
      (draft.tools.mcp.servers as Record<string, unknown>)[serverId] = configTemplate as Record<
        string,
        unknown
      >;
    }),
  };
}

// ==============================================================================
// DISABLE MUTATION
// ==============================================================================

/**
 * Disable an MCP server in the workspace configuration.
 *
 * Without `force`: returns a `conflict` error if any LLM agents or FSM job
 * steps still reference the server, with affected IDs in `willUnlinkFrom`.
 * With `force`: removes the server and strips all references from agent and
 * job step `tools` arrays.
 *
 * @param config - Current workspace configuration
 * @param serverId - MCP server identifier to disable
 * @param options - Delete options (`force` for cascade)
 * @returns MutationResult with updated config or error
 */
export function disableMCPServer(
  config: WorkspaceConfig,
  serverId: string,
  options?: DeleteOptions,
): MutationResult<WorkspaceConfig> {
  const existingServers = config.tools?.mcp?.servers ?? {};

  if (!(serverId in existingServers)) {
    return { ok: false, error: notFoundError(serverId, "mcp server") };
  }

  const refs = findServerReferences(config, serverId);

  if ((refs.agentIds.length > 0 || refs.jobIds.length > 0) && !options?.force) {
    const willUnlinkFrom: Array<AgentCascadeTarget | JobCascadeTarget> = [];

    for (const agentId of refs.agentIds) {
      willUnlinkFrom.push({ type: "agent", agentId });
    }

    for (const jobId of refs.jobIds) {
      willUnlinkFrom.push({ type: "job", jobId, remainingTriggers: 0 });
    }

    return { ok: false, error: conflictError(willUnlinkFrom) };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      // Remove server from tools.mcp.servers
      delete draft.tools?.mcp?.servers?.[serverId];

      // Cascade: strip references from top-level LLM agents
      if (refs.agentIds.length > 0 && draft.agents) {
        for (const agent of Object.values(draft.agents)) {
          if (agent.type === "llm" && agent.config.tools) {
            agent.config.tools = agent.config.tools.filter((t: string) => t !== serverId);
          }
        }
      }

      // Cascade: strip references from FSM job actions
      if (refs.jobIds.length > 0 && draft.jobs) {
        for (const rawJob of Object.values(draft.jobs)) {
          if (!rawJob || typeof rawJob !== "object") continue;

          const fsm = (rawJob as Record<string, unknown>).fsm;
          if (!fsm || typeof fsm !== "object") continue;

          const states = (fsm as Record<string, unknown>).states;
          if (!states || typeof states !== "object") continue;

          for (const state of Object.values(states)) {
            if (!state || typeof state !== "object") continue;

            const entry = (state as Record<string, unknown>).entry;
            if (!Array.isArray(entry)) continue;

            for (const action of entry) {
              if (
                action &&
                typeof action === "object" &&
                (action as Record<string, unknown>).type === "llm"
              ) {
                const tools = (action as Record<string, unknown>).tools;
                if (Array.isArray(tools)) {
                  (action as Record<string, unknown>).tools = tools.filter(
                    (t: unknown) => t !== serverId,
                  );
                }
              }
            }
          }
        }
      }
    }),
  };
}
