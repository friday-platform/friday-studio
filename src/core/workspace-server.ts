import { Hono } from "hono";
import { cors } from "hono/cors";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import { logger } from "../utils/logger.ts";

export interface WorkspaceServerOptions {
  port?: number;
  hostname?: string;
  cors?: string | string[];
}

/**
 * WorkspaceServer handles HTTP endpoints and network communication.
 * It does NOT manage workspace state or workers - that's the runtime's job.
 */
export class WorkspaceServer {
  private app: Hono;
  private runtime: WorkspaceRuntime;
  private options: WorkspaceServerOptions;

  constructor(runtime: WorkspaceRuntime, options: WorkspaceServerOptions = {}) {
    this.runtime = runtime;
    this.options = options;
    this.app = new Hono();

    this.setupRoutes();
    this.setupSignalHandlers();
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

    // Health check
    this.app.get("/health", (c) => {
      const status = this.runtime.getStatus();
      return c.json({
        status: "healthy",
        ...status,
      });
    });

    // Library routes
    this.setupLibraryRoutes();

    // List signals
    this.app.get("/signals", (c) => {
      const workspace = (this.runtime as any).workspace;
      const signals = Object.values(workspace.signals);
      return c.json(signals.map((s: any) => ({
        id: s.id,
        provider: s.provider,
        // Add other public signal properties
      })));
    });

    // Trigger signal
    this.app.post("/signals/:signalId", async (c) => {
      const signalId = c.req.param("signalId");
      const payload = await c.req.json();

      const workspace = (this.runtime as any).workspace;
      const signal = workspace.signals[signalId];

      if (!signal) {
        return c.json({ error: `Signal not found: ${signalId}` }, 404);
      }

      // Create root span for HTTP request to establish proper trace hierarchy
      return await AtlasTelemetry.withServerSpan(
        "POST /signals/:signalId",
        async (span) => {
          // Add HTTP and signal attributes to root span
          AtlasTelemetry.addComponentAttributes(span, "signal", {
            id: signalId,
            type: signal.provider || "http",
          });

          try {
            // Start signal processing asynchronously (fire-and-forget)
            const sessionPromise = this.runtime.processSignal(signal, payload);

            // Return immediately with session started confirmation
            return c.json({
              message: "Signal accepted for processing",
              status: "processing",
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
          "http.url": `/signals/${signalId}`,
          "signal.id": signalId,
          "payload.size": JSON.stringify(payload).length,
        },
      );
    });

    // Get session status
    this.app.get("/sessions/:sessionId", (c) => {
      const sessionId = c.req.param("sessionId");
      const session = this.runtime.getSession(sessionId);

      if (!session) {
        return c.json({ error: `Session not found: ${sessionId}` }, 404);
      }

      const sessionData: any = {
        id: session.id,
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
    });

    // List active sessions
    this.app.get("/sessions", (c) => {
      const sessions = this.runtime.getSessions().map((session) => ({
        id: session.id,
        status: session.status,
        summary: session.summarize(),
        signal: session.signals?.triggers?.[0]?.id || "unknown",
        startTime: (session as any)._startTime,
        endTime: (session as any)._endTime,
        progress: session.progress(),
      }));

      return c.json(sessions);
    });

    // Cancel session
    this.app.delete("/sessions/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");

      try {
        await this.runtime.cancelSession(sessionId);
        return c.json({ message: `Session ${sessionId} cancelled` });
      } catch (error) {
        return c.json({
          error: `Failed to cancel session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }, 500);
      }
    });

    // Worker status endpoint
    this.app.get("/workers", (c) => {
      const workers = this.runtime.getWorkers();
      return c.json(workers);
    });

    // Workspace info
    this.app.get("/workspace", (c) => {
      const workspace = (this.runtime as any).workspace;
      return c.json({
        id: workspace.id,
        snapshot: workspace.snapshot(),
        config: workspace.toConfig(),
      });
    });

    // Register dynamic HTTP signal routes
    this.setupDynamicSignalRoutes();
  }

  private setupDynamicSignalRoutes() {
    const workspace = (this.runtime as any).workspace;
    if (!workspace || !workspace.signals) return;

    // Register custom HTTP paths for signals with path configuration
    Object.entries(workspace.signals).forEach(([signalId, signal]: [string, any]) => {
      if (signal.provider === "http" && signal.path) {
        const method = (signal.method || "POST").toLowerCase();
        const path = signal.path;

        logger.info(
          `Registering HTTP signal route: ${method.toUpperCase()} ${path} -> ${signalId}`,
        );

        // Register the dynamic route
        (this.app as any)[method](path, async (c: any) => {
          const payload = method === "get" ? c.req.query() : await c.req.json();

          // Create root span for HTTP request
          return await AtlasTelemetry.withServerSpan(
            `${method.toUpperCase()} ${path}`,
            async (span) => {
              AtlasTelemetry.addComponentAttributes(span, "signal", {
                id: signalId,
                type: signal.provider || "http",
              });

              try {
                // Process signal through runtime
                const session = await this.runtime.processSignal(signal, payload);

                return c.json({
                  message: "Signal processed",
                  sessionId: session.id,
                  status: session.status,
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
              "http.method": method.toUpperCase(),
              "http.url": path,
              "signal.id": signalId,
              "payload.size": JSON.stringify(payload).length,
            },
          );
        });
      }
    });
  }

  private setupLibraryRoutes() {
    // List library items
    this.app.get("/library", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const options = {
          type: c.req.query("type"),
          tags: c.req.query("tags")?.split(","),
          since: c.req.query("since"),
          limit: c.req.query("limit") ? parseInt(c.req.query("limit")!) : undefined,
          workspace: c.req.query("workspace") === "true"
        };

        const items = await library.list(options);
        return c.json(items);
      } catch (error) {
        return c.json({ 
          error: `Failed to list library items: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });

    // Get specific library item
    this.app.get("/library/:itemId", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const itemId = c.req.param("itemId");
        const result = await library.get(itemId);

        if (!result) {
          return c.json({ error: `Library item not found: ${itemId}` }, 404);
        }

        // Return metadata by default, content only if requested
        const includeContent = c.req.query("content") === "true";
        
        if (includeContent) {
          return c.json({
            item: result.item,
            content: typeof result.content === "string" ? result.content : "[Binary Content]"
          });
        } else {
          return c.json(result.item);
        }
      } catch (error) {
        return c.json({ 
          error: `Failed to get library item: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });

    // Search library
    this.app.get("/library/search", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const query = {
          query: c.req.query("q"),
          type: c.req.query("type"),
          tags: c.req.query("tags")?.split(","),
          since: c.req.query("since"),
          until: c.req.query("until"),
          limit: c.req.query("limit") ? parseInt(c.req.query("limit")!) : undefined,
          offset: c.req.query("offset") ? parseInt(c.req.query("offset")!) : undefined,
          workspace: c.req.query("workspace") === "true"
        };

        const results = await library.search(query);
        return c.json(results);
      } catch (error) {
        return c.json({ 
          error: `Search failed: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });

    // List available templates
    this.app.get("/library/templates", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const filter = {
          workspace: c.req.query("workspace") === "true",
          platform: c.req.query("platform") === "true"
        };

        const templates = library.getTemplates(filter);
        return c.json(templates);
      } catch (error) {
        return c.json({ 
          error: `Failed to get templates: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });

    // Generate report from template
    this.app.post("/library/generate", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const { template, data, store, tags, name, description } = await c.req.json();

        if (!template || !data) {
          return c.json({ error: "template and data are required" }, 400);
        }

        const result = await library.generateReport(template, data, {
          store: store || false,
          tags,
          name,
          description
        });

        return c.json(result);
      } catch (error) {
        return c.json({ 
          error: `Report generation failed: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });

    // Get library statistics
    this.app.get("/library/stats", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const stats = await library.getStats();
        return c.json(stats);
      } catch (error) {
        return c.json({ 
          error: `Failed to get stats: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });

    // Delete library item
    this.app.delete("/library/:itemId", async (c) => {
      try {
        const library = this.runtime.getLibrary?.();
        if (!library) {
          return c.json({ error: "Library not available" }, 503);
        }

        const itemId = c.req.param("itemId");
        const success = await library.delete(itemId);

        if (!success) {
          return c.json({ error: `Failed to delete library item: ${itemId}` }, 404);
        }

        return c.json({ message: "Library item deleted successfully" });
      } catch (error) {
        return c.json({ 
          error: `Delete failed: ${error instanceof Error ? error.message : String(error)}` 
        }, 500);
      }
    });
  }

  private server: any = null;

  private isShuttingDown = false;

  private setupSignalHandlers() {
    const serverId = crypto.randomUUID().slice(0, 8);
    const handleShutdown = async () => {
      // Prevent duplicate shutdown execution
      if (this.isShuttingDown) {
        return;
      }
      this.isShuttingDown = true;

      logger.info(`Server [${serverId}] shutting down gracefully`, {
        workspaceId: (this.runtime as any).workspace?.id,
        serverId,
      });

      if (this.server && this.server.shutdown) {
        await this.server.shutdown();
      }

      await this.runtime.shutdown();
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", handleShutdown);
    Deno.addSignalListener("SIGTERM", handleShutdown);
  }

  async start() {
    const port = this.options.port || 8080;
    const hostname = this.options.hostname || "localhost";

    logger.info(`Starting server on http://${hostname}:${port}`, {
      hostname,
      port,
      workspaceId: (this.runtime as any).workspace?.id,
    });

    this.server = Deno.serve({
      port,
      hostname,
      onListen: ({ hostname, port }) => {
        logger.info(`Server running on http://${hostname}:${port}`, {
          hostname,
          port,
          workspaceId: (this.runtime as any).workspace?.id,
        });
      },
    }, this.app.fetch);

    await this.server.finished;
  }

  async shutdown(): Promise<void> {
    if (this.server && this.server.shutdown) {
      await this.server.shutdown();
    }
    await this.runtime.shutdown();
  }
}
