import { createAgent } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { WorkspaceConfig } from "@atlas/config";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { z } from "zod";
import { enrichAgentsWithDomains } from "./enrichers/agents.ts";
import { enrichJob } from "./enrichers/jobs.ts";
import { generateMCPServers } from "./enrichers/mcp-servers.ts";
import { enrichSignal } from "./enrichers/signals.ts";
import type { WorkspaceSummary } from "./types.ts";

type WorkspaceResult = Result<
  {
    workspaceName: string;
    workspacePath?: string;
    config: WorkspaceConfig;
    summary: WorkspaceSummary;
  },
  { reason: string }
>;

const WorkspaceCreationInputSchema = z.object({
  artifactId: z.string().describe("Workspace plan artifact ID to build from"),
  ephemeral: z.boolean().optional().describe("When true, create an ephemeral instance for testing"),
});

type WorkspaceCreationInput = z.infer<typeof WorkspaceCreationInputSchema>;

/**
 * Converts workspace plan artifacts into WorkspaceConfig via LLM enrichment.
 *
 * Flow: load plan artifact → enrich signals/agents/jobs in parallel →
 * generate MCP servers → construct config → create workspace via API
 */
export const workspaceCreationAgent = createAgent<WorkspaceCreationInput, WorkspaceResult>({
  id: "workspace-creation",
  displayName: "Workspace Creation Agent",
  version: "2.0.0",
  description:
    "Call ONLY after user approves a workspace plan. Requires artifactId from workspace-planner. Transforms plan artifact into executable workspace configuration.",

  expertise: { domains: ["Atlas workspaces"], examples: [] },

  inputSchema: WorkspaceCreationInputSchema,

  handler: async (input, { logger, stream, abortSignal }) => {
    logger.info("Starting workspace generation from plan", { artifactId: input.artifactId });

    try {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Creator", content: "Loading plan" },
      });

      const response = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: input.artifactId } }),
      );

      if (!response.ok) {
        throw new Error(`Failed to load workspace plan: ${JSON.stringify(response.error)}`);
      }

      if (response.data.artifact.type !== "workspace-plan") {
        throw new Error(
          `Artifact ${input.artifactId} is not a workspace-plan (got ${response.data.artifact.type})`,
        );
      }

      const artifactData = response.data.artifact.data;
      if (artifactData.type !== "workspace-plan") {
        throw new Error(
          `Artifact data type mismatch: expected workspace-plan, got ${artifactData.type}`,
        );
      }

      const plan: WorkspacePlan = artifactData.data;
      logger.info("Loaded workspace plan", {
        signals: plan.signals.length,
        agents: plan.agents.length,
        jobs: plan.jobs.length,
      });

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Creator", content: "Enriching components" },
      });

      // Enrich components in parallel (all async)
      const [{ enrichedAgents, mcpDomains }, enrichedSignals, enrichedJobs] = await Promise.all([
        enrichAgentsWithDomains(plan.agents),
        Promise.all(plan.signals.map((s) => enrichSignal(s, abortSignal))),
        Promise.all(plan.jobs.map((j) => enrichJob(j, abortSignal))),
      ]);

      logger.info("Component enrichment complete", {
        signals: enrichedSignals.length,
        agents: enrichedAgents.length,
        jobs: enrichedJobs.length,
        mcpDomains: mcpDomains.length,
      });

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Creator", content: "Adding MCP servers" },
      });

      const mcpServers = generateMCPServers(mcpDomains);

      logger.info("MCP server generation complete", { count: mcpServers.length });

      const config: WorkspaceConfig = {
        version: "1.0",
        workspace: { name: plan.workspace.name, description: plan.workspace.purpose },
        signals: Object.fromEntries(enrichedSignals.map((s) => [s.id, s.config])),
        agents: Object.fromEntries(enrichedAgents.map((a) => [a.id, a.config])),
        jobs: Object.fromEntries(enrichedJobs.map((j) => [j.id, j.spec])),
        tools:
          mcpServers.length > 0
            ? {
                mcp: {
                  client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "300s" } },
                  servers: Object.fromEntries(mcpServers.map((s) => [s.id, s.config])),
                },
              }
            : undefined,
      };

      logger.info("Constructed workspace config", {
        signalCount: enrichedSignals.length,
        agentCount: enrichedAgents.length,
        jobCount: enrichedJobs.length,
        mcpServerCount: mcpServers.length,
      });

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Creator", content: "Creating workspace" },
      });

      const createResponse = await parseResult(
        client.workspace.create.$post({
          json: {
            config,
            workspaceName: config.workspace.name,
            ephemeral: input.ephemeral === true,
          },
        }),
      );

      if (!createResponse.ok) {
        throw new Error(`API error (${stringifyError(createResponse.error)})`);
      }

      const responseData = createResponse.data;
      if (!responseData) {
        throw new Error("API returned no data");
      }

      const summary: WorkspaceSummary = {
        signalCount: enrichedSignals.length,
        signalTypes: [...new Set(enrichedSignals.map((s) => s.config.provider))],
        signalIds: enrichedSignals.map((s) => s.id),
        agentCount: enrichedAgents.length,
        agentTypes: [...new Set(enrichedAgents.map((a) => a.config.type))],
        agentIds: enrichedAgents.map((a) => a.id),
        jobCount: enrichedJobs.length,
        jobIds: enrichedJobs.map((j) => j.id),
        mcpServerCount: mcpServers.length,
        mcpServerIds: mcpServers.map((s) => s.id),
      };

      logger.info("Workspace created successfully", {
        name: config.workspace.name,
        path: responseData.workspacePath,
      });

      return success({
        workspaceName: config.workspace.name,
        workspacePath: responseData.workspacePath,
        config,
        summary,
      });
    } catch (error) {
      logger.error("Failed to create workspace", { error });
      return fail({ reason: stringifyError(error) });
    }
  },
});
