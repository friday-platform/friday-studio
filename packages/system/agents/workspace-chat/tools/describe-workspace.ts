/**
 * `describe_workspace` — fetch workspace inventory or a specific scope on
 * demand. Replaces the auto-injected `<workspace>` XML block as a
 * pull-style retrieval tool.
 *
 * Scopes:
 *   - `inventory` (default): names + counts. Cheap, the default for
 *     "what's in this workspace?" questions.
 *   - `agents` / `jobs` / `signals` / `mcp_servers`: full per-entity list.
 *   - `full`: name + description + all four entity types.
 *
 * Provenance: `system-config` — workspace YAML is internal authoritative
 * state.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { envelope, type ReadResponse } from "./envelope.ts";

const ScopeSchema = z
  .enum(["inventory", "agents", "jobs", "signals", "mcp_servers", "full"])
  .default("inventory");

const DescribeWorkspaceInput = z.object({
  scope: ScopeSchema.optional().describe(
    "What to fetch. `inventory` (default) = names + counts only. `agents` / `jobs` / `signals` / `mcp_servers` = full per-entity list. `full` = name + description + all four lists.",
  ),
});

export interface WorkspaceInventory {
  id: string;
  name: string;
  description?: string;
  agentCount: number;
  jobCount: number;
  signalCount: number;
  mcpServerCount: number;
  agentNames: string[];
  jobNames: string[];
  signalNames: string[];
  mcpServerIds: string[];
}

export interface WorkspaceAgent {
  id: string;
  type?: string;
  description?: string;
}

export interface WorkspaceJob {
  id: string;
  name: string;
  description?: string;
}

export interface WorkspaceSignal {
  name: string;
  provider?: string;
}

export interface WorkspaceMcpServer {
  id: string;
}

export type DescribeWorkspaceItem =
  | WorkspaceInventory
  | WorkspaceAgent
  | WorkspaceJob
  | WorkspaceSignal
  | WorkspaceMcpServer
  | { name: string; description?: string; full: WorkspaceInventory };

const AgentSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
});

const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

const SignalSchema = z.object({ name: z.string(), provider: z.string().optional() });

export function createDescribeWorkspaceTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_workspace: tool({
      description:
        "Describe the current workspace's structure. Returns names + counts " +
        "by default (`scope: 'inventory'`); pass a more specific scope to " +
        "fetch full per-entity details (agents / jobs / signals / mcp_servers / full). " +
        "Use this instead of guessing what jobs or signals exist.",
      inputSchema: DescribeWorkspaceInput,
      execute: async ({ scope = "inventory" }): Promise<ReadResponse<DescribeWorkspaceItem>> => {
        const origin = `workspace:${workspaceId}`;
        const [wsResult, agentsResult, jobsResult, signalsResult, configResult] = await Promise.all(
          [
            parseResult(client.workspace[":workspaceId"].$get({ param: { workspaceId } })),
            parseResult(client.workspace[":workspaceId"].agents.$get({ param: { workspaceId } })),
            parseResult(client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } })),
            parseResult(client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } })),
            parseResult(client.workspace[":workspaceId"].config.$get({ param: { workspaceId } })),
          ],
        );

        if (!wsResult.ok) {
          logger.warn("describe_workspace: failed to fetch workspace", {
            workspaceId,
            error: wsResult.error,
          });
        }
        const name = wsResult.ok ? (wsResult.data.name ?? workspaceId) : workspaceId;
        const description = wsResult.ok ? wsResult.data.description : undefined;

        const agents: WorkspaceAgent[] = [];
        if (agentsResult.ok && Array.isArray(agentsResult.data)) {
          for (const a of agentsResult.data) {
            const parsed = AgentSchema.safeParse(a);
            if (parsed.success) agents.push(parsed.data);
          }
        }

        const jobs: WorkspaceJob[] = [];
        if (jobsResult.ok && Array.isArray(jobsResult.data)) {
          for (const j of jobsResult.data) {
            const parsed = JobSchema.safeParse(j);
            if (parsed.success) jobs.push(parsed.data);
          }
        }

        const signals: WorkspaceSignal[] = [];
        if (signalsResult.ok) {
          const parsed = z.object({ signals: z.array(SignalSchema) }).safeParse(signalsResult.data);
          if (parsed.success) signals.push(...parsed.data.signals);
        }

        // mcp_servers come from the config response (top-level list of ids).
        const mcpServerIds: string[] = [];
        if (configResult.ok) {
          const cfg = (configResult.data as { config?: { workspace?: { mcp_servers?: unknown } } })
            .config;
          const list = cfg?.workspace?.mcp_servers;
          if (Array.isArray(list)) {
            for (const entry of list) {
              if (typeof entry === "string") mcpServerIds.push(entry);
              else if (typeof entry === "object" && entry !== null && "id" in entry) {
                const id = (entry as { id?: unknown }).id;
                if (typeof id === "string") mcpServerIds.push(id);
              }
            }
          }
        }

        const inventory: WorkspaceInventory = {
          id: workspaceId,
          name,
          description,
          agentCount: agents.length,
          jobCount: jobs.length,
          signalCount: signals.length,
          mcpServerCount: mcpServerIds.length,
          agentNames: agents.map((a) => a.id),
          jobNames: jobs.map((j) => j.id),
          signalNames: signals.map((s) => s.name),
          mcpServerIds,
        };

        let items: DescribeWorkspaceItem[];
        switch (scope) {
          case "inventory":
            items = [inventory];
            break;
          case "agents":
            items = agents;
            break;
          case "jobs":
            items = jobs;
            break;
          case "signals":
            items = signals;
            break;
          case "mcp_servers":
            items = mcpServerIds.map((id) => ({ id }));
            break;
          case "full":
            items = [{ name, description, full: inventory }];
            break;
        }

        return envelope({ items, source: "system-config", origin });
      },
    }),
  };
}
