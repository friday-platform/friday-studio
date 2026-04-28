/** workspace.yml Assembler — no LLM calls, no side effects, no I/O. */

import type { MCPServerConfig, WorkspaceAgentConfig, WorkspaceConfig } from "@atlas/config";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { stringify } from "@std/yaml";
import type {
  Agent,
  CompiledFSMDefinition,
  CredentialBinding,
  Signal,
  WorkspaceBlueprint,
} from "../types.ts";

export interface Phase1Output {
  workspace: { name: string; purpose: string };
  signals: Signal[];
  agents: Agent[];
}

/**
 * Builds a valid workspace.yml string from planner phase outputs.
 *
 * @param phase1 - Phase 1 output with workspace identity, enriched signals, classified agents
 * @param phase3 - Phase 3 output with jobs, steps, contracts, mappings
 * @param fsms - Compiled FSM definitions (one per job)
 * @param bindings - Optional credential bindings to inject into MCP server and agent env blocks
 * @param dynamicServers - Optional runtime-registered MCP servers from KV (not in the static registry)
 * @returns YAML string that passes WorkspaceConfigSchema validation
 */
export function buildWorkspaceYaml(
  phase1: Phase1Output,
  phase3: WorkspaceBlueprint,
  fsms: CompiledFSMDefinition[],
  bindings?: CredentialBinding[],
  dynamicServers?: MCPServerMetadata[],
): string {
  const fsmByJobId = new Map(fsms.map((f) => [f.id, f]));

  const mcpServerConfigs = buildMCPServers(phase1.agents, bindings, dynamicServers);

  const config: WorkspaceConfig = {
    version: "1.0",
    workspace: { name: phase1.workspace.name, description: phase1.workspace.purpose },
    ...(Object.keys(mcpServerConfigs).length > 0 && {
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: mcpServerConfigs,
        },
      },
    }),
    signals: buildSignals(phase1.signals),
    agents: buildAgents(phase1.agents, bindings),
    jobs: buildJobs(phase3, fsmByJobId),
    ...(phase3.resources && phase3.resources.length > 0 && { resources: phase3.resources }),
  };

  return stringify(config as Record<string, unknown>, { lineWidth: -1 });
}

function buildSignals(signals: Signal[]): NonNullable<WorkspaceConfig["signals"]> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const signal of signals) {
    if (!signal.signalConfig) {
      throw new Error(`Signal "${signal.id}" missing signalConfig — run signal enrichment first`);
    }

    const entry: Record<string, unknown> = {
      description: signal.description,
      provider: signal.signalConfig.provider,
      config: signal.signalConfig.config,
    };
    if (signal.title) entry.title = signal.title;
    if (signal.payloadSchema) entry.schema = signal.payloadSchema;

    result[signal.id] = entry;
  }

  return result as NonNullable<WorkspaceConfig["signals"]>;
}

function buildMCPServers(
  agents: Agent[],
  bindings?: CredentialBinding[],
  dynamicServers?: MCPServerMetadata[],
): Record<string, MCPServerConfig> {
  const result: Record<string, MCPServerConfig> = {};

  const dynamicById = new Map<string, MCPServerMetadata>();
  for (const server of dynamicServers ?? []) {
    dynamicById.set(server.id, server);
  }

  for (const agent of agents) {
    if (!agent.mcpServers) continue;
    for (const { serverId } of agent.mcpServers) {
      if (result[serverId]) continue;
      const serverMeta = mcpServersRegistry.servers[serverId] ?? dynamicById.get(serverId);
      if (!serverMeta) {
        throw new Error(`MCP server "${serverId}" not found in registry`);
      }
      const config = structuredClone(serverMeta.configTemplate);
      applyMCPBindings(config, serverId, bindings);
      result[serverId] = config;
    }
  }

  return result;
}

/**
 * Replaces template env entries with resolved Link credential refs.
 * Mutates the config in place (caller passes a structuredClone).
 */
function applyMCPBindings(
  config: MCPServerConfig,
  serverId: string,
  bindings?: CredentialBinding[],
): void {
  if (!bindings || !config.env) return;
  for (const binding of bindings) {
    if (binding.targetType !== "mcp" || binding.targetId !== serverId) continue;
    config.env[binding.field] = {
      from: "link" as const,
      id: binding.credentialId,
      provider: binding.provider,
      key: binding.key,
    };
  }
}

function buildAgents(
  agents: Agent[],
  bindings?: CredentialBinding[],
): Record<string, WorkspaceAgentConfig> {
  const result: Record<string, WorkspaceAgentConfig> = {};

  for (const agent of agents) {
    if (agent.bundledId) {
      const env = buildAgentEnv(agent.id, bindings);
      result[agent.id] = {
        type: "atlas",
        agent: agent.bundledId,
        description: agent.description,
        prompt: `You are ${agent.name}. ${agent.description}`,
        ...(env && { env }),
      };
    } else {
      result[agent.id] = {
        type: "llm",
        description: agent.description,
        config: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          prompt: `You are ${agent.name}. ${agent.description}`,
          temperature: 0.3,
          ...(agent.mcpServers?.length && { tools: agent.mcpServers.map((s) => s.serverId) }),
        },
      };
    }
  }

  return result;
}

function buildAgentEnv(
  agentId: string,
  bindings?: CredentialBinding[],
): Record<string, { from: "link"; id: string; provider: string; key: string }> | undefined {
  if (!bindings) return undefined;
  const agentBindings = bindings.filter((b) => b.targetType === "agent" && b.targetId === agentId);
  if (agentBindings.length === 0) return undefined;

  const env: Record<string, { from: "link"; id: string; provider: string; key: string }> = {};
  for (const binding of agentBindings) {
    env[binding.field] = {
      from: "link" as const,
      id: binding.credentialId,
      provider: binding.provider,
      key: binding.key,
    };
  }
  return env;
}

function buildJobs(
  phase3: WorkspaceBlueprint,
  fsmByJobId: Map<string, CompiledFSMDefinition>,
): NonNullable<WorkspaceConfig["jobs"]> {
  const result: Record<string, NonNullable<WorkspaceConfig["jobs"]>[string]> = {};

  for (const job of phase3.jobs) {
    const fsm = fsmByJobId.get(job.id);
    if (!fsm) {
      throw new Error(`No FSM definition found for job "${job.id}"`);
    }

    result[job.id] = {
      description: `${job.title}: ${job.name}`,
      title: job.title,
      triggers: [{ signal: job.triggerSignalId }],
      fsm,
    };
  }

  return result;
}
