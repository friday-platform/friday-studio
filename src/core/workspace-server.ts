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
      if (
        (signal.provider === "http" && signal.path) ||
        (signal.provider === "http-webhook" && signal.endpoint)
      ) {
        const method = (signal.method || "POST").toLowerCase();
        const path = signal.path || signal.endpoint;

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
