import { bundledAgents } from "@atlas/bundled-agents";
import { enterTraceScope, type TraceEntry } from "@atlas/llm";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { PlaygroundContextAdapter } from "../lib/context.ts";
import { createSSEStream } from "../lib/sse.ts";

const ExecuteBody = z.object({
  agentId: z.string().min(1),
  input: z.string(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * POST /api/execute — execute a bundled agent and stream results via SSE.
 */
export const executeRoute = new Hono().post("/", zValidator("json", ExecuteBody), (c) => {
  const { agentId, input, env } = c.req.valid("json");

  const agent = bundledAgents.find((a) => a.metadata.id === agentId);
  if (!agent) {
    return c.json({ error: `Agent "${agentId}" not found` }, 404);
  }

  return createSSEStream(async (emitter, signal) => {
    const adapter = new PlaygroundContextAdapter();
    const { context } = adapter.createContext({
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

    const totalTokens = traces.reduce((sum, t) => sum + t.usage.totalTokens, 0);
    emitter.done({
      durationMs,
      totalTokens: totalTokens || undefined,
      stepCount: traces.length || undefined,
    });
  });
});

