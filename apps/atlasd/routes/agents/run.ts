/**
 * POST /api/agents/:id/run — Execute a registered NATS subprocess agent directly.
 *
 * Streams SSE events matching the playground workbench format:
 *   progress, result, done, error
 */

import { join } from "node:path";
import { UserAdapter } from "@atlas/core/agent-loader";
import { createLogger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const logger = createLogger({ name: "agent-run-api" });

const RunRequestSchema = z.object({
  input: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
});

export const runAgentRoute = daemonFactory.createApp();

runAgentRoute.post("/:id/run", zValidator("json", RunRequestSchema), async (c) => {
  const { id } = c.req.param();
  const { input, env } = c.req.valid("json");

  const executor = c.get("app").daemon.getProcessAgentExecutor();
  if (!executor) {
    return c.json({ error: "NATS not ready" }, 503);
  }

  const adapter = new UserAdapter(join(getFridayHome(), "agents"));
  const agentSource = await adapter.loadAgent(id).catch(() => null);
  if (!agentSource) {
    return c.json({ error: `Agent "${id}" not found` }, 404);
  }
  if (!agentSource.metadata.entrypoint) {
    return c.json({ error: `Agent "${id}" is not a subprocess agent (no entrypoint)` }, 400);
  }

  const agentPath = join(agentSource.metadata.sourceLocation, agentSource.metadata.entrypoint);
  const sessionId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function enqueue(event: string, data: unknown): void {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const startTime = performance.now();

        const result = await executor.execute(agentPath, input, {
          logger,
          streamEmitter: { emit: (chunk) => enqueue("progress", chunk) },
          mcpToolCall: () => Promise.reject(new Error("MCP tools not available in direct run")),
          mcpListTools: () => Promise.resolve([]),
          sessionContext: { id: sessionId, workspaceId: "playground" },
          agentLlmConfig: agentSource.metadata.llm,
          env,
        });

        if (result.ok) {
          enqueue("result", result.data);
        } else {
          enqueue("error", { error: result.error.reason });
        }

        enqueue("done", { durationMs: Math.round(performance.now() - startTime) });
      } catch (err) {
        logger.error("agent run failed", { agentId: id, sessionId, error: err });
        enqueue("error", { error: err instanceof Error ? err.message : String(err) });
      } finally {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
