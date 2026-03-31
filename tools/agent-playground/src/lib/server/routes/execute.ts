import { bundledAgents } from "@atlas/bundled-agents";
import { enterTraceScope, type TraceEntry } from "@atlas/llm";
import { logger } from "@atlas/logger/console";
import { createMCPTools } from "@atlas/mcp";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { DAEMON_BASE_URL } from "../../daemon-url.ts";
import { PlaygroundContextAdapter } from "../lib/context.ts";
import { createSSEStream } from "../lib/sse.ts";

const ExecuteBody = z.object({
  agentId: z.string().min(1),
  input: z.string(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * POST /api/execute — execute a bundled agent and stream results via SSE.
 *
 * Connects to the daemon's MCP endpoint to provide platform tools
 * (artifacts_create, artifacts_get, etc.) so agents can create and
 * read artifacts during execution.
 */
export const executeRoute = new Hono().post("/", zValidator("json", ExecuteBody), (c) => {
  const { agentId, input, env } = c.req.valid("json");

  const agent = bundledAgents.find((a) => a.metadata.id === agentId);
  if (!agent) {
    return c.json({ error: `Agent "${agentId}" not found` }, 404);
  }

  return createSSEStream(async (emitter, signal) => {
    // Connect to the daemon's MCP server for platform tools
    const { tools, dispose } = await createMCPTools(
      { "atlas-platform": { transport: { type: "http", url: `${DAEMON_BASE_URL}/mcp` } } },
      logger,
      { signal },
    );

    try {
      const adapter = new PlaygroundContextAdapter();
      const { context } = adapter.createContext({
        tools,
        env,
        onStream: (chunk) => emitter.progress(chunk),
        onLog: (entry) => emitter.log(entry),
        abortSignal: signal,
      });

      const traces: TraceEntry[] = [];
      const startTime = performance.now();

      const result = await enterTraceScope(traces, () => agent.execute(input, context));

      const durationMs = Math.round(performance.now() - startTime);

      // Emit traces for the inspector panel
      for (const trace of traces) {
        emitter.trace({
          spanId: crypto.randomUUID(),
          name: `${trace.type}:${trace.modelId}`,
          durationMs: Math.round(trace.endMs - trace.startMs),
          modelId: trace.modelId,
          usage: trace.usage,
        });
      }

      emitter.result(result);

      const totalTokens = traces.reduce((sum, t) => sum + t.usage.inputTokens + t.usage.outputTokens, 0);
      emitter.done({
        durationMs,
        totalTokens: totalTokens || undefined,
        stepCount: traces.length || undefined,
      });
    } finally {
      await dispose();
    }
  });
});
