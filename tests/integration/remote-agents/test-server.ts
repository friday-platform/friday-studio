// ACP Integration Test Server
// Minimal ACP v0.2.0 compliant server for testing ACPAdapter

import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";

import { BaseTestServer, findAvailablePort } from "../../utils/test-utils.ts";

import type {
  ACPError,
  Agent,
  AgentsListResponse,
  Event,
  Message,
  MessagePart,
  Run,
  RunCreateRequest,
  RunEventsListResponse,
  Session,
  TestAgent,
} from "./types.ts";
import { getAgent, listAgents } from "./agents.ts";

export class ACPTestServer extends BaseTestServer {
  private app: Hono;

  // In-memory storage
  private runs = new Map<string, Run>();
  private sessions = new Map<string, Session>();
  private runEvents = new Map<string, Event[]>();
  
  // Track background operations for proper cleanup
  private backgroundOperations = new Set<Promise<void>>();

  constructor() {
    super();
    this.app = new Hono();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use("*", cors());
    this.app.onError((err, c) => {
      console.error("Server error:", err);

      if (err instanceof HTTPException) {
        return c.json(
          this.createError("server_error", err.message),
          err.status,
        );
      }

      return c.json(
        this.createError("server_error", "Internal server error"),
        500,
      );
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get("/ping", (c) => {
      return c.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    // Agent discovery
    this.app.get("/agents", (c) => {
      const limit = Math.min(parseInt(c.req.query("limit") || "10"), 1000);
      const offset = parseInt(c.req.query("offset") || "0");

      const allAgents = listAgents();
      const paginatedAgents = allAgents.slice(offset, offset + limit);

      const response: AgentsListResponse = {
        agents: paginatedAgents,
      };

      return c.json(response);
    });

    // Agent details
    this.app.get("/agents/:name", (c) => {
      const name = c.req.param("name");

      if (!this.validateAgentName(name)) {
        return c.json(
          this.createError("invalid_input", "Invalid agent name format"),
          400,
        );
      }

      const agent = getAgent(name);
      if (!agent) {
        return c.json(
          this.createError("not_found", `Agent '${name}' not found`),
          404,
        );
      }

      return c.json((agent as TestAgent).getMetadata());
    });

    // Create run
    this.app.post("/runs", async (c) => {
      try {
        const body = await c.req.json() as RunCreateRequest;

        // Validate request
        if (
          !body.agent_name || !body.input || !Array.isArray(body.input) || body.input.length === 0
        ) {
          return c.json(
            this.createError(
              "invalid_input",
              "Missing or invalid required fields: agent_name, input",
            ),
            400,
          );
        }

        if (!this.validateAgentName(body.agent_name)) {
          return c.json(
            this.createError("invalid_input", "Invalid agent name format"),
            400,
          );
        }

        // Check if agent exists
        const agent = getAgent(body.agent_name);
        if (!agent) {
          return c.json(
            this.createError("not_found", `Agent '${body.agent_name}' not found`),
            404,
          );
        }

        // Special handling for error simulation
        if (body.agent_name === "server-error") {
          return c.json(
            this.createError("server_error", "Simulated server error"),
            500,
          );
        }

        // Create session if needed
        let sessionId = body.session_id;
        if (!sessionId) {
          sessionId = this.generateUUID();
          this.sessions.set(sessionId, {
            id: sessionId,
            history: [],
          });
        }

        const runId = this.generateUUID();
        const now = new Date().toISOString();
        const mode = body.mode || "sync";

        // Create initial run
        const run: Run = {
          agent_name: body.agent_name,
          session_id: sessionId,
          run_id: runId,
          status: "created",
          output: [],
          created_at: now,
        };

        this.runs.set(runId, run);
        this.runEvents.set(runId, []);

        // Add initial events
        const events = this.runEvents.get(runId)!;
        events.push({
          type: "run.created",
          run: { ...run },
        });

        // Handle different execution modes
        if (mode === "stream") {
          return this.handleStreamMode(c, run, body, agent, events);
        } else if (mode === "async") {
          return this.handleAsyncMode(run, body, agent, events);
        } else {
          return this.handleSyncMode(run, body, agent, events);
        }
      } catch (_error) {
        return c.json(
          this.createError("invalid_input", "Invalid request body"),
          400,
        );
      }
    });

    // Get run status
    this.app.get("/runs/:run_id", (c) => {
      const runId = c.req.param("run_id");

      const run = this.runs.get(runId);
      if (!run) {
        return c.json(
          this.createError("not_found", `Run '${runId}' not found`),
          404,
        );
      }

      return c.json(run);
    });

    // Cancel run
    this.app.post("/runs/:run_id/cancel", (c) => {
      const runId = c.req.param("run_id");

      const run = this.runs.get(runId);
      if (!run) {
        return c.json(
          this.createError("not_found", `Run '${runId}' not found`),
          404,
        );
      }

      // Only cancel if not already finished
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        return c.json(run, 202);
      }

      run.status = "cancelled";
      run.finished_at = new Date().toISOString();
      this.runs.set(runId, run);

      const events = this.runEvents.get(runId) || [];
      events.push({
        type: "run.cancelled",
        run: { ...run },
      });

      return c.json(run, 202);
    });

    // List run events
    this.app.get("/runs/:run_id/events", (c) => {
      const runId = c.req.param("run_id");

      const run = this.runs.get(runId);
      if (!run) {
        return c.json(
          this.createError("not_found", `Run '${runId}' not found`),
          404,
        );
      }

      const events = this.runEvents.get(runId) || [];
      const response: RunEventsListResponse = {
        events,
      };

      return c.json(response);
    });
  }

  private handleStreamMode(
    c: any,
    run: Run,
    body: RunCreateRequest,
    agent: TestAgent,
    events: Event[],
  ) {
    run.status = "in-progress";
    this.runs.set(run.run_id, run);

    events.push({
      type: "run.in-progress",
      run: { ...run },
    });

    return streamSSE(c, async (stream) => {
      try {
        // Send initial events
        await stream.writeSSE({
          data: JSON.stringify({
            type: "run.created",
            run: { ...run },
          }),
        });

        await stream.writeSSE({
          data: JSON.stringify({
            type: "run.in-progress",
            run: { ...run },
          }),
        });

        // Process with agent streaming
        for await (const part of agent.processMessageStream(body.input)) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "message.part",
              part,
            }),
          });

          events.push({
            type: "message.part",
            part,
          });
        }

        // Complete the run
        const output = await agent.processMessage(body.input);
        run.status = "completed";
        run.output = output;
        run.finished_at = new Date().toISOString();
        this.runs.set(run.run_id, run);

        const completedEvent = {
          type: "run.completed" as const,
          run: { ...run },
        };
        events.push(completedEvent);

        await stream.writeSSE({
          data: JSON.stringify(completedEvent),
        });
        await stream.close();
      } catch (error) {
        run.status = "failed";
        run.error = this.createError(
          "server_error",
          error instanceof Error ? error.message : "Unknown error",
        );
        run.finished_at = new Date().toISOString();
        this.runs.set(run.run_id, run);

        const failedEvent = {
          type: "run.failed" as const,
          run: { ...run },
        };
        events.push(failedEvent);

        await stream.writeSSE({
          data: JSON.stringify(failedEvent),
        });
        await stream.close();
      }
    });
  }

  private handleAsyncMode(run: Run, body: RunCreateRequest, agent: TestAgent, events: Event[]) {
    run.status = "in-progress";
    this.runs.set(run.run_id, run);

    events.push({
      type: "run.in-progress",
      run: { ...run },
    });

    // Process in background and track the operation
    const backgroundOperation: Promise<void> = (async () => {
      try {
        const output = await agent.processMessage(body.input);
        run.status = "completed";
        run.output = output;
        run.finished_at = new Date().toISOString();
        this.runs.set(run.run_id, run);

        events.push({
          type: "run.completed",
          run: { ...run },
        });
      } catch (error) {
        run.status = "failed";
        run.error = this.createError(
          "server_error",
          error instanceof Error ? error.message : "Unknown error",
        );
        run.finished_at = new Date().toISOString();
        this.runs.set(run.run_id, run);

        events.push({
          type: "run.failed",
          run: { ...run },
        });
      }
    })();
    
    this.backgroundOperations.add(backgroundOperation);
    
    // Clean up when operation completes
    backgroundOperation.finally(() => {
      this.backgroundOperations.delete(backgroundOperation);
    });

    return new Response(JSON.stringify(run), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleSyncMode(
    run: Run,
    body: RunCreateRequest,
    agent: TestAgent,
    events: Event[],
  ) {
    try {
      run.status = "in-progress";
      this.runs.set(run.run_id, run);

      events.push({
        type: "run.in-progress",
        run: { ...run },
      });

      const output = await agent.processMessage(body.input);
      run.status = "completed";
      run.output = output;
      run.finished_at = new Date().toISOString();
      this.runs.set(run.run_id, run);

      events.push({
        type: "run.completed",
        run: { ...run },
      });

      return new Response(JSON.stringify(run), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      run.status = "failed";
      run.error = this.createError(
        "server_error",
        error instanceof Error ? error.message : "Unknown error",
      );
      run.finished_at = new Date().toISOString();
      this.runs.set(run.run_id, run);

      events.push({
        type: "run.failed",
        run: { ...run },
      });

      return new Response(JSON.stringify(run), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private generateUUID(): string {
    return crypto.randomUUID();
  }

  private createError(code: ACPError["code"], message: string): ACPError {
    return { code, message };
  }

  private validateAgentName(name: string): boolean {
    return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) && name.length >= 1 && name.length <= 63;
  }

  async start(): Promise<number> {
    this.port = await findAvailablePort();

    console.log(`🚀 ACP Test Server starting on port ${this.port}`);

    this.server = Deno.serve({ port: this.port }, this.app.fetch);

    // Give the server a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    return this.port;
  }

  override async stop(): Promise<void> {
    console.log("🛑 Stopping ACP Test Server...");
    
    // Wait for all background operations to complete with timeout
    if (this.backgroundOperations.size > 0) {
      console.log(`⏳ Waiting for ${this.backgroundOperations.size} background operations to complete...`);
      
      // Race against a 2-second timeout
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.log("⚠️ Background operations timeout - forcing cleanup");
          resolve();
        }, 2000);
      });
      
      await Promise.race([
        Promise.allSettled(this.backgroundOperations),
        timeoutPromise,
      ]);
      
      this.backgroundOperations.clear();
    }
    
    // Clear all storage
    this.runs.clear();
    this.sessions.clear();
    this.runEvents.clear();
    
    await super.stop();
    console.log("🛑 ACP Test Server stopped");
  }
}
