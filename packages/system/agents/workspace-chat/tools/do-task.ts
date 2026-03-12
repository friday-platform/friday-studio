/**
 * Workspace-scoped do_task tool.
 *
 * Thin wrapper around createDoTaskTool that enriches planning context
 * with workspace agents and MCP servers for priority-aware task planning.
 */

import type { WorkspaceConfig } from "@atlas/config";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import {
  createDoTaskTool,
  type DoTaskWorkspaceContext,
} from "../../conversation/tools/do-task/index.ts";

interface DoTaskSession {
  sessionId: string;
  workspaceId: string;
  streamId: string;
  userId?: string;
  daemonUrl?: string;
  datetime?: {
    timezone: string;
    timestamp: string;
    localDate: string;
    localTime: string;
    timezoneOffset: string;
  };
  resourceAdapter?: ResourceStorageAdapter;
  artifactStorage?: ArtifactStorageAdapter;
}

export function createWorkspaceDoTask(
  workspaceConfig: WorkspaceConfig,
  writer: UIMessageStreamWriter,
  session: DoTaskSession,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  const workspaceAgents: DoTaskWorkspaceContext["workspaceAgents"] = Object.entries(
    workspaceConfig.agents ?? {},
  ).map(([id, agent]) => ({ id, description: agent.description, type: agent.type }));

  const workspaceContext: DoTaskWorkspaceContext = { workspaceAgents };

  return createDoTaskTool(writer, session, logger, abortSignal, workspaceContext);
}
