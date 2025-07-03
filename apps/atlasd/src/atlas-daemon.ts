import {
  ConfigLoader,
  formatZodError,
  type MergedConfig,
  supervisorDefaults,
  WorkspaceConfigSchema,
} from "@atlas/config";
import {
  FilesystemConfigAdapter,
  FilesystemTemplateAdapter,
  FilesystemWorkspaceCreationAdapter,
} from "@atlas/storage";
import { dirname, join } from "@std/path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ConversationSessionManager } from "../../../src/core/conversation-session-manager.ts";
import {
  type ConversationEvent,
  ConversationSupervisor,
} from "../../../src/core/conversation-supervisor.ts";
import type { LibrarySearchQuery } from "../../../src/core/library/types.ts";
import {
  createKVStorage,
  createLibraryStorage,
  StorageConfigs,
} from "../../../src/core/storage/index.ts";
import {
  getWorkspaceManager,
  type WorkspaceCreateConfig,
} from "../../../src/core/workspace-manager.ts";
import { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import { Workspace } from "../../../src/core/workspace.ts";
import { WorkspaceMemberRole } from "../../../src/types/core.ts";
import { AtlasLogger } from "../../../src/utils/logger.ts";
import { AtlasTelemetry } from "../../../src/utils/telemetry.ts";
import { CronManager, type CronTimerConfig, type WorkspaceWakeupCallback } from "@atlas/cron";

export interface AtlasDaemonOptions {
  port?: number;
  hostname?: string;
  cors?: string | string[];
  maxConcurrentWorkspaces?: number;
  idleTimeoutMs?: number;
}

/**
 * AtlasDaemon - Single daemon managing multiple workspaces with on-demand runtime creation
 * Replaces the per-workspace WorkspaceServer architecture
 */
export class AtlasDaemon {
  private app: Hono;
  private options: AtlasDaemonOptions;
  private runtimes: Map<string, WorkspaceRuntime> = new Map();
  private idleTimeouts: Map<string, number> = new Map();
  private startTime = Date.now();
  private isShuttingDown = false;
  private server: any = null;
  private signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];
  private isInitialized = false;
  private supervisorDefaults: any = null;
  private libraryStorage: any = null; // LibraryStorageAdapter
  private conversationSessionManager: ConversationSessionManager = new ConversationSessionManager();
  private templateAdapter: FilesystemTemplateAdapter | null = null;
  private workspaceCreationAdapter: FilesystemWorkspaceCreationAdapter | null = null;
  private cronManager: CronManager | null = null;

  constructor(options: AtlasDaemonOptions = {}) {
    this.options = {
      maxConcurrentWorkspaces: 10,
      idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
      ...options,
    };
    this.app = new Hono();
    this.setupRoutes();
    this.setupSignalHandlers();
  }

  /**
   * Initialize the daemon - load supervisor defaults, initialize WorkspaceManager, etc.
   * Must be called before start()
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const logger = AtlasLogger.getInstance();
    logger.info("Initializing Atlas daemon...");

    // Load supervisor defaults once at startup
    await this.loadSupervisorDefaults();

    // Initialize WorkspaceManager singleton (with auto-import)
    logger.info("Initializing WorkspaceManager...");
    const manager = getWorkspaceManager();
    await manager.initialize();

    // Initialize LibraryStorage with hybrid storage
    logger.info("Initializing LibraryStorage...");
    this.libraryStorage = await createLibraryStorage(StorageConfigs.defaultKV(), {
      // Use XDG-compliant default location, but allow environment override
      contentDir: Deno.env.get("ATLAS_LIBRARY_DIR"),
      organizeByType: true,
      organizeByDate: true,
    });

    // Initialize template adapter with path to starters
    logger.info("Initializing template adapter...");
    // Use import.meta.url to get absolute path relative to this file
    const currentFileUrl = new URL(import.meta.url);
    const atlasRoot = join(currentFileUrl.pathname, "..", "..", "..");
    const templatePath = join(atlasRoot, "packages", "starters");
    logger.info(`Template path: ${templatePath}`);
    this.templateAdapter = new FilesystemTemplateAdapter(templatePath);

    // Initialize workspace creation adapter
    logger.info("Initializing workspace creation adapter...");
    this.workspaceCreationAdapter = new FilesystemWorkspaceCreationAdapter();

    // Initialize CronManager with KV storage
    logger.info("Initializing CronManager...");
    const kvStorageConfig = StorageConfigs.defaultKV();
    const kvStorage = await createKVStorage(kvStorageConfig);
    await kvStorage.initialize();
    this.cronManager = new CronManager(kvStorage, logger);

    // Set up workspace wakeup callback
    const wakeupCallback: WorkspaceWakeupCallback = async (
      workspaceId: string,
      signalId: string,
      signalData: any,
    ) => {
      logger.info("CronManager waking up workspace for timer signal", {
        workspaceId,
        signalId,
        timestamp: signalData.timestamp,
      });

      try {
        // Get or create workspace runtime (this will wake up the workspace)
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);

        // Process the timer signal - create proper IWorkspaceSignal compliant object
        const signal = {
          id: signalId,
          timestamp: new Date().toISOString(),
          // Add required provider property for IWorkspaceSignal compliance
          provider: {
            id: "cron-scheduler",
            name: "cron-scheduler",
          },
          // Add required methods to satisfy IWorkspaceSignal interface
          trigger: async () => {
            // Minimal implementation - no-op for timer signals
          },
          configure: () => {
            // Minimal implementation - no-op for timer signals
          },
        } as any;

        await runtime.processSignal(signal, signalData.data);

        logger.info("Timer signal processed successfully", { workspaceId, signalId });
      } catch (error) {
        logger.error("Failed to process timer signal", {
          error,
          workspaceId,
          signalId,
        });
      }
    };

    this.cronManager.setWakeupCallback(wakeupCallback);

    // Start CronManager
    await this.cronManager.start();
    logger.info("CronManager started successfully");

    // Register cron signals for all existing workspaces
    await this.discoverAndRegisterExistingCronSignals();

    this.isInitialized = true;
    logger.info("Atlas daemon initialized successfully");
  }

  /**
   * Load supervisor defaults (compiled into the application)
   */
  private async loadSupervisorDefaults(): Promise<void> {
    const logger = AtlasLogger.getInstance();

    // Use compiled-in defaults - no file I/O needed
    this.supervisorDefaults = supervisorDefaults;

    logger.info("Loaded supervisor defaults", {
      source: "compiled",
      version: this.supervisorDefaults.version,
      hasSupervisors: !!(this.supervisorDefaults as any)?.supervisors,
    });
  }

  /**
   * Get cached supervisor defaults
   */
  getSupervisorDefaults(): any {
    if (!this.isInitialized) {
      throw new Error("Daemon not initialized - call initialize() first");
    }
    return this.supervisorDefaults;
  }

  private setupRoutes() {
    // Setup CORS if configured
    if (this.options.cors) {
      this.app.use(
        "*",
        cors({
          origin: this.options.cors,
          credentials: true,
        }),
      );
    }

    // Daemon health check
    this.app.get("/health", (c) => {
      return c.json({
        status: "healthy",
        daemon: true,
        activeWorkspaces: this.runtimes.size,
        uptime: Date.now() - this.startTime,
        timestamp: new Date().toISOString(),
        version: {
          deno: Deno.version.deno,
          v8: Deno.version.v8,
          typescript: Deno.version.typescript,
        },
      });
    });

    // List all registered workspaces
    this.app.get("/api/workspaces", async (c) => {
      try {
        const manager = getWorkspaceManager();
        const workspaces = await manager.listWorkspaces();
        return c.json(workspaces);
      } catch (error) {
        return c.json({
          error: `Failed to list workspaces: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Get specific workspace info
    this.app.get("/api/workspaces/:workspaceId", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const manager = getWorkspaceManager();
        const workspace = await manager.describeWorkspace(workspaceId);
        return c.json(workspace);
      } catch (error) {
        return c.json({
          error: `Failed to get workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Create a new workspace
    this.app.post("/api/workspaces", async (c) => {
      try {
        const body = await c.req.json() as WorkspaceCreateConfig;
        const manager = getWorkspaceManager();
        const result = await manager.createWorkspace(body);
        return c.json(result, 201);
      } catch (error) {
        return c.json({
          error: `Failed to create workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Delete a workspace
    this.app.delete("/api/workspaces/:workspaceId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const force = c.req.query("force") === "true";

      try {
        // Unregister cron signals before deleting workspace
        await this.unregisterWorkspaceCronSignals(workspaceId);

        const manager = getWorkspaceManager();
        await manager.deleteWorkspace(workspaceId, force);
        return c.json({ message: `Workspace ${workspaceId} deleted` });
      } catch (error) {
        return c.json({
          error: `Failed to delete workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Add a single workspace by path
    this.app.post("/api/workspaces/add", async (c) => {
      try {
        const body = await c.req.json() as { path: string; name?: string; description?: string };
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
            const { parse } = await import("@std/yaml");
            const yamlContent = await Deno.readTextFile(workspaceYmlPath);
            const config = parse(yamlContent) as {
              workspace?: { name?: string; description?: string };
            };

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

        const manager = getWorkspaceManager();

        // Check if workspace already exists at this path
        const existingByPath = await manager.findByPath(path);
        if (existingByPath) {
          return c.json({
            error: `Workspace already registered at path: ${path}`,
          }, 409);
        }

        // If name is determined (provided or from config), check for naming conflicts
        if (workspaceName) {
          const existingByName = await manager.findByName(workspaceName);
          if (existingByName) {
            return c.json({
              error: `Workspace with name '${workspaceName}' already exists`,
            }, 409);
          }
        }

        // Register the workspace
        const entry = await manager.registerWorkspace(path, {
          name: workspaceName,
          description: workspaceDescription,
        });

        // Extract and register cron signals
        await this.registerWorkspaceCronSignals(entry.id, path);

        // Convert to API response format
        const workspaceInfo = {
          id: entry.id,
          name: entry.name,
          description: entry.metadata?.description,
          status: entry.status,
          path: entry.path,
          hasActiveRuntime: false,
          createdAt: entry.createdAt,
          lastSeen: entry.lastSeen,
        };

        return c.json(workspaceInfo, 201);
      } catch (error) {
        return c.json({
          error: `Failed to add workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Add multiple workspaces by paths (batch operation)
    this.app.post("/api/workspaces/add-batch", async (c) => {
      try {
        const body = await c.req.json() as { paths: string[] };
        const { paths } = body;

        if (!paths || !Array.isArray(paths) || paths.length === 0) {
          return c.json({ error: "Paths array is required" }, 400);
        }

        const manager = getWorkspaceManager();
        const results: {
          added: Array<{
            id: string;
            name: string;
            description?: string;
            status: string;
            path: string;
            hasActiveRuntime: boolean;
            createdAt: string;
            lastSeen: string;
          }>;
          failed: Array<{
            path: string;
            error: string;
          }>;
        } = {
          added: [],
          failed: [],
        };

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
                results.failed.push({
                  path,
                  error: `Path not found: ${path}`,
                });
                return;
              }

              if (!stats.isDirectory) {
                results.failed.push({
                  path,
                  error: `Path is not a directory: ${path}`,
                });
                return;
              }

              // Check for workspace.yml
              const workspaceYmlPath = join(path, "workspace.yml");
              try {
                await Deno.stat(workspaceYmlPath);
              } catch {
                results.failed.push({
                  path,
                  error: `workspace.yml not found in: ${path}`,
                });
                return;
              }

              // Check if workspace already exists at this path
              const existingByPath = await manager.findByPath(path);
              if (existingByPath) {
                results.failed.push({
                  path,
                  error: `Workspace already registered at path: ${path}`,
                });
                return;
              }

              // Try to read workspace.yml to get name and description
              let workspaceName: string | undefined;
              let workspaceDescription: string | undefined;

              try {
                const { parse } = await import("@std/yaml");
                const yamlContent = await Deno.readTextFile(workspaceYmlPath);
                const config = parse(yamlContent) as {
                  workspace?: { name?: string; description?: string };
                };

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

              // Extract and register cron signals
              await this.registerWorkspaceCronSignals(entry.id, path);

              results.added.push({
                id: entry.id,
                name: entry.name,
                description: entry.metadata?.description,
                status: entry.status,
                path: entry.path,
                hasActiveRuntime: false,
                createdAt: entry.createdAt,
                lastSeen: entry.lastSeen,
              });
            } catch (error) {
              results.failed.push({
                path,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });

          await Promise.all(batchPromises);
        }

        return c.json(results, 200);
      } catch (error) {
        return c.json({
          error: `Failed to add workspaces: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // List available workspace templates
    this.app.get("/api/templates", async (c) => {
      try {
        if (!this.templateAdapter) {
          return c.json({ error: "Template system not initialized" }, 500);
        }

        const templates = await this.templateAdapter.listTemplates();
        return c.json(templates);
      } catch (error) {
        return c.json({
          error: `Failed to list templates: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Create workspace from template
    this.app.post("/api/workspaces/create-from-template", async (c) => {
      try {
        if (!this.templateAdapter) {
          return c.json({ error: "Template system not initialized" }, 500);
        }

        const body = await c.req.json() as {
          templateId: string;
          name: string;
          path: string;
        };

        const { templateId, name, path } = body;

        if (!templateId || !name || !path) {
          return c.json({ error: "templateId, name, and path are required" }, 400);
        }

        // Check if template exists
        if (!await this.templateAdapter.templateExists(templateId)) {
          return c.json({ error: `Template '${templateId}' not found` }, 404);
        }

        // Check if target path already exists
        try {
          await Deno.stat(path);
          return c.json({ error: `Path already exists: ${path}` }, 409);
        } catch {
          // Path doesn't exist, which is what we want
        }

        // Create parent directory if needed
        const parentDir = join(path, "..");
        await Deno.mkdir(parentDir, { recursive: true });

        // Copy template files with replacements
        const replacements = {
          WORKSPACE_NAME: name,
          WORKSPACE_PATH: path,
          TIMESTAMP: new Date().toISOString(),
        };

        await this.templateAdapter.copyTemplate(templateId, path, replacements);

        // Register the new workspace
        const manager = getWorkspaceManager();
        const entry = await manager.registerWorkspace(path, {
          name,
          description: `Created from ${templateId} template`,
        });

        // Extract and register cron signals
        await this.registerWorkspaceCronSignals(entry.id, path);

        return c.json({
          id: entry.id,
          name: entry.name,
          path: entry.path,
          templateId,
          message: `Workspace created successfully from ${templateId} template`,
        }, 201);
      } catch (error) {
        return c.json({
          error: `Failed to create workspace from template: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Validate workspace configuration
    this.app.post("/api/workspaces/validate", async (c) => {
      try {
        const body = await c.req.json() as { config: unknown };
        const { config } = body;

        if (!config) {
          return c.json({ error: "config is required" }, 400);
        }

        // Validate using the WorkspaceConfigSchema
        const validationResult = WorkspaceConfigSchema.safeParse(config);

        if (validationResult.success) {
          return c.json({
            valid: true,
            config: validationResult.data,
            message: "Configuration is valid",
          });
        } else {
          return c.json({
            valid: false,
            errors: validationResult.error.issues,
            formattedError: formatZodError(validationResult.error, "workspace.yml"),
          });
        }
      } catch (error) {
        return c.json({
          error: `Failed to validate configuration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Create workspace from configuration YAML
    this.app.post("/api/workspaces/create-from-config", async (c) => {
      try {
        const body = await c.req.json() as {
          name: string;
          description: string;
          config: string;
          path?: string;
          cwd?: string; // Add CWD to body type
        };

        const { name, description, config, path, cwd } = body;

        if (!name || !description || !config) {
          return c.json({ error: "name, description, and config are required" }, 400);
        }

        if (!this.workspaceCreationAdapter) {
          return c.json({ error: "Workspace creation adapter not initialized" }, 500);
        }

        // Determine base path
        let basePath: string;
        if (path) {
          // Explicit path provided - use its parent directory
          basePath = dirname(path);
        } else if (cwd) {
          // Use provided CWD
          basePath = cwd;
        } else {
          // Fallback to ~/.atlas/workspaces
          basePath = join(Deno.env.get("HOME") || "/tmp", ".atlas/workspaces");
        }

        // Create workspace directory with collision detection
        const workspacePath = await this.workspaceCreationAdapter.createWorkspaceDirectory(
          basePath,
          name,
        );

        // Write workspace files
        await this.workspaceCreationAdapter.writeWorkspaceFiles(workspacePath, config);

        // Register the new workspace
        const manager = getWorkspaceManager();
        const entry = await manager.registerWorkspace(workspacePath, {
          name,
          description,
        });

        // Extract and register cron signals
        await this.registerWorkspaceCronSignals(entry.id, workspacePath);

        return c.json({
          id: entry.id,
          name: entry.name,
          path: entry.path,
          description,
          message: `Workspace created successfully from configuration`,
        }, 201);
      } catch (error) {
        return c.json({
          error: `Failed to create workspace from config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Refresh workspace config cache
    this.app.post("/api/workspaces/:workspaceId/refresh-config", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const manager = getWorkspaceManager();
        await manager.refreshWorkspaceConfig(workspaceId);
        return c.json({ message: `Workspace ${workspaceId} config cache refreshed` });
      } catch (error) {
        return c.json({
          error: `Failed to refresh config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Trigger signal on specific workspace
    this.app.post("/api/workspaces/:workspaceId/signals/:signalId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const signalId = c.req.param("signalId");
      const payload = await c.req.json();

      return await AtlasTelemetry.withServerSpan(
        "POST /api/workspaces/:workspaceId/signals/:signalId",
        async (span) => {
          AtlasTelemetry.addComponentAttributes(span, "signal", {
            id: signalId,
            workspaceId,
            type: "daemon",
          });

          try {
            // Get or create workspace runtime
            const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);

            // Get workspace configuration to find the signal
            const workspace = (runtime as any).workspace;
            const signal = workspace.signals[signalId];

            if (!signal) {
              return c.json({ error: `Signal not found: ${signalId}` }, 404);
            }

            // Process signal asynchronously
            const sessionPromise = runtime.processSignal(signal, payload);

            // Reset idle timeout for this workspace
            this.resetIdleTimeout(workspaceId);

            return c.json({
              message: "Signal accepted for processing",
              status: "processing",
              workspaceId,
              signalId,
            });
          } catch (error) {
            return c.json({
              error: `Failed to process signal: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }, 500);
          }
        },
        {
          "http.method": "POST",
          "http.url": `/api/workspaces/${workspaceId}/signals/${signalId}`,
          "signal.id": signalId,
          "workspace.id": workspaceId,
          "payload.size": JSON.stringify(payload).length,
        },
      );
    });

    // List sessions across all workspaces
    this.app.get("/api/sessions", (c) => {
      const allSessions: any[] = [];

      for (const [workspaceId, runtime] of this.runtimes) {
        const sessions = runtime.getSessions().map((session) => ({
          id: session.id,
          workspaceId,
          status: session.status,
          summary: session.summarize(),
          signal: session.signals?.triggers?.[0]?.id || "unknown",
          startTime: (session as any)._startTime,
          endTime: (session as any)._endTime,
          progress: session.progress(),
        }));
        allSessions.push(...sessions);
      }

      return c.json(allSessions);
    });

    // Get specific session from any workspace
    this.app.get("/api/sessions/:sessionId", (c) => {
      const sessionId = c.req.param("sessionId");

      // Find session across all runtimes
      for (const [workspaceId, runtime] of this.runtimes) {
        const session = runtime.getSession(sessionId);
        if (session) {
          const sessionData: any = {
            id: session.id,
            workspaceId,
            status: session.status,
            progress: session.progress(),
            summary: session.summarize(),
            signal: session.signals?.triggers?.[0]?.id || "unknown",
            startTime: (session as any)._startTime,
            endTime: (session as any)._endTime,
            artifacts: session.getArtifacts(),
          };

          // Get execution results if available
          const artifacts = session.getArtifacts();
          const resultsArtifact = artifacts.find((a) => a.type === "execution_results");
          if (resultsArtifact?.data) {
            sessionData.results = resultsArtifact.data.results;
            sessionData.summary = resultsArtifact.data.summary;
          }

          return c.json(sessionData);
        }
      }

      return c.json({ error: `Session not found: ${sessionId}` }, 404);
    });

    // Cancel session from any workspace
    this.app.delete("/api/sessions/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");

      // Find session across all runtimes
      for (const [workspaceId, runtime] of this.runtimes) {
        const session = runtime.getSession(sessionId);
        if (session) {
          try {
            await runtime.cancelSession(sessionId);
            return c.json({ message: `Session ${sessionId} cancelled`, workspaceId });
          } catch (error) {
            return c.json({
              error: `Failed to cancel session: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }, 500);
          }
        }
      }

      return c.json({ error: `Session not found: ${sessionId}` }, 404);
    });

    // List agents in a workspace
    this.app.get("/api/workspaces/:workspaceId/agents", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        // Get workspace runtime to access agent configuration
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const agents = await runtime.listAgents();
        return c.json(agents);
      } catch (error) {
        return c.json({
          error: `Failed to list agents: ${error instanceof Error ? error.message : String(error)}`,
        }, 500);
      }
    });

    // Describe specific agent in a workspace
    this.app.get("/api/workspaces/:workspaceId/agents/:agentId", async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const agentId = c.req.param("agentId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const agent = await runtime.describeAgent(agentId);
        return c.json(agent);
      } catch (error) {
        return c.json({
          error: `Failed to describe agent: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // List signals in a workspace
    this.app.get("/api/workspaces/:workspaceId/signals", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const signals = await runtime.listSignals();
        return c.json(signals);
      } catch (error) {
        return c.json({
          error: `Failed to list signals: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // List jobs in a workspace
    this.app.get("/api/workspaces/:workspaceId/jobs", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = await this.getOrCreateWorkspaceRuntime(workspaceId);
        const jobs = await runtime.listJobs();
        return c.json(jobs);
      } catch (error) {
        return c.json({
          error: `Failed to list jobs: ${error instanceof Error ? error.message : String(error)}`,
        }, 500);
      }
    });

    // Get workspace sessions
    this.app.get("/api/workspaces/:workspaceId/sessions", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const runtime = this.runtimes.get(workspaceId);
        if (!runtime) {
          return c.json([]); // No runtime = no sessions
        }

        const sessions = await runtime.listSessions();
        return c.json(sessions);
      } catch (error) {
        return c.json({
          error: `Failed to list workspace sessions: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Library management routes
    // List library items
    this.app.get("/api/library", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        // Parse query parameters
        const query: LibrarySearchQuery = {
          query: c.req.query("q") || c.req.query("query"),
          type: c.req.query("type") ? c.req.query("type")!.split(",") : undefined,
          tags: c.req.query("tags") ? c.req.query("tags")!.split(",") : undefined,
          since: c.req.query("since"),
          until: c.req.query("until"),
          limit: c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50,
          offset: c.req.query("offset") ? parseInt(c.req.query("offset")!) : 0,
        };

        const result = await this.libraryStorage.search(query);
        return c.json(result);
      } catch (error) {
        return c.json({
          error: `Failed to list library items: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Search library items (before itemId route)
    this.app.get("/api/library/search", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const query: LibrarySearchQuery = {
          query: c.req.query("q") || c.req.query("query"),
          type: c.req.query("type") ? c.req.query("type")!.split(",") : undefined,
          tags: c.req.query("tags") ? c.req.query("tags")!.split(",") : undefined,
          since: c.req.query("since"),
          until: c.req.query("until"),
          limit: c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50,
          offset: c.req.query("offset") ? parseInt(c.req.query("offset")!) : 0,
        };

        const result = await this.libraryStorage.search(query);
        return c.json(result);
      } catch (error) {
        return c.json({
          error: `Failed to search library: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // List available templates (before itemId route)
    this.app.get("/api/library/templates", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const templates = await this.libraryStorage.listTemplates();
        return c.json(templates);
      } catch (error) {
        return c.json({
          error: `Failed to list templates: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Get library statistics (before itemId route)
    this.app.get("/api/library/stats", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const stats = await this.libraryStorage.getStats();
        return c.json(stats);
      } catch (error) {
        return c.json({
          error: `Failed to get library stats: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Generate content from template (before itemId route)
    this.app.post("/api/library/generate", async (c) => {
      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const { templateId, data, options } = await c.req.json();

        if (!templateId) {
          return c.json({ error: "templateId is required" }, 400);
        }

        // This would need template engine integration
        // For now, return a simple response
        return c.json({
          message: "Template generation not yet implemented",
          templateId,
          data,
          options,
        }, 501);
      } catch (error) {
        return c.json({
          error: `Failed to generate from template: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Get specific library item (must be after specific routes)
    this.app.get("/api/library/:itemId", async (c) => {
      const itemId = c.req.param("itemId");
      const includeContent = c.req.query("content") === "true";

      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const result = includeContent
          ? await this.libraryStorage.getItemWithContent(itemId)
          : await this.libraryStorage.getItem(itemId);

        if (!result) {
          return c.json({ error: `Library item not found: ${itemId}` }, 404);
        }

        if (includeContent && "content" in result) {
          return c.json({
            item: result.item,
            content: result.content,
          });
        } else {
          return c.json({ item: result.item });
        }
      } catch (error) {
        return c.json({
          error: `Failed to get library item: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // (Moved above to be before itemId route)

    // Delete library item
    this.app.delete("/api/library/:itemId", async (c) => {
      const itemId = c.req.param("itemId");

      try {
        if (!this.libraryStorage) {
          throw new Error("Library storage not initialized");
        }

        const deleted = await this.libraryStorage.deleteItem(itemId);
        if (!deleted) {
          return c.json({ error: `Library item not found: ${itemId}` }, 404);
        }

        return c.json({ message: `Library item ${itemId} deleted` });
      } catch (error) {
        return c.json({
          error: `Failed to delete library item: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Daemon management routes
    this.app.get("/api/daemon/status", (c) => {
      return c.json({
        status: "running",
        ...this.getStatus(),
        memoryUsage: Deno.memoryUsage(),
        workspaces: Array.from(this.runtimes.keys()),
      });
    });

    this.app.post("/api/daemon/shutdown", async (c) => {
      // Graceful shutdown endpoint
      AtlasLogger.getInstance().info("Daemon shutdown requested via API");

      // Don't await - respond immediately then shutdown
      setTimeout(() => this.shutdown(), 100);

      return c.json({ message: "Daemon shutdown initiated" });
    });

    // Conversation API Routes

    // Create conversation session
    this.app.post("/api/workspaces/:workspaceId/conversation/sessions", async (c) => {
      const workspaceId = c.req.param("workspaceId");

      try {
        const body = await c.req.json();
        const { mode = "private", metadata } = body;
        const { userId = "anonymous", clientType = "atlas-cli" } = metadata || {};

        const session = await this.conversationSessionManager.createSession(
          workspaceId,
          userId,
          clientType,
          mode,
        );

        return c.json({
          sessionId: session.id,
          mode: session.mode,
          participants: session.participants,
          sseUrl: `/api/workspaces/${workspaceId}/conversation/sessions/${session.id}/stream`,
        });
      } catch (error) {
        return c.json({
          error: `Failed to create conversation session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Send message to conversation session
    this.app.post(
      "/api/workspaces/:workspaceId/conversation/sessions/:sessionId/messages",
      async (c) => {
        const { workspaceId, sessionId } = c.req.param();

        try {
          const body = await c.req.json();
          const { message, fromUser = "anonymous" } = body;

          if (!message) {
            return c.json({ error: "Message is required" }, 400);
          }

          const session = this.conversationSessionManager.getSession(sessionId);
          if (!session) {
            return c.json({ error: "Session not found" }, 404);
          }

          if (session.workspaceId !== workspaceId) {
            return c.json({ error: "Session does not belong to this workspace" }, 400);
          }

          const messageId = `msg_${Math.random().toString(36).substring(2, 10)}`;

          // Add user message to history
          this.conversationSessionManager.addMessage(
            sessionId,
            messageId,
            fromUser,
            message,
            "user",
          );

          // Update participant activity
          this.conversationSessionManager.updateParticipantActivity(sessionId, fromUser);

          // Process message asynchronously (response will come via SSE)
          this.processConversationMessage(workspaceId, sessionId, messageId, message, fromUser)
            .catch((error) => {
              console.error(`Error processing conversation message: ${error}`);
            });

          return c.json({
            messageId,
            status: "processing",
          });
        } catch (error) {
          return c.json({
            error: `Failed to send message: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }, 500);
        }
      },
    );

    // SSE stream for conversation events
    this.app.get(
      "/api/workspaces/:workspaceId/conversation/sessions/:sessionId/stream",
      async (c) => {
        const { workspaceId, sessionId } = c.req.param();

        try {
          const session = this.conversationSessionManager.getSession(sessionId);
          if (!session) {
            return c.json({ error: "Session not found" }, 404);
          }

          if (session.workspaceId !== workspaceId) {
            return c.json({ error: "Session does not belong to this workspace" }, 400);
          }

          return this.streamConversationEvents(c, workspaceId, sessionId);
        } catch (error) {
          return c.json({
            error: `Failed to stream conversation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }, 500);
        }
      },
    );

    // Get conversation session info
    this.app.get("/api/workspaces/:workspaceId/conversation/sessions/:sessionId", async (c) => {
      const { workspaceId, sessionId } = c.req.param();

      try {
        const session = this.conversationSessionManager.getSession(sessionId);
        if (!session) {
          return c.json({ error: "Session not found" }, 404);
        }

        if (session.workspaceId !== workspaceId) {
          return c.json({ error: "Session does not belong to this workspace" }, 400);
        }

        return c.json(session);
      } catch (error) {
        return c.json({
          error: `Failed to get session: ${error instanceof Error ? error.message : String(error)}`,
        }, 500);
      }
    });
  }

  /**
   * Process conversation message with ConversationSupervisor and emit SSE events
   */
  private async processConversationMessage(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    message: string,
    fromUser: string,
  ): Promise<void> {
    try {
      // QUICK FIX: Get conversation history to pass to supervisor
      const messageHistory = this.conversationSessionManager.getMessageHistory(sessionId);

      // Create ConversationSupervisor with workspace context
      const supervisor = new ConversationSupervisor(workspaceId);

      // Process message and stream events to all connected SSE clients
      // QUICK FIX: Pass message history for context
      for await (
        const event of supervisor.processMessage(
          sessionId,
          messageId,
          message,
          fromUser,
          messageHistory,
        )
      ) {
        const logger = AtlasLogger.getInstance();
        logger.debug(JSON.stringify(
          {
            message: "Received event from supervisor",
            eventType: event.type,
            sessionId,
            messageId: event.messageId,
            hasData: !!event.data,
            dataKeys: event.data ? Object.keys(event.data) : [],
          },
          null,
          2,
        ));

        // QUICK FIX: Track message chunks to reconstruct complete response
        if (event.type === "message_chunk" && event.data.content) {
          this.messageChunks.set(messageId, event.data.content);
        }

        // Emit event to SSE clients for this session
        this.emitConversationEvent(sessionId, event);

        // Add assistant message to history when complete
        if (event.type === "message_complete" && !event.data.error) {
          // Get the complete message from the message_chunk events
          const completeMessage = this.getCompleteMessageFromEvents(messageId);
          if (completeMessage) {
            this.conversationSessionManager.addMessage(
              sessionId,
              `${messageId}_response`,
              "assistant",
              completeMessage,
              "assistant",
            );
          }
        }
      }
    } catch (error) {
      // Emit error event
      const errorEvent: ConversationEvent = {
        type: "message_complete",
        data: {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };

      this.emitConversationEvent(sessionId, errorEvent);
    }
  }

  private sseClients: Map<
    string,
    Array<{ writer: WritableStreamDefaultWriter; controller: ReadableStreamDefaultController }>
  > = new Map();

  /**
   * Stream conversation events via SSE
   */
  private streamConversationEvents(c: any, workspaceId: string, sessionId: string): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Add client to SSE clients for this session
    if (!this.sseClients.has(sessionId)) {
      this.sseClients.set(sessionId, []);
    }
    this.sseClients.get(sessionId)!.push({ writer, controller: null as any });

    // Send initial connection event
    const connectEvent = `event: connected\ndata: ${
      JSON.stringify({
        sessionId,
        timestamp: new Date().toISOString(),
      })
    }\n\n`;

    writer.write(encoder.encode(connectEvent)).catch(() => {
      // Client disconnected, clean up
      this.removeSSEClient(sessionId, writer);
    });

    // Handle client disconnect
    c.req.raw.signal?.addEventListener("abort", () => {
      this.removeSSEClient(sessionId, writer);
      writer.close();
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
      },
    });
  }

  /**
   * Emit conversation event to all SSE clients for a session
   */
  private emitConversationEvent(sessionId: string, event: ConversationEvent): void {
    const logger = AtlasLogger.getInstance();
    const clients = this.sseClients.get(sessionId);

    logger.info(JSON.stringify(
      {
        message: "emitConversationEvent called",
        sessionId,
        eventType: event.type,
        hasClients: !!clients,
        clientCount: clients?.length || 0,
        dataKeys: event.data ? Object.keys(event.data) : [],
      },
      null,
      2,
    ));

    if (!clients || clients.length === 0) {
      logger.warn("No SSE clients connected for session", { sessionId });
      return;
    }

    const encoder = new TextEncoder();
    const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const encodedData = encoder.encode(sseData);

    // Send to all connected clients for this session
    clients.forEach(({ writer }, index) => {
      writer.write(encodedData).catch((error) => {
        logger.error(JSON.stringify(
          {
            message: "Failed to write to SSE client",
            sessionId,
            clientIndex: index,
            error: error.message,
          },
          null,
          2,
        ));
        // Client disconnected, will be cleaned up by abort handler
      });
    });
  }

  /**
   * Remove SSE client from session
   */
  private removeSSEClient(sessionId: string, writer: WritableStreamDefaultWriter): void {
    const clients = this.sseClients.get(sessionId);
    if (!clients) return;

    const index = clients.findIndex((client) => client.writer === writer);
    if (index !== -1) {
      clients.splice(index, 1);
    }

    // Clean up empty sessions
    if (clients.length === 0) {
      this.sseClients.delete(sessionId);
    }
  }

  // QUICK FIX: Track message chunks to reconstruct complete messages
  private messageChunks: Map<string, string> = new Map();

  /**
   * Get complete message content from message_chunk events
   */
  private getCompleteMessageFromEvents(messageId: string): string | null {
    const content = this.messageChunks.get(messageId);
    if (content) {
      // Clean up after retrieving
      this.messageChunks.delete(messageId);
      return content;
    }
    return null;
  }

  /**
   * Get or create a workspace runtime on-demand
   */
  private async getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
    const logger = AtlasLogger.getInstance();

    try {
      logger.debug(`getOrCreateWorkspaceRuntime called for workspace: ${workspaceId}`);

      // Check if runtime already exists
      let runtime = this.runtimes.get(workspaceId);
      if (runtime) {
        logger.debug(`Found existing runtime for workspace: ${workspaceId}`);
        return runtime;
      }

      // Check concurrent workspace limit
      if (this.runtimes.size >= this.options.maxConcurrentWorkspaces!) {
        logger.warn(
          `Maximum concurrent workspaces reached (${this.options.maxConcurrentWorkspaces}), attempting eviction`,
        );
        // Find the oldest idle workspace to evict
        const oldestWorkspace = this.findOldestIdleWorkspace();
        if (oldestWorkspace) {
          logger.info(`Evicting oldest idle workspace: ${oldestWorkspace}`);
          await this.destroyWorkspaceRuntime(oldestWorkspace);
        } else {
          const error =
            `Maximum concurrent workspaces reached (${this.options.maxConcurrentWorkspaces})`;
          logger.error(error);
          throw new Error(error);
        }
      }

      // Find workspace in registry (manager already initialized at daemon startup)
      logger.debug(`Looking up workspace in registry: ${workspaceId}`);
      const manager = getWorkspaceManager();

      const workspace = await manager.findById(workspaceId) ||
        await manager.findByName(workspaceId);

      if (!workspace) {
        const error = `Workspace not found: ${workspaceId}`;
        logger.error(error);
        throw new Error(error);
      }

      logger.info(
        `Creating runtime for workspace: ${workspace.name} (${workspace.id}) at path: ${workspace.path}`,
      );

      // Validate workspace path exists
      try {
        const stat = await Deno.stat(workspace.path);
        if (!stat.isDirectory) {
          throw new Error(`Workspace path is not a directory: ${workspace.path}`);
        }
      } catch (error) {
        logger.error(`Failed to access workspace path: ${workspace.path}`, error);
        throw new Error(`Workspace path does not exist: ${workspace.path}`);
      }

      // Use cached configuration from workspace registry
      let mergedConfig: MergedConfig;

      if (workspace.config) {
        // Use pre-cached configuration (preferred - no I/O at signal time)
        // Normalize cached WorkspaceConfig to MergedConfig structure
        const adapter = new FilesystemConfigAdapter();
        const configLoader = new ConfigLoader(adapter, workspace.path);
        const fullConfig = await configLoader.load();
        mergedConfig = {
          ...fullConfig,
          workspace: workspace.config, // Use cached workspace config for performance
        };
        logger.debug(`Using cached workspace configuration with fresh platform config`, {
          workspaceId: workspace.id,
          configHash: workspace.configHash?.substring(0, 8) + "...",
        });
      } else {
        // Fallback: load configuration (should only happen for legacy registrations)
        logger.warn(`No cached config found, falling back to live loading`, {
          workspaceId: workspace.id,
          path: workspace.path,
        });
        const adapter = new FilesystemConfigAdapter();
        const configLoader = new ConfigLoader(adapter, workspace.path);
        mergedConfig = await configLoader.load();
        logger.debug(`Configuration loaded from disk as fallback`);
      }

      logger.debug(`Creating Workspace object from config...`);
      logger.debug(
        `Workspace signals: ${
          mergedConfig.workspace?.signals
            ? Object.keys(mergedConfig.workspace.signals).join(", ")
            : "none"
        }`,
      );

      const workspaceObj = Workspace.fromConfig(mergedConfig.workspace, {
        id: workspace.id,
        name: workspace.name,
        role: WorkspaceMemberRole.OWNER,
      });

      logger.debug(
        `Workspace object created with signals: ${
          Object.keys(workspaceObj.signals).join(", ") || "none"
        } (${Object.keys(workspaceObj.signals).length} total)`,
      );

      logger.debug(`Creating WorkspaceRuntime...`);
      runtime = new WorkspaceRuntime(workspaceObj, mergedConfig, {
        lazy: true, // Always use lazy loading in daemon mode
        workspacePath: workspace.path, // Pass workspace path for daemon mode
        libraryStorage: this.libraryStorage, // Share daemon's library storage
      });
      logger.debug(`WorkspaceRuntime created successfully`);

      this.runtimes.set(workspace.id, runtime);
      logger.debug(`Runtime stored in daemon registry`);

      // Register runtime with WorkspaceManager
      manager.registerRuntime(workspace.id, runtime, workspaceObj, {
        name: workspace.name,
        description: workspace.metadata?.description,
      });
      logger.debug(`Runtime registered with WorkspaceManager`);

      // Set idle timeout
      this.resetIdleTimeout(workspace.id);
      logger.debug(`Idle timeout set for workspace: ${workspace.id}`);

      logger.info(
        `Runtime created successfully for workspace: ${workspace.name} (${workspace.id})`,
      );

      return runtime;
    } catch (error) {
      logger.error(`Failed to create workspace runtime for ${workspaceId}:`, error);
      throw error;
    }
  }

  /**
   * Find the oldest idle workspace for eviction
   */
  private findOldestIdleWorkspace(): string | null {
    let oldestTime = Date.now();
    let oldestWorkspace: string | null = null;

    for (const [workspaceId, runtime] of this.runtimes) {
      const sessions = runtime.getSessions();
      const hasActiveSessions = sessions.some((s) =>
        s.status === "running" || s.status === "starting"
      );

      if (!hasActiveSessions) {
        // Check when this workspace was last active
        const lastActivityTime = this.getLastActivityTime(workspaceId);
        if (lastActivityTime < oldestTime) {
          oldestTime = lastActivityTime;
          oldestWorkspace = workspaceId;
        }
      }
    }

    return oldestWorkspace;
  }

  /**
   * Get last activity time for a workspace
   */
  private getLastActivityTime(workspaceId: string): number {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return 0;

    const sessions = runtime.getSessions();
    if (sessions.length === 0) return 0;

    // Find the most recent session activity
    return Math.max(...sessions.map((s) => (s as any)._startTime || 0));
  }

  /**
   * Reset idle timeout for a workspace
   */
  private resetIdleTimeout(workspaceId: string) {
    // Clear existing timeout
    const existingTimeout = this.idleTimeouts.get(workspaceId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeoutId = setTimeout(() => {
      this.checkAndDestroyIdleWorkspace(workspaceId);
    }, this.options.idleTimeoutMs!);

    this.idleTimeouts.set(workspaceId, timeoutId);
  }

  /**
   * Check if workspace is idle and destroy it
   */
  private async checkAndDestroyIdleWorkspace(workspaceId: string) {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;

    const sessions = runtime.getSessions();
    const hasActiveSessions = sessions.some((s) =>
      s.status === "running" || s.status === "starting"
    );

    if (!hasActiveSessions) {
      AtlasLogger.getInstance().info(`Destroying idle workspace runtime: ${workspaceId}`);
      await this.destroyWorkspaceRuntime(workspaceId);
    } else {
      // Still has active sessions, reset timeout
      this.resetIdleTimeout(workspaceId);
    }
  }

  /**
   * Destroy a workspace runtime
   */
  private async destroyWorkspaceRuntime(workspaceId: string) {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;

    try {
      await runtime.shutdown();
    } catch (error) {
      AtlasLogger.getInstance().error(
        `Error shutting down workspace runtime ${workspaceId}:`,
        error,
      );
    }

    this.runtimes.delete(workspaceId);

    // Unregister runtime from WorkspaceManager
    const manager = getWorkspaceManager();
    manager.unregisterRuntime(workspaceId);

    // Clear idle timeout
    const timeoutId = this.idleTimeouts.get(workspaceId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.idleTimeouts.delete(workspaceId);
    }

    AtlasLogger.getInstance().info(`Workspace runtime destroyed: ${workspaceId}`);
  }

  private setupSignalHandlers() {
    const daemonId = crypto.randomUUID().slice(0, 8);

    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      AtlasLogger.getInstance().info(
        `Daemon [${daemonId}] received ${signal}, shutting down gracefully`,
      );
      await this.shutdown();
      Deno.exit(0);
    };

    const sigtermHandler = () => handleShutdown("SIGTERM");
    const sigintHandler = () => handleShutdown("SIGINT");

    Deno.addSignalListener("SIGTERM", sigtermHandler);
    Deno.addSignalListener("SIGINT", sigintHandler);

    this.signalHandlers.push({ signal: "SIGTERM", handler: sigtermHandler });
    this.signalHandlers.push({ signal: "SIGINT", handler: sigintHandler });
  }

  async start() {
    // Ensure daemon is initialized
    await this.initialize();

    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";

    AtlasLogger.getInstance().info(`Starting Atlas daemon on http://${hostname}:${port}`, {
      hostname,
      port,
      maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    this.server = Deno.serve({
      port,
      hostname,
      onListen: ({ hostname, port }) => {
        AtlasLogger.getInstance().info(`Atlas daemon running on http://${hostname}:${port}`, {
          hostname,
          port,
        });
      },
    }, this.app.fetch);

    await this.server.finished;
  }

  async startNonBlocking(): Promise<{ finished: Promise<void> }> {
    // Ensure daemon is initialized
    await this.initialize();

    const port = this.options.port ?? 8080;
    const hostname = this.options.hostname || "localhost";

    AtlasLogger.getInstance().info(`Starting Atlas daemon on http://${hostname}:${port}`, {
      hostname,
      port,
      maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    let serverReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      serverReady = resolve;
    });

    this.server = Deno.serve({
      port,
      hostname,
      onListen: ({ hostname, port }) => {
        AtlasLogger.getInstance().info(`Atlas daemon running on http://${hostname}:${port}`, {
          hostname,
          port,
        });
        serverReady();
      },
    }, this.app.fetch);

    await readyPromise;
    return { finished: this.server.finished };
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    AtlasLogger.getInstance().info("Shutting down Atlas daemon...");

    // Remove signal handlers
    for (const { signal, handler } of this.signalHandlers) {
      Deno.removeSignalListener(signal, handler);
    }
    this.signalHandlers = [];

    // Shutdown all workspace runtimes
    const shutdownPromises = Array.from(this.runtimes.keys()).map((workspaceId) =>
      this.destroyWorkspaceRuntime(workspaceId)
    );
    await Promise.all(shutdownPromises);

    // Unregister all cron signals
    if (this.cronManager) {
      const activeTimers = this.cronManager.listActiveTimers();
      for (const timer of activeTimers) {
        await this.unregisterWorkspaceCronSignals(timer.workspaceId);
      }
    }

    // Clear all idle timeouts
    for (const timeoutId of this.idleTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.idleTimeouts.clear();

    // Shutdown CronManager
    if (this.cronManager) {
      await this.cronManager.shutdown();
      this.cronManager = null;
    }

    // Shutdown HTTP server
    if (this.server && this.server.shutdown) {
      await this.server.shutdown();
    }

    AtlasLogger.getInstance().info("Atlas daemon shutdown complete");
  }

  // Status getters
  getActiveWorkspaces(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getWorkspaceRuntime(workspaceId: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(workspaceId);
  }

  getCronManager(): CronManager | null {
    return this.cronManager;
  }

  /**
   * Extract and register cron signals from a workspace configuration
   */
  private async registerWorkspaceCronSignals(
    workspaceId: string,
    workspacePath: string,
  ): Promise<void> {
    if (!this.cronManager) {
      AtlasLogger.getInstance().warn(
        "CronManager not initialized - skipping cron signal registration",
        { workspaceId },
      );
      return;
    }

    try {
      // Check if workspace directory exists first
      try {
        await Deno.stat(workspacePath);
      } catch {
        AtlasLogger.getInstance().debug(
          "Skipping cron signal registration for non-existent workspace",
          {
            workspaceId,
            workspacePath,
          },
        );
        return;
      }

      // Load workspace configuration
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, workspacePath);
      const config = await configLoader.load();

      // Extract timer signals from configuration
      const signals = config.workspace?.signals || {};
      const cronTimers: CronTimerConfig[] = [];

      for (const [signalId, signalConfig] of Object.entries(signals)) {
        // Check if this is a timer signal with cron schedule
        if (
          signalConfig && typeof signalConfig === "object" &&
          "provider" in signalConfig && signalConfig.provider === "cron-scheduler" &&
          "schedule" in signalConfig && typeof signalConfig.schedule === "string"
        ) {
          const cronConfig: CronTimerConfig = {
            workspaceId,
            signalId,
            schedule: signalConfig.schedule,
            timezone: (signalConfig as any).timezone || "UTC",
            description: (signalConfig as any).description,
          };

          cronTimers.push(cronConfig);
        }
      }

      // Register all cron timers with CronManager sequentially to prevent conflicts
      for (const cronConfig of cronTimers) {
        try {
          await this.cronManager.registerTimer(cronConfig);
          AtlasLogger.getInstance().info("Registered cron timer for workspace", {
            workspaceId,
            signalId: cronConfig.signalId,
            schedule: cronConfig.schedule,
          });
        } catch (error) {
          AtlasLogger.getInstance().error("Failed to register individual cron timer", {
            error: error instanceof Error ? error.message : String(error),
            workspaceId,
            signalId: cronConfig.signalId,
          });
          // Continue with other timers even if one fails
        }
      }

      if (cronTimers.length > 0) {
        AtlasLogger.getInstance().info("Workspace cron signals registered", {
          workspaceId,
          timerCount: cronTimers.length,
        });
      }
    } catch (error) {
      AtlasLogger.getInstance().error("Failed to register workspace cron signals", {
        error: error instanceof Error ? error.message : String(error),
        errorDetails: error,
        workspaceId,
        workspacePath,
      });
    }
  }

  /**
   * Unregister all cron signals for a workspace
   */
  private async unregisterWorkspaceCronSignals(workspaceId: string): Promise<void> {
    if (!this.cronManager) {
      return;
    }

    try {
      await this.cronManager.unregisterWorkspaceTimers(workspaceId);
      AtlasLogger.getInstance().info("Unregistered workspace cron signals", { workspaceId });
    } catch (error) {
      AtlasLogger.getInstance().error("Failed to unregister workspace cron signals", {
        error,
        workspaceId,
      });
    }
  }

  /**
   * Discover and register cron signals for all existing workspaces
   */
  private async discoverAndRegisterExistingCronSignals(): Promise<void> {
    if (!this.cronManager) {
      AtlasLogger.getInstance().warn(
        "CronManager not initialized - skipping existing workspace discovery",
      );
      return;
    }

    try {
      const manager = getWorkspaceManager();
      const workspaces = await manager.listAllPersisted();

      AtlasLogger.getInstance().info("Discovering cron signals for existing workspaces", {
        workspaceCount: workspaces.length,
      });

      let registeredTimers = 0;
      let processedWorkspaces = 0;

      // Process workspaces sequentially to prevent registration conflicts
      for (const workspace of workspaces) {
        try {
          const timersBefore = this.cronManager.listActiveTimers().length;
          await this.registerWorkspaceCronSignals(workspace.id, workspace.path);
          const timersAfter = this.cronManager.listActiveTimers().length;
          registeredTimers += timersAfter - timersBefore;
          processedWorkspaces++;

          AtlasLogger.getInstance().debug("Processed workspace cron signals", {
            workspaceId: workspace.id,
            timersAdded: timersAfter - timersBefore,
            progress: `${processedWorkspaces}/${workspaces.length}`,
          });
        } catch (error) {
          AtlasLogger.getInstance().warn("Failed to register cron signals for existing workspace", {
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            error: error instanceof Error ? error.message : String(error),
          });
          processedWorkspaces++;
        }
      }

      AtlasLogger.getInstance().info("Existing workspace cron signal discovery complete", {
        workspacesProcessed: processedWorkspaces,
        totalWorkspaces: workspaces.length,
        timersRegistered: registeredTimers,
      });
    } catch (error) {
      AtlasLogger.getInstance().error("Failed to discover existing workspace cron signals", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getStatus() {
    const cronStats = this.cronManager?.getStats();
    return {
      activeWorkspaces: this.runtimes.size,
      uptime: Date.now() - this.startTime,
      cronManager: cronStats
        ? {
          isActive: this.cronManager?.isActive() || false,
          ...cronStats,
        }
        : null,
      configuration: {
        maxConcurrentWorkspaces: this.options.maxConcurrentWorkspaces,
        idleTimeoutMs: this.options.idleTimeoutMs,
      },
    };
  }
}
