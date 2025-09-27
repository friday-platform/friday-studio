import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { join } from "@std/path";
import { parse } from "@std/yaml";
import { daemonFactory } from "../../src/factory.ts";
import { createWorkspace } from "./create.ts";
import { getWorkspace } from "./get.ts";
import { getWorkspaceConfig } from "./get-config.ts";
import { triggerSignal } from "./trigger-signal.ts";
import { updateWorkspace } from "./update.ts";

// Export shared schemas and types
export * from "./schemas.ts";

// Create and mount routes
const workspacesRoutes = daemonFactory
  .createApp()
  // List all workspaces
  .get("/", async (c) => {
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspaces = await manager.list({ includeSystem: true });
      return c.json(workspaces);
    } catch (error) {
      return c.json({ error: `Failed to list workspaces: ${stringifyError(error)}` }, 500);
    }
  })
  // Add a single workspace by path
  .post("/add", async (c) => {
    const ctx = c.get("app");
    try {
      const body = await c.req.json();
      const { path, name: providedName, description: providedDescription } = body;

      if (!path) {
        return c.json({ error: "Path is required" }, 400);
      }

      // Validate path exists and is a directory
      let stats: Deno.FileInfo;
      try {
        stats = await Deno.stat(path);
      } catch {
        return c.json({ error: `Path not found: ${path}` }, 404);
      }

      if (!stats.isDirectory) {
        return c.json({ error: `Path is not a directory: ${path}` }, 400);
      }

      // Check for workspace.yml
      const workspaceYmlPath = join(path, "workspace.yml");
      try {
        await Deno.stat(workspaceYmlPath);
      } catch {
        return c.json({ error: `workspace.yml not found in: ${path}` }, 400);
      }

      // Try to read workspace.yml to get name and description
      let workspaceName = providedName;
      let workspaceDescription = providedDescription;

      // Only read workspace.yml if name wasn't explicitly provided
      if (!providedName) {
        try {
          const yamlContent = await Deno.readTextFile(workspaceYmlPath);
          const config = parse(yamlContent);

          if (config.workspace?.name) {
            workspaceName = config.workspace.name;
          }
          // Also use description from config if not provided
          if (!providedDescription && config.workspace?.description) {
            workspaceDescription = config.workspace.description;
          }
        } catch {
          // Ignore parsing errors, registerWorkspace will use directory name as fallback
        }
      }

      const manager = ctx.daemon.getWorkspaceManager();

      // Check if workspace already exists at this path
      const existingByPath = await manager.find({ path });
      if (existingByPath) {
        return c.json({ error: `Workspace already registered at path: ${path}` }, 409);
      }

      // If name is determined (provided or from config), check for naming conflicts
      if (workspaceName) {
        const existingByName = await manager.find({ name: workspaceName });
        if (existingByName) {
          return c.json({ error: `Workspace with name '${workspaceName}' already exists` }, 409);
        }
      }

      // Register the workspace
      const entry = await manager.registerWorkspace(path, {
        name: workspaceName,
        description: workspaceDescription,
      });

      // Cron signals are now automatically registered via WorkspaceManager hooks

      // Convert to API response format
      const workspaceInfo = {
        id: entry.id,
        name: entry.name,
        description: entry.metadata?.description,
        status: entry.status,
        path: entry.path,
        createdAt: entry.createdAt,
        lastSeen: entry.lastSeen,
      };

      return c.json(workspaceInfo, 201);
    } catch (error) {
      logger.error("Failed to add workspace", { error });
      return c.json({ error: `Failed to add workspace: ${stringifyError(error)}` }, 500);
    }
  })
  // Add multiple workspaces by paths (batch operation)
  .post("/add-batch", async (c) => {
    const ctx = c.get("app");
    try {
      const body = await c.req.json();
      const { paths } = body;

      if (!paths || !Array.isArray(paths) || paths.length === 0) {
        return c.json({ error: "Paths array is required" }, 400);
      }

      const manager = ctx.daemon.getWorkspaceManager();
      const results: {
        added: Array<{
          id: string;
          name: string;
          description?: string;
          status: string;
          path: string;
          createdAt: string;
          lastSeen: string;
        }>;
        failed: Array<{ path: string; error: string }>;
      } = { added: [], failed: [] };

      // Process paths with reasonable concurrency (5 parallel)
      const batchSize = 5;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const batchPromises = batch.map(async (path) => {
          try {
            // Validate path exists and is a directory
            let stats: Deno.FileInfo;
            try {
              stats = await Deno.stat(path);
            } catch {
              results.failed.push({ path, error: `Path not found: ${path}` });
              return;
            }

            if (!stats.isDirectory) {
              results.failed.push({ path, error: `Path is not a directory: ${path}` });
              return;
            }

            // Check for workspace.yml
            const workspaceYmlPath = join(path, "workspace.yml");
            try {
              await Deno.stat(workspaceYmlPath);
            } catch {
              results.failed.push({ path, error: `workspace.yml not found in: ${path}` });
              return;
            }

            // Check if workspace already exists at this path
            const existingByPath = await manager.find({ path });
            if (existingByPath) {
              results.failed.push({ path, error: `Workspace already registered at path: ${path}` });
              return;
            }

            // Try to read workspace.yml to get name and description
            let workspaceName: string | undefined;
            let workspaceDescription: string | undefined;

            try {
              const yamlContent = await Deno.readTextFile(workspaceYmlPath);
              const config = parse(yamlContent);

              if (config.workspace?.name) {
                workspaceName = config.workspace.name;
              }
              if (config.workspace?.description) {
                workspaceDescription = config.workspace.description;
              }
            } catch {
              // Ignore parsing errors, registerWorkspace will use directory name as fallback
            }

            // Register the workspace
            const entry = await manager.registerWorkspace(path, {
              name: workspaceName,
              description: workspaceDescription,
            });

            // Cron signals are now automatically registered via WorkspaceManager hooks

            results.added.push({
              id: entry.id,
              name: entry.name,
              description: entry.metadata?.description,
              status: entry.status,
              path: entry.path,
              createdAt: entry.createdAt,
              lastSeen: entry.lastSeen,
            });
          } catch (error) {
            results.failed.push({ path, error: stringifyError(error) });
          }
        });

        await Promise.all(batchPromises);
      }

      return c.json(results, 200);
    } catch (error) {
      logger.error("Failed to add workspaces", { error });
      return c.json({ error: "Failed to add workspaces" }, 500);
    }
  })
  // List jobs in a workspace
  .get("/:workspaceId/jobs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const jobs = runtime.listJobs();
      return c.json(jobs);
    } catch (error) {
      logger.error("Failed to list jobs", { error, workspaceId });
      return c.json({ error: `Failed to list jobs: ${stringifyError(error)}` }, 500);
    }
  })
  // Get workspace sessions
  .get("/:workspaceId/sessions", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = ctx.daemon.runtimes.get(workspaceId);
      if (!runtime) {
        return c.json([]); // No runtime = no sessions
      }

      const sessions = runtime.listSessions();
      return c.json(sessions);
    } catch (error) {
      logger.error("Failed to list workspace sessions", { error, workspaceId });
      return c.json({ error: `Failed to list workspace sessions: ${stringifyError(error)}` }, 500);
    }
  })
  // List signals in a workspace
  .get("/:workspaceId/signals", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const signals = runtime.listSignals();
      return c.json(signals);
    } catch (error) {
      logger.error("Failed to list signals", { error, workspaceId });
      return c.json({ error: `Failed to list signals: ${stringifyError(error)}` }, 500);
    }
  })
  // Describe specific agent in a workspace
  .get("/:workspaceId/agents/:agentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const agentId = c.req.param("agentId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agent = runtime.describeAgent(agentId);
      return c.json(agent);
    } catch (error) {
      logger.error("Failed to describe agent", { error, workspaceId, agentId });
      return c.json({ error: `Failed to describe agent: ${stringifyError(error)}` }, 500);
    }
  })
  // List agents in a workspace
  .get("/:workspaceId/agents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      // Get workspace runtime to access agent configuration
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agents = runtime.listAgents();
      return c.json(agents);
    } catch (error) {
      logger.error("Failed to list agents", { error, workspaceId });
      return c.json({ error: `Failed to list agents: ${stringifyError(error)}` }, 500);
    }
  })
  // Delete a workspace
  .delete("/:workspaceId", async (c) => {
    const ctx = c.get("app");
    const workspaceId = c.req.param("workspaceId");
    const force = c.req.query("force") === "true";

    try {
      // Unregister signal types for this workspace via registrars
      for (const registrar of ctx.daemon.signalRegistrars) {
        try {
          await Promise.resolve(registrar.unregisterWorkspace(workspaceId));
        } catch (error) {
          logger.warn("Signal registrar failed to unregister workspace", { workspaceId, error });
        }
      }

      const manager = ctx.daemon.getWorkspaceManager();
      await manager.deleteWorkspace(workspaceId, { force });
      return c.json({ message: `Workspace ${workspaceId} deleted` });
    } catch (error) {
      logger.error("Failed to delete workspace", { error, workspaceId });
      return c.json({ error: `Failed to delete workspace: ${stringifyError(error)}` }, 500);
    }
  });

// Mount individual endpoints
workspacesRoutes.route("/:workspaceId", getWorkspace);
workspacesRoutes.route("/:workspaceId/config", getWorkspaceConfig);
workspacesRoutes.route("/:workspaceId/update", updateWorkspace);
workspacesRoutes.route("/create", createWorkspace);
workspacesRoutes.route("/:workspaceId/signals/:signalId", triggerSignal);

export { workspacesRoutes };
export type WorkspaceRoutes = typeof workspacesRoutes;
