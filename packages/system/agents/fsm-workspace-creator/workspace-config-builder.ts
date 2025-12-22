/**
 * Builds workspace.yml configuration from plan and FSM
 */

import type {
  JobSpecification,
  ToolsConfig,
  WorkspaceConfig,
  WorkspaceIdentity,
  WorkspaceSignalConfig,
} from "@atlas/config";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import type { ValidatedFSMDefinition } from "@atlas/fsm-engine";
import type { MCPServerResult } from "./enrichers/mcp-servers.ts";

/**
 * Build complete workspace configuration
 * Supports multiple FSMs (one per job)
 */
export function buildWorkspaceConfig(
  plan: WorkspacePlan,
  signals: Array<{ id: string; config: WorkspaceSignalConfig }>,
  mcpServers: MCPServerResult[],
  fsms: Map<string, ValidatedFSMDefinition>,
): WorkspaceConfig {
  const tools = buildToolsSection(mcpServers);

  const config: WorkspaceConfig = {
    version: "1.0",
    workspace: buildWorkspaceSection(plan),
    signals: buildSignalsSection(signals),
    jobs: buildJobsSection(plan, fsms),
  };

  if (tools) {
    config.tools = tools;
  }

  return config;
}

/**
 * Build workspace metadata section
 */
function buildWorkspaceSection(plan: WorkspacePlan): WorkspaceIdentity {
  return {
    name: plan.workspace.name,
    description: plan.workspace.purpose,
    timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" },
  };
}

/**
 * Build signals configuration section
 */
function buildSignalsSection(
  signals: Array<{ id: string; config: WorkspaceSignalConfig }>,
): Record<string, WorkspaceSignalConfig> {
  return Object.fromEntries(signals.map((s) => [s.id, s.config]));
}

/**
 * Build jobs section with FSM definitions (one FSM per job)
 */
function buildJobsSection(
  plan: WorkspacePlan,
  fsms: Map<string, ValidatedFSMDefinition>,
): Record<string, JobSpecification> {
  const jobs: Record<string, JobSpecification> = {};

  for (const job of plan.jobs) {
    const fsm = fsms.get(job.id);
    if (!fsm) {
      throw new Error(`No FSM generated for job: ${job.id}`);
    }

    jobs[job.id] = {
      name: job.id.replace(/-/g, "_"),
      description: `${job.name} - ${job.steps.map((s) => s.description).join(", ")}`,
      triggers: [{ signal: job.triggerSignalId }],
      fsm,
    };
  }

  return jobs;
}

/**
 * Build MCP tools section
 */
function buildToolsSection(mcpServers: MCPServerResult[]): ToolsConfig | undefined {
  if (mcpServers.length === 0) return undefined;

  return {
    mcp: {
      client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
      servers: Object.fromEntries(mcpServers.map((s) => [s.id, s.config])),
    },
  };
}
