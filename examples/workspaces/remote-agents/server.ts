import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";

import type {
  ACPError,
  Agent,
  AgentsListResponse,
  Event,
  Message,
  Run,
  RunCreateRequest,
  RunEventsListResponse,
  RunResumeRequest,
  RunStatus,
  Session,
} from "./types.ts";
import { getAgent, listAgents } from "./agents.ts";

// In-memory storage for runs and sessions
const runs = new Map<string, Run>();
const sessions = new Map<string, Session>();
const runEvents = new Map<string, Event[]>();

// Helper function to generate UUIDs
function generateUUID(): string {
  return crypto.randomUUID();
}

// Helper function to create ACP errors
function createError(code: ACPError["code"], message: string): ACPError {
  return { code, message };
}

// Helper function to validate agent name format
function validateAgentName(name: string): boolean {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) && name.length >= 1 && name.length <= 63;
}

const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());
app.use("*", prettyJSON());

// Error handler
app.onError((err, c) => {
  console.error("Server error:", err);

  if (err instanceof HTTPException) {
    return c.json(
      createError("server_error", err.message),
      err.status,
    );
  }

  return c.json(
    createError("server_error", "Internal server error"),
    500,
  );
});

// Health check endpoint
app.get("/ping", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Agent discovery
app.get("/agents", (c) => {
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
app.get("/agents/:name", (c) => {
  const name = c.req.param("name");

  if (!validateAgentName(name)) {
    throw new HTTPException(400, {
      message: JSON.stringify(createError("invalid_input", "Invalid agent name format")),
    });
  }

  const agent = getAgent(name);
  if (!agent) {
    throw new HTTPException(404, {
      message: JSON.stringify(createError("not_found", `Agent '${name}' not found`)),
    });
  }

  return c.json(agent.getMetadata());
});

// Create run
app.post("/runs", async (c) => {
  try {
    const body = await c.req.json() as RunCreateRequest;

    // Validate request
    if (!body.agent_name || !body.input || !Array.isArray(body.input) || body.input.length === 0) {
      throw new HTTPException(400, {
        message: JSON.stringify(
          createError("invalid_input", "Missing or invalid required fields: agent_name, input"),
        ),
      });
    }

    if (!validateAgentName(body.agent_name)) {
      throw new HTTPException(400, {
        message: JSON.stringify(createError("invalid_input", "Invalid agent name format")),
      });
    }

    // Check if agent exists
    const agent = getAgent(body.agent_name);
    if (!agent) {
      throw new HTTPException(404, {
        message: JSON.stringify(createError("not_found", `Agent '${body.agent_name}' not found`)),
      });
    }

    // Create session if needed
    let sessionId = body.session_id;
    if (!sessionId) {
      sessionId = generateUUID();
      sessions.set(sessionId, {
        id: sessionId,
        history: [],
      });
    }

    const runId = generateUUID();
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

    runs.set(runId, run);
    runEvents.set(runId, []);

    // Add initial events
    const events = runEvents.get(runId)!;
    events.push({
      type: "run.created",
      run: { ...run },
    });

    // Handle different modes
    if (mode === "stream") {
      // Return streaming response
      run.status = "in-progress";
      runs.set(runId, run);

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
          runs.set(runId, run);

          const completedEvent = {
            type: "run.completed" as const,
            run: { ...run },
          };
          events.push(completedEvent);

          await stream.writeSSE({
            data: JSON.stringify(completedEvent),
          });
        } catch (error) {
          run.status = "failed";
          run.error = createError(
            "server_error",
            error instanceof Error ? error.message : "Unknown error",
          );
          run.finished_at = new Date().toISOString();
          runs.set(runId, run);

          const failedEvent = {
            type: "run.failed" as const,
            run: { ...run },
          };
          events.push(failedEvent);

          await stream.writeSSE({
            data: JSON.stringify(failedEvent),
          });
        }
      });
    } else {
      // Sync and async modes
      if (mode === "async") {
        // Return immediately for async
        run.status = "in-progress";
        runs.set(runId, run);

        events.push({
          type: "run.in-progress",
          run: { ...run },
        });

        // Process in background
        (async () => {
          try {
            const output = await agent.processMessage(body.input);
            run.status = "completed";
            run.output = output;
            run.finished_at = new Date().toISOString();
            runs.set(runId, run);

            events.push({
              type: "run.completed",
              run: { ...run },
            });
          } catch (error) {
            run.status = "failed";
            run.error = createError(
              "server_error",
              error instanceof Error ? error.message : "Unknown error",
            );
            run.finished_at = new Date().toISOString();
            runs.set(runId, run);

            events.push({
              type: "run.failed",
              run: { ...run },
            });
          }
        })();

        return c.json(run, 202);
      } else {
        // Sync mode - process immediately
        try {
          run.status = "in-progress";
          runs.set(runId, run);

          events.push({
            type: "run.in-progress",
            run: { ...run },
          });

          const output = await agent.processMessage(body.input);
          run.status = "completed";
          run.output = output;
          run.finished_at = new Date().toISOString();
          runs.set(runId, run);

          events.push({
            type: "run.completed",
            run: { ...run },
          });

          return c.json(run);
        } catch (error) {
          run.status = "failed";
          run.error = createError(
            "server_error",
            error instanceof Error ? error.message : "Unknown error",
          );
          run.finished_at = new Date().toISOString();
          runs.set(runId, run);

          events.push({
            type: "run.failed",
            run: { ...run },
          });

          return c.json(run);
        }
      }
    }
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw new HTTPException(400, {
      message: JSON.stringify(createError("invalid_input", "Invalid request body")),
    });
  }
});

