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
  compileBlueprint,
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

      const { blueprint, revision } = await loadBlueprint(input.artifactId);

      logger.info("Loaded workspace blueprint", {
        signals: blueprint.signals.length,
        agents: blueprint.agents.length,
        jobs: blueprint.jobs.length,
        revision,
      });

      // 2-3. Compile blueprint → YAML (pure function)
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Compiling FSM definitions" },
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

      const compiled = compileBlueprint(blueprint, dynamicServers);
      if (!compiled.ok) {
        return err(compiled.error);
      }

      const workspaceYml = compiled.yaml;

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

      // 6. Update workspace metadata with blueprint tracking
      const metadataResponse = await parseResult(
        client.workspace[":workspaceId"].metadata.$patch({
          param: { workspaceId: registrationResponse.data.id },
          json: { blueprintArtifactId: input.artifactId, blueprintRevision: revision },
        }),
      );

      if (!metadataResponse.ok) {
        logger.warn("Failed to update workspace metadata with blueprint info", {
          workspaceId: registrationResponse.data.id,
          error: stringifyError(metadataResponse.error),
        });
      }

      // 7. Provision resources
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
      logger.error("FSM creation failed", { error: stringifyError(error) });
      return err(stringifyError(error));
    }
  },
});

/**
 * Load workspace blueprint from artifact storage (stored as a JSON file artifact).
 */
async function loadBlueprint(
  artifactId: string,
): Promise<{ blueprint: WorkspaceBlueprint; revision: number }> {
  const response = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: artifactId } }),
  );

  if (!response.ok) {
    throw new Error("Failed to load workspace blueprint artifact");
  }

  const { revision } = response.data.artifact;
  const contents = response.data.contents;

  if (!contents) {
    throw new Error("Blueprint artifact has no file contents");
  }

  const validationResult = WorkspaceBlueprintSchema.safeParse(JSON.parse(contents));
  if (!validationResult.success) {
    throw new Error(`Invalid workspace blueprint data: ${validationResult.error.message}`);
  }

  return { blueprint: validationResult.data, revision };
}
