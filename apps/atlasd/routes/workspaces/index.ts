import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import { WorkspaceConfigSchema } from "@atlas/config";
import {
  type CredentialUsage,
  extractCredentials,
  toIdRefs,
  toProviderRefs,
} from "@atlas/config/mutations";
import {
  CredentialNotFoundError,
  fetchLinkCredential,
  LinkCredentialNotFoundError,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger, logger } from "@atlas/logger";
import { FilesystemWorkspaceCreationAdapter } from "@atlas/storage";
import { ColorSchema, isErrnoException, stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { join } from "@std/path";
import { stringify } from "@std/yaml";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { getCurrentUser } from "../me/adapter.ts";
import {
  addWorkspaceBatchSchema,
  addWorkspaceSchema,
  createWorkspaceFromConfigSchema,
  updateWorkspaceConfigSchema,
} from "./schemas.ts";

const analytics = createAnalyticsClient();

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
      const response = workspaces
        .map((w) => ({
          ...w,
          description: w.metadata?.description,
          type: w.metadata?.ephemeral ? "ephemeral" : "persistent",
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return c.json(response);
    } catch (error) {
      return c.json({ error: `Failed to list workspaces: ${stringifyError(error)}` }, 500);
    }
  })
  // Create workspace from configuration
  .post("/create", zValidator("json", createWorkspaceFromConfigSchema), async (c) => {
    try {
      const { config, workspaceName, ephemeral } = c.req.valid("json");

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

      let validatedConfig = validationResult.data;

      const credentials = extractCredentials(validatedConfig);
      const providerOnlyRefs = credentials.filter(
        (cred): cred is CredentialUsage & { provider: string } =>
          !!cred.provider && !cred.credentialId,
      );
      const uniqueProviders = [...new Set(providerOnlyRefs.map((ref) => ref.provider))];

      type ResolvedCredentialInfo = {
        path: string;
        provider: string;
        credentialId: string;
        label: string;
      };
      let resolvedCredentials: ResolvedCredentialInfo[] | undefined;

      if (uniqueProviders.length > 0) {
        const results = await Promise.allSettled(
          uniqueProviders.map((provider) => resolveCredentialsByProvider(provider)),
        );

        const missingProviders: string[] = [];
        const credentialMap: Record<string, string> = {};
        const labelMap: Record<string, string> = {};

        for (const [i, result] of results.entries()) {
          const provider = uniqueProviders[i] ?? "";
          if (result.status === "rejected") {
            if (result.reason instanceof CredentialNotFoundError) {
              missingProviders.push(provider);
            } else {
              throw result.reason;
            }
          } else {
            const first = result.value[0];
            if (first) {
              credentialMap[provider] = first.id;
              labelMap[provider] = first.label;
            }
          }
        }

        if (missingProviders.length > 0) {
          const providerKeys: Record<string, string[]> = {};
          for (const ref of providerOnlyRefs) {
            if (missingProviders.includes(ref.provider)) {
              if (!providerKeys[ref.provider]) {
                providerKeys[ref.provider] = [];
              }
              const keys = providerKeys[ref.provider] ?? [];
              if (!keys.includes(ref.key)) {
                keys.push(ref.key);
              }
            }
          }

          return c.json(
            {
              error: "missing_credentials",
              message: "Connect these integrations first",
              missingProviders,
              providerKeys,
            },
            400,
          );
        }

        validatedConfig = toIdRefs(validatedConfig, credentialMap);

        resolvedCredentials = providerOnlyRefs.map((ref) => ({
          path: ref.path,
          provider: ref.provider,
          credentialId: credentialMap[ref.provider] ?? "",
          label: labelMap[ref.provider] ?? "",
        }));

        const importLogger = createLogger({ component: "workspace-import" });
        const uniqueCredentialIds = [...new Set(Object.values(credentialMap))];
        const credentialSecrets = new Map<string, Record<string, unknown>>();

        const secretResults = await Promise.allSettled(
          uniqueCredentialIds.map(async (credId) => {
            const credential = await fetchLinkCredential(credId, importLogger);
            return { credId, secret: credential.secret };
          }),
        );

        const failedCredentials: string[] = [];
        for (const result of secretResults) {
          if (result.status === "fulfilled") {
            credentialSecrets.set(result.value.credId, result.value.secret);
          } else {
            failedCredentials.push(String(result.reason));
          }
        }

        if (failedCredentials.length > 0) {
          return c.json(
            {
              error: "credential_fetch_failed",
              message: "Failed to fetch resolved credentials for key validation",
              details: failedCredentials,
            },
            500,
          );
        }

        const invalidKeys: Array<{
          path: string;
          provider: string;
          key: string;
          availableKeys: string[];
        }> = [];

        for (const ref of providerOnlyRefs) {
          const credId = credentialMap[ref.provider];
          if (!credId) continue;
          const secret = credentialSecrets.get(credId);
          if (secret && !(ref.key in secret)) {
            invalidKeys.push({
              path: ref.path,
              provider: ref.provider,
              key: ref.key,
              availableKeys: Object.keys(secret),
            });
          }
        }

        if (invalidKeys.length > 0) {
          return c.json(
            {
              error: "invalid_credential_keys",
              message: "Resolved credentials are missing expected keys",
              invalidKeys,
            },
            400,
          );
        }
      }

      const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });

      const workspaceAdapter = new FilesystemWorkspaceCreationAdapter();
      const finalWorkspaceName = workspaceName || validatedConfig.workspace.name;
      const basePath = join(getAtlasHome(), "workspaces");

      try {
        const workspacePath = await workspaceAdapter.createWorkspaceDirectory(
          basePath,
          finalWorkspaceName,
        );

        await workspaceAdapter.writeWorkspaceFiles(workspacePath, yamlConfig, { ephemeral });

        // Get current user for analytics and metadata
        const userResult = await getCurrentUser();
        const userId = userResult.ok ? userResult.data?.id : undefined;

        // Register workspace with manager
        const ctx = c.get("app");
        const manager = ctx.daemon.getWorkspaceManager();
        const { workspace, created } = await manager.registerWorkspace(workspacePath, {
          name: finalWorkspaceName,
          description: validatedConfig.workspace.description,
          createdBy: userId,
        });

        // Emit workspace.created analytics event for new workspaces
        if (created && userId) {
          analytics.emit({
            eventName: EventNames.WORKSPACE_CREATED,
            userId,
            workspaceId: workspace.id,
          });
        }

        return c.json(
          {
            success: true,
            workspace,
            created,
            workspacePath,
            filesCreated: [ephemeral ? "eph_workspace.yml" : "workspace.yml", ".env"],
            ...(resolvedCredentials && resolvedCredentials.length > 0
              ? { resolvedCredentials }
              : {}),
          },
          201,
        );
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
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  })
  // Add a single workspace by path
  .post("/add", zValidator("json", addWorkspaceSchema), async (c) => {
    const ctx = c.get("app");
    try {
      const { path, name, description } = c.req.valid("json");

      // Get current user for analytics and metadata
      const userResult = await getCurrentUser();
      const userId = userResult.ok ? userResult.data?.id : undefined;

      const manager = ctx.daemon.getWorkspaceManager();

      const { workspace: entry, created } = await manager.registerWorkspace(path, {
        name,
        description,
        createdBy: userId,
      });

      // Emit workspace.created analytics event for new workspaces
      if (created && userId) {
        analytics.emit({ eventName: EventNames.WORKSPACE_CREATED, userId, workspaceId: entry.id });
      }

      // Convert to API response format
      const workspaceInfo = {
        id: entry.id,
        name: entry.name,
        description: entry.metadata?.description,
        status: entry.status,
        path: entry.path,
        createdAt: entry.createdAt,
        lastSeen: entry.lastSeen,
        created,
      };

      return c.json(workspaceInfo, created ? 201 : 200);
    } catch (error) {
      const message = stringifyError(error);
      logger.error("Failed to add workspace", { error: message });
      // Treat registration errors as bad requests (invalid path/config)
      if (message) return c.json({ error: message }, 400);
      return c.json({ error: `Failed to add workspace: ${message}` }, 500);
    }
  })
  // Add multiple workspaces by paths (batch operation)
  .post("/add-batch", zValidator("json", addWorkspaceBatchSchema), async (c) => {
    const ctx = c.get("app");
    try {
      const { paths } = c.req.valid("json");

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
          created: boolean;
        }>;
        failed: Array<{ path: string; error: string }>;
      } = { added: [], failed: [] };

      // Process paths with reasonable concurrency (5 parallel)
      const batchSize = 5;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const batchPromises = batch.map(async (path) => {
          try {
            const { workspace: entry, created } = await manager.registerWorkspace(path);

            results.added.push({
              id: entry.id,
              name: entry.name,
              description: entry.metadata?.description,
              status: entry.status,
              path: entry.path,
              createdAt: entry.createdAt,
              lastSeen: entry.lastSeen,
              created,
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
  // Get workspace details
  .get("/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace =
        (await manager.find({ id: workspaceId })) || (await manager.find({ name: workspaceId }));
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      // Load workspace configuration
      const config = await manager.getWorkspaceConfig(workspace.id);

      return c.json(
        {
          ...workspace,
          description: workspace.metadata?.description,
          type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
          config: config?.workspace || null,
        },
        200,
      );
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to get workspace: ${errorMessage}` }, 500);
    }
  })
  // Export workspace configuration as YAML
  .get("/:workspaceId/export", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const exportLogger = createLogger({ component: "workspace-export" });
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }

      const credentials = extractCredentials(config.workspace);
      const legacyRefs = credentials.filter(
        (cred): cred is CredentialUsage & { credentialId: string } =>
          !cred.provider && !!cred.credentialId,
      );

      const providerMap: Record<string, string> = {};
      const unresolvedPaths: string[] = [];

      const legacyResults = await Promise.allSettled(
        legacyRefs.map(async (ref) => {
          const credential = await fetchLinkCredential(ref.credentialId, exportLogger);
          return { credentialId: ref.credentialId, provider: credential.provider, path: ref.path };
        }),
      );

      for (const [i, result] of legacyResults.entries()) {
        const ref = legacyRefs[i];
        if (!ref) continue;
        if (result.status === "fulfilled") {
          providerMap[result.value.credentialId] = result.value.provider;
        } else if (result.reason instanceof LinkCredentialNotFoundError) {
          unresolvedPaths.push(ref.path);
        } else {
          throw result.reason;
        }
      }

      if (unresolvedPaths.length > 0) {
        return c.json(
          {
            error: "unresolvable_credentials",
            message: "Cannot resolve credentials for export",
            unresolvedPaths,
          },
          422,
        );
      }

      const portableConfig = toProviderRefs(config.workspace, providerMap);

      // Strip workspace.id - it will be regenerated on import
      const { id: _id, ...workspaceIdentity } = portableConfig.workspace;
      const exportConfig = { ...portableConfig, workspace: workspaceIdentity };

      const yamlContent = stringify(exportConfig, { indent: 2, lineWidth: 100 });

      // Sanitize workspace name for filename
      const sanitizedName = workspace.name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
      const filename = `${sanitizedName}.yml`;

      return new Response(yamlContent, {
        headers: {
          "Content-Type": "text/yaml",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to export workspace: ${errorMessage}` }, 500);
    }
  })
  // Get workspace configuration
  .get("/:workspaceId/config", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }
      return c.json({
        config: config.workspace,
        type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
        expiresAt: workspace.metadata?.expiresAt,
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to get workspace config: ${errorMessage}` }, 500);
    }
  })
  // Update workspace configuration
  .post(
    "/:workspaceId/update",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", updateWorkspaceConfigSchema),
    async (c) => {
      try {
        const { workspaceId } = c.req.valid("param");
        const { config, backup } = c.req.valid("json");

        const ctx = c.get("app");
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ success: false, error: `Workspace not found: ${workspaceId}` }, 400);
        }

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
        const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });
        const workspacePath = workspace.path;
        const workspaceYmlPath = join(workspacePath, "workspace.yml");

        try {
          if (backup) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupPath = join(workspacePath, `workspace.yml.backup-${timestamp}`);
            try {
              const existingContent = await readFile(workspaceYmlPath, "utf-8");
              await writeFile(backupPath, existingContent, "utf-8");
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

          await writeFile(workspaceYmlPath, yamlConfig, "utf-8");

          const runtime = ctx.getWorkspaceRuntime(workspace.id);
          if (runtime) {
            await ctx.destroyWorkspaceRuntime(workspace.id);
            return c.json({
              success: true,
              workspace,
              runtimeReloaded: true,
              runtimeDestroyed: true,
            });
          }

          return c.json({
            success: true,
            workspace,
            runtimeReloaded: false,
            message: "No active runtime",
          });
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
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // Toggle persistence
  .post(
    "/:workspaceId/persistence",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", z.object({ persistent: z.boolean() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { persistent } = c.req.valid("json");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        await manager.updateWorkspacePersistence(workspaceId, persistent);
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        return c.json({
          ...workspace,
          description: workspace.metadata?.description,
          type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
        });
      } catch (error) {
        return c.json({ error: `Failed to update persistence: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Update workspace metadata
  .patch(
    "/:workspaceId/metadata",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", z.object({ color: ColorSchema.optional() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const updates = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const newMetadata = { ...workspace.metadata, ...updates };
        await manager.updateWorkspaceStatus(workspaceId, workspace.status, {
          metadata: newMetadata,
        });

        return c.json({ ...workspace, metadata: newMetadata }, 200);
      } catch (error) {
        return c.json({ error: `Failed to update metadata: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Trigger a workspace signal
  .post(
    "/:workspaceId/signals/:signalId",
    zValidator("param", z.object({ workspaceId: z.string(), signalId: z.string() })),
    zValidator(
      "json",
      z.object({
        payload: z.record(z.string(), z.unknown()).optional(),
        streamId: z.string().optional(),
      }),
    ),
    async (c) => {
      const { workspaceId, signalId } = c.req.valid("param");
      const { payload, streamId } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const result = await ctx.daemon.triggerWorkspaceSignal(
          workspaceId,
          signalId,
          payload,
          streamId,
        );
        return c.json({
          message: "Signal accepted for processing",
          status: "processing" as const,
          workspaceId,
          signalId,
          sessionId: result.sessionId,
        });
      } catch (error) {
        const errorMessage = stringifyError(error);
        logger.error("Failed to process signal", { error });
        if (errorMessage.includes("Workspace not found")) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        if (errorMessage.includes("Workspace path does not exist")) {
          return c.json(
            {
              error: `Workspace '${workspaceId}' is not running. The workspace directory is unavailable.`,
            },
            422,
          );
        }
        if (errorMessage.includes("Signal not found") || errorMessage.includes("not found")) {
          return c.json(
            { error: `Signal '${signalId}' not found in workspace '${workspaceId}'` },
            404,
          );
        }
        return c.json({ error: `Failed to process signal: ${errorMessage}` }, 500);
      }
    },
  )
  // List jobs in a workspace
  .get("/:workspaceId/jobs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const jobs = runtime.listJobs();
      return c.json(jobs);
    } catch (error) {
      // When workspace path doesn't exist (stopped/deleted workspace), fall back to config
      if (stringifyError(error).includes("Workspace path does not exist")) {
        logger.debug("Workspace path unavailable, reading jobs from config", { workspaceId });
        const manager = ctx.getWorkspaceManager();
        const config = await manager.getWorkspaceConfig(workspaceId);
        const jobs = config?.workspace?.jobs || {};
        return c.json(
          Object.entries(jobs).map(([name, job]) => ({ name, description: job.description })),
        );
      }
      logger.error("Failed to list jobs", { error, workspaceId });
      return c.json({ error: `Failed to list jobs: ${stringifyError(error)}` }, 500);
    }
  })
  // Get workspace sessions
  .get("/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      const runtime = ctx.daemon.runtimes.get(workspace.id);
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
      return c.json({ signals: signals.map((signal) => ({ name: signal.id, signal })) }, 200);
    } catch (error) {
      // When workspace path doesn't exist (stopped/deleted workspace), fall back to config
      if (stringifyError(error).includes("Workspace path does not exist")) {
        logger.debug("Workspace path unavailable, reading signals from config", { workspaceId });
        const manager = ctx.getWorkspaceManager();
        const config = await manager.getWorkspaceConfig(workspaceId);
        const signals = config?.workspace?.signals || {};
        return c.json(
          {
            signals: Object.entries(signals).map(([id, signalConfig]) => ({
              name: id,
              signal: {
                id,
                description: signalConfig.description,
                provider: signalConfig.provider,
              },
            })),
          },
          200,
        );
      }
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
      return c.json(agent, 200);
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
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agents = runtime.listAgents();
      return c.json(agents);
    } catch (error) {
      logger.error("Failed to list agents", { error, workspaceId });
      return c.json({ error: `Failed to list agents: ${stringifyError(error)}` }, 500);
    }
  })
  // Delete a workspace
  .delete(
    "/:workspaceId",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("query", z.object({ force: z.literal("true").optional() }).optional()),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      const force = c.req.valid("query")?.force === "true";

      try {
        const manager = ctx.daemon.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });

        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        // Check if workspace is in .atlas directory
        const atlasDir = getAtlasHome();
        const workspacePath = workspace.path;

        if (workspacePath.startsWith(atlasDir)) {
          // Create unregistered directory if it doesn't exist
          const unregisteredDir = join(atlasDir, "unregistered");
          await mkdir(unregisteredDir, { recursive: true });

          // Move workspace to unregistered folder with collision handling
          const workspaceName = workspacePath.split("/").pop() || workspaceId;
          let targetPath = join(unregisteredDir, workspaceName);
          let counter = 1;

          // Find an available name if there's a collision
          while (true) {
            try {
              await stat(targetPath);
              // Path exists, try next number
              counter++;
              targetPath = join(unregisteredDir, `${workspaceName}-${counter}`);
            } catch (error) {
              // Path doesn't exist (NotFound error), we can use it
              if (isErrnoException(error) && error.code === "ENOENT") {
                break;
              }
              // Some other error, throw it
              throw error;
            }
          }

          try {
            await Deno.rename(workspacePath, targetPath);
            logger.info("Moved workspace to unregistered", {
              workspaceId,
              oldPath: workspacePath,
              newPath: targetPath,
            });
          } catch (error) {
            logger.warn("Failed to move workspace to unregistered", {
              error,
              workspaceId,
              workspacePath,
            });
            // Continue with deletion even if move fails
          }
        }

        await manager.deleteWorkspace(workspaceId, { force });
        return c.json({ message: `Workspace ${workspaceId} deleted` });
      } catch (error) {
        logger.error("Failed to delete workspace", { error, workspaceId });
        return c.json({ error: `Failed to delete workspace: ${stringifyError(error)}` }, 500);
      }
    },
  );

export { workspacesRoutes };
export type WorkspaceRoutes = typeof workspacesRoutes;
