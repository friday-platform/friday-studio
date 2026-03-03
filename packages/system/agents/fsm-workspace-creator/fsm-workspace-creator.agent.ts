/**
 * FSM Workspace Creator Agent (v3.0 - Deterministic Compiler)
 *
 * Compiles FSM definitions from v2 WorkspaceBlueprint artifacts using the
 * deterministic compiler. No LLM calls, no retry loops. Same plan always
 * produces same FSM, every time.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { createLedgerClient } from "@atlas/resources";
import { stringifyError } from "@atlas/utils";
import {
  buildFSMFromPlan,
  buildWorkspaceYaml,
  ClassifiedDAGStepSchema,
  type CompileWarning,
  PipelineError,
  type WorkspaceBlueprint,
  WorkspaceBlueprintSchema,
} from "@atlas/workspace-builder";
import { toKebabCase } from "@std/text";
import { z } from "zod";
import type { FSMCreatorSuccessData } from "../../agent-types/mod.ts";
import { provisionResources } from "./provision-resources.ts";

const FSMCreatorInputSchema = z.object({
  artifactId: z.string().describe("WorkspacePlan artifact ID"),
  workspacePath: z
    .string()
    .optional()
    .describe("Path to workspace directory (default: current directory)"),
});

type FSMCreatorInput = z.infer<typeof FSMCreatorInputSchema>;

/**
 * FSM Workspace Creator Agent v3.0
 *
 * Deterministic compiler shell. Loads v2 blueprint, compiles FSMs, assembles
 * workspace.yml, registers with daemon. No LLM calls.
 */
