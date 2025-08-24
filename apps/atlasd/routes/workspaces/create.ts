import { WorkspaceConfigSchema } from "@atlas/config";
import { FilesystemWorkspaceCreationAdapter } from "@atlas/storage";
import { stringify } from "@std/yaml";
import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import {
  createWorkspaceFromConfigResponseSchema,
  createWorkspaceFromConfigSchema,
  errorResponseSchema,
} from "./schemas.ts";

const createWorkspace = daemonFactory.createApp();

createWorkspace.post(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Create workspace from configuration",
    description: "Create workspace files and register workspace from generated configuration",
    responses: {
      200: {
        description: "Workspace created successfully",
        content: {
          "application/json": { schema: resolver(createWorkspaceFromConfigResponseSchema) },
        },
      },
      400: {
        description: "Invalid configuration",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Creation failed",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("json", createWorkspaceFromConfigSchema),
  async (c) => {
    try {
      const { config, workspaceName } = c.req.valid("json");

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

      // Create workspace files
      const workspaceAdapter = new FilesystemWorkspaceCreationAdapter();
      const finalWorkspaceName = workspaceName || validatedConfig.workspace.name;
      const basePath = Deno.cwd(); // Always use current working directory as base

      try {
        const workspacePath = await workspaceAdapter.createWorkspaceDirectory(
          basePath,
          finalWorkspaceName,
        );

        await workspaceAdapter.writeWorkspaceFiles(workspacePath, yamlConfig);

        // Register workspace with manager
        const ctx = c.get("app");
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.registerWorkspace(workspacePath, {
          name: finalWorkspaceName,
          description: validatedConfig.workspace.description,
        });

        // Cron signals are now automatically registered via WorkspaceManager hooks

        return c.json({
          success: true,
          workspace,
          workspacePath,
          filesCreated: ["workspace.yml", ".env"],
        });
      } catch (creationError) {
        return c.json(
          {
            success: false,
            error: `Failed to create workspace files: ${
              creationError instanceof Error ? creationError.message : String(creationError)
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

export { createWorkspace };