// Get run status
app.get("/runs/:run_id", (c) => {
  const runId = c.req.param("run_id");

  const run = runs.get(runId);
  if (!run) {
    throw new HTTPException(404, {
      message: JSON.stringify(createError("not_found", `Run '${runId}' not found`)),
    });
  }

  return c.json(run);
});

// Resume run (placeholder - not implemented)
app.post("/runs/:run_id", async (c) => {
  const runId = c.req.param("run_id");

  const run = runs.get(runId);
  if (!run) {
    throw new HTTPException(404, {
      message: JSON.stringify(createError("not_found", `Run '${runId}' not found`)),
    });
  }

  // For this simple implementation, we don't support resuming
  throw new HTTPException(400, {
    message: JSON.stringify(createError("invalid_input", "Resume functionality not implemented")),
  });
});

// Cancel run
app.post("/runs/:run_id/cancel", (c) => {
  const runId = c.req.param("run_id");

  const run = runs.get(runId);
  if (!run) {
    throw new HTTPException(404, {
      message: JSON.stringify(createError("not_found", `Run '${runId}' not found`)),
    });
  }

  // Only cancel if not already finished
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return c.json(run, 202);
  }

  run.status = "cancelled";
  run.finished_at = new Date().toISOString();
  runs.set(runId, run);

  const events = runEvents.get(runId) || [];
  events.push({
    type: "run.cancelled",
    run: { ...run },
  });

  return c.json(run, 202);
});

// List run events
app.get("/runs/:run_id/events", (c) => {
  const runId = c.req.param("run_id");

  const run = runs.get(runId);
  if (!run) {
    throw new HTTPException(404, {
      message: JSON.stringify(createError("not_found", `Run '${runId}' not found`)),
    });
  }

  const events = runEvents.get(runId) || [];
  const response: RunEventsListResponse = {
    events,
  };

  return c.json(response);
});

// Session endpoint (placeholder)
app.get("/session/:session_id", (c) => {
  const sessionId = c.req.param("session_id");

  const session = sessions.get(sessionId);
  if (!session) {
    throw new HTTPException(404, {
      message: JSON.stringify(createError("not_found", `Session '${sessionId}' not found`)),
    });
  }

  return c.json(session);
});

// Start server
const port = parseInt(Deno.env.get("PORT") || "8000");

console.log(`🚀 ACP Example Server starting on port ${port}`);
console.log(`📡 Available endpoints:`);
console.log(`   GET  /ping                 - Health check`);
console.log(`   GET  /agents               - List agents`);
console.log(`   GET  /agents/{name}        - Get agent details`);
console.log(`   POST /runs                 - Create run`);
console.log(`   GET  /runs/{run_id}        - Get run status`);
console.log(`   POST /runs/{run_id}/cancel - Cancel run`);
console.log(`   GET  /runs/{run_id}/events - List run events`);
console.log(`\n🤖 Available agents: echo, chat`);
console.log(`\n📚 Example usage:`);
console.log(`   curl -X POST http://localhost:${port}/runs \\`);
console.log(`     -H "Content-Type: application/json" \\`);
console.log(
  `     -d '{"agent_name":"echo","input":[{"role":"user","parts":[{"content_type":"text/plain","content":"Hello!"}]}]}'`,
);

Deno.serve({ port }, app.fetch);
