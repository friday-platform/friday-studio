import { WorkspaceConfigSchema } from "@atlas/config";
import { WorkspaceSessionStatus } from "@atlas/core";
import { logger } from "@atlas/logger";
import { join } from "@std/path";
import { stringify } from "@std/yaml";
import { describeRoute, resolver, validator } from "hono-openapi";
import type { IWorkspaceSession } from "../../../../src/types/core.ts";
import { daemonFactory } from "../../src/factory.ts";
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
        content: { "application/json": { schema: resolver(updateWorkspaceResponseSchema) } },
      },
      400: {
        description: "Invalid configuration or workspace not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Update failed",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
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
        return c.json({ success: false, error: `Workspace not found: ${workspaceId}` }, 400);
      }

      // Validate configuration
      const validationResult = WorkspaceConfigSchema.safeParse(config);
      if (!validationResult.success) {
        return c.json(
          {
            success: false,
            error: `Invalid workspace configuration: ${validationResult.error.issues
              .map((issue) => issue.message)
              .join(", ")}`,
          },
          400,
        );
      }

      const validatedConfig = validationResult.data;

      // Convert config to YAML
      const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });

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
            return c.json(
              {
                success: false,
                error: `Failed to create backup: ${
                  backupError instanceof Error ? backupError.message : String(backupError)
                }`,
              },
              500,
            );
          }
        }

        // Write updated configuration
        await Deno.writeTextFile(workspaceYmlPath, yamlConfig);

        // Determine if reload is required (simple heuristic - always true for now)
        // In future, we could analyze config differences to determine this
        const reloadRequired = true;

        // Get the daemon context to access runtime
        const runtime = ctx.getWorkspaceRuntime(workspace.id);

        if (runtime) {
          logger.info("Configuration updated, reloading runtime", {
            workspaceId,
            workspaceActualId: workspace.id,
            currentState: "running",
          });

          try {
            // Wait for active sessions with timeout
            const sessions = runtime.getSessions();
            const activeSessions = sessions.filter(
              (s: IWorkspaceSession) =>
                s.status === WorkspaceSessionStatus.EXECUTING ||
                s.status === WorkspaceSessionStatus.PENDING,
            );

            if (activeSessions.length > 0) {
              logger.info("Waiting for active sessions to complete", {
                workspaceId,
                workspaceActualId: workspace.id,
                activeSessionCount: activeSessions.length,
                sessionIds: activeSessions.map((s: IWorkspaceSession) => s.id),
              });

              // Wait up to 30 seconds for sessions to complete
              const timeout = 30000;
              const startTime = Date.now();

              while (
                activeSessions.some(
                  (s: IWorkspaceSession) => s.status === WorkspaceSessionStatus.EXECUTING,
                ) &&
                Date.now() - startTime < timeout
              ) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }

              if (Date.now() - startTime >= timeout) {
                logger.warn("Timeout waiting for sessions, forcing shutdown", {
                  workspaceId,
                  workspaceActualId: workspace.id,
                  remainingSessionCount: activeSessions.filter(
                    (s: IWorkspaceSession) => s.status === WorkspaceSessionStatus.EXECUTING,
                  ).length,
                });
              }
            }

            // Destroy the runtime
            await ctx.destroyWorkspaceRuntime(workspace.id);

            logger.info("Runtime destroyed successfully", {
              workspaceId,
              workspaceActualId: workspace.id,
              willRecreateOnNextAccess: true,
            });

            return c.json({
              success: true,
              workspace,
              backupPath,
              filesModified,
              reloadRequired,
              runtimeReloaded: true,
              runtimeDestroyed: true,
            });
          } catch (error) {
            logger.error("Failed to reload runtime", {
              workspaceId,
              workspaceActualId: workspace.id,
              error: error instanceof Error ? error.message : String(error),
            });

            return c.json({
              success: true,
              workspace,
              backupPath,
              filesModified,
              reloadRequired,
              runtimeReloaded: false,
              error: "Failed to destroy runtime",
            });
          }
        } else {
          logger.info("No runtime to reload", { workspaceId, workspaceActualId: workspace.id });

          return c.json({
            success: true,
            workspace,
            backupPath,
            filesModified,
            reloadRequired,
            runtimeReloaded: false,
            message: "No active runtime",
          });
        }
      } catch (updateError) {
        return c.json(
          {
            success: false,
            error: `Failed to update workspace files: ${
              updateError instanceof Error ? updateError.message : String(updateError)
            }`,
          },
          500,
        );
      }
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { updateWorkspace };