export const fsmWorkspaceCreatorAgent = createAgent<FSMCreatorInput, FSMCreatorSuccessData>({
  id: "fsm-workspace-creator",
  displayName: "FSM Workspace Creator",
  version: "3.0.0",
  description:
    "Compiles FSM definitions from v2 workspace blueprints using deterministic compilation. " +
    "Creates workspace.yml with validated FSM definitions for each job. No LLM calls.",

  expertise: { examples: [] },

  inputSchema: FSMCreatorInputSchema,

  handler: async (input, { logger, stream, session }) => {
    logger.info("Starting deterministic FSM compilation", { artifactId: input.artifactId });

    try {
      // 1. Load v2 artifact
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Loading workspace blueprint" },
      });

      const blueprint = await loadBlueprint(input.artifactId);

      logger.info("Loaded workspace blueprint", {
        signals: blueprint.signals.length,
        agents: blueprint.agents.length,
        jobs: blueprint.jobs.length,
      });

      // 2. Compile FSMs — deterministic, no LLM
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Compiling FSM definitions" },
      });

      const fsms = [];
      for (const job of blueprint.jobs) {
        logger.info("Compiling FSM for job", { jobId: job.id });
        // Jobs carry classified steps at runtime (from stampExecutionTypes); parse to narrow the type
        const classifiedJob = {
          ...job,
          steps: job.steps.map((s) => ClassifiedDAGStepSchema.parse(s)),
        };
        const result = buildFSMFromPlan(classifiedJob);
        if (!result.success) {
          return err(`FSM compilation failed for job '${job.id}': ${JSON.stringify(result.error)}`);
        }

        // Compiler warnings are fatal — upstream gates should prevent them
        if (result.value.warnings.length > 0) {
          const warningMessages = result.value.warnings
            .map((w: CompileWarning) => `  ${w.type}: ${w.message}`)
            .join("\n");
          throw new PipelineError(
            "compile",
            new Error(`Compiler warnings for job '${job.id}':\n${warningMessages}`),
          );
        }

        logger.info("FSM compiled successfully", {
          jobId: job.id,
          fsmId: result.value.fsm.id,
          stateCount: Object.keys(result.value.fsm.states).length,
        });

        fsms.push(result.value.fsm);
      }

      logger.info("All FSMs compiled successfully", { count: fsms.length });

      // 3. Assemble workspace.yml — deterministic, no LLM
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Assembling workspace configuration" },
      });

      // Load dynamic MCP servers for assembly (agents may reference KV-registered servers)
      let dynamicServers: MCPServerMetadata[] | undefined;
      try {
        const adapter = await getMCPRegistryAdapter();
        dynamicServers = await adapter.list();
      } catch (error) {
        logger.warn("Failed to load dynamic MCP servers for assembly", {
          error: stringifyError(error),
        });
      }

      const workspaceYml = buildWorkspaceYaml(
        { workspace: blueprint.workspace, signals: blueprint.signals, agents: blueprint.agents },
        blueprint,
        fsms,
        blueprint.credentialBindings,
        dynamicServers,
      );

      // 4. Write to disk
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Saving workspace file" },
      });

      const workspaceName = toKebabCase(blueprint.workspace.name);
      const workspacePath = input.workspacePath || `./${workspaceName}`;
      await mkdir(workspacePath, { recursive: true });

      const ymlPath = `${workspacePath}/workspace.yml`;
      await writeFile(ymlPath, workspaceYml, "utf-8");

      // 5. Register workspace with daemon
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Registering workspace with daemon" },
      });

      const absoluteWorkspacePath = await Deno.realPath(workspacePath);
      const registrationResponse = await parseResult(
        client.workspace.add.$post({
          json: {
            path: absoluteWorkspacePath,
            name: blueprint.workspace.name,
            description: blueprint.workspace.purpose,
          },
        }),
      );

      if (!registrationResponse.ok) {
        logger.error("Failed to register workspace", {
          path: absoluteWorkspacePath,
          error: registrationResponse.error,
        });
        return err(
          `Workspace files created but registration failed: ${stringifyError(
            registrationResponse.error,
          )}`,
        );
      }

      // 6. Provision resources
      if (blueprint.resources && blueprint.resources.length > 0) {
        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "FSM Creator", content: "Provisioning workspace resources" },
        });

        const ledger = createLedgerClient();
        const provisionResult = await provisionResources(
          ledger,
          registrationResponse.data.id,
          session.userId ?? "system",
          blueprint.resources,
        );

        if (!provisionResult.ok) {
          logger.error("Resource provisioning failed", {
            workspaceId: registrationResponse.data.id,
            error: provisionResult.error,
          });
          return err(
            `Workspace registered but resource provisioning failed: ${provisionResult.error}`,
          );
        }

        logger.info("Resources provisioned", {
          workspaceId: registrationResponse.data.id,
          resourceCount: blueprint.resources.length,
        });
      }

      logger.info("Workspace compilation and registration complete", {
        workspacePath,
        workspaceId: registrationResponse.data.id,
        ymlPath,
        signals: blueprint.signals.length,
        jobCount: blueprint.jobs.length,
        totalStates: fsms.reduce((sum, fsm) => sum + Object.keys(fsm.states).length, 0),
      });

      return ok({
        workspaceId: registrationResponse.data.id,
        workspaceName: blueprint.workspace.name,
        workspaceDescription: blueprint.workspace.purpose,
        workspaceUrl: `/spaces/${registrationResponse.data.id}`,
        jobCount: blueprint.jobs.length,
        metadata: { generatedCode: {}, codegenAttempts: {} },
      });
    } catch (error) {
      if (error instanceof PipelineError) {
        logger.error("Pipeline error during FSM creation", {
          phase: error.phase,
          cause: error.cause?.message,
        });
        return err(`Compilation failed at "${error.phase}": ${error.cause?.message}`);
      }
      logger.error("FSM creation failed", { error: stringifyError(error) });
      return err(stringifyError(error));
    }
  },
});

/**
 * Load v2 workspace blueprint artifact from storage.
 * Returns error on v1 artifacts, telling user to re-plan.
 */
async function loadBlueprint(artifactId: string): Promise<WorkspaceBlueprint> {
  const response = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: artifactId } }),
  );

  if (!response.ok || response.data.artifact.type !== "workspace-plan") {
    throw new Error("Failed to load workspace plan artifact");
  }

  const artifactData = response.data.artifact.data;

  // Reject v1 artifacts — user must re-plan with the new planner
  if (artifactData.version === 1) {
    throw new Error(
      "This artifact uses the v1 plan format which is no longer supported by the workspace creator. " +
        "Please create a new workspace plan using the workspace planner.",
    );
  }

  if (artifactData.version !== 2) {
    throw new Error(
      `Unsupported workspace plan version: ${(artifactData as { version: unknown }).version}`,
    );
  }

  // Parse with Zod to validate structure
  const validationResult = WorkspaceBlueprintSchema.safeParse(artifactData.data);
  if (!validationResult.success) {
    throw new Error(`Invalid workspace blueprint data: ${validationResult.error.message}`);
  }

  return validationResult.data;
}
