import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { join } from "@std/path";
import { stringify } from "@std/yaml";
import { WorkspaceConfigSchema } from "@atlas/config";
import {
  errorResponseSchema,
  updateWorkspaceResponseSchema,
  updateWorkspaceSchema,
  workspaceIdParamSchema,
} from "./schemas.ts";

const updateWorkspace = daemonFactory.createApp();

updateWorkspace.post(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Update workspace configuration",
    description:
      "Update existing workspace configuration files with backup and reload capabilities",
    responses: {
      200: {
        description: "Workspace updated successfully",
        content: {
          "application/json": {
            schema: resolver(updateWorkspaceResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid configuration or workspace not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Update failed",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", workspaceIdParamSchema),
  validator("json", updateWorkspaceSchema),
  async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { config, backup } = c.req.valid("json");

      // Get workspace manager from context
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();

      // Find the workspace
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({
          success: false,
          error: `Workspace not found: ${workspaceId}`,
        }, 400);
      }

      // Validate configuration
      const validationResult = WorkspaceConfigSchema.safeParse(config);
      if (!validationResult.success) {
        return c.json({
          success: false,
          error: `Invalid workspace configuration: ${
            validationResult.error.issues.map((issue) => issue.message).join(", ")
          }`,
        }, 400);
      }

      const validatedConfig = validationResult.data;

      // Convert config to YAML
      const yamlConfig = stringify(validatedConfig, {
        indent: 2,
        lineWidth: 100,
      });

      const workspacePath = workspace.path;
      const workspaceYmlPath = join(workspacePath, "workspace.yml");
      const filesModified = ["workspace.yml"];

      try {
        // Create backup if requested
        let backupPath: string | undefined;
        if (backup) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          backupPath = join(workspacePath, `workspace.yml.backup-${timestamp}`);

          try {
            const existingContent = await Deno.readTextFile(workspaceYmlPath);
            await Deno.writeTextFile(backupPath, existingContent);
          } catch (backupError) {
            return c.json({
              success: false,
              error: `Failed to create backup: ${
                backupError instanceof Error ? backupError.message : String(backupError)
              }`,
            }, 500);
          }
        }

        // Write updated configuration
        await Deno.writeTextFile(workspaceYmlPath, yamlConfig);

        // Determine if reload is required (simple heuristic - always true for now)
        // In future, we could analyze config differences to determine this
        const reloadRequired = true;

        return c.json({
          success: true,
          workspace,
          backupPath,
          filesModified,
          reloadRequired,
        });
      } catch (updateError) {
        return c.json({
          success: false,
          error: `Failed to update workspace files: ${
            updateError instanceof Error ? updateError.message : String(updateError)
          }`,
        }, 500);
      }
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },
);

export { updateWorkspace };
