import { join } from "node:path";
import { bundledAgents } from "@atlas/bundled-agents";
import { UserAdapter } from "@atlas/core/agent-loader";
import { enterTraceScope, type TraceEntry } from "@atlas/llm";
import { logger } from "@atlas/logger/console";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { getFridayHome } from "@atlas/utils/paths.server";
import { parseSSEEvents } from "@atlas/utils/sse";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
// Match the resolution used by static-server.ts and routes/discover.ts —
// the launcher exports FRIDAYD_URL in .env at the configured FRIDAY_PORT_FRIDAY
// (which is 18080 in FAST/LINK_DEV mode, not 8080). Without this read, the
// playground binary running on a non-default port silently posts user-agent
// runs to :8080 and reports "Connection refused".
const DAEMON_BASE_URL = process.env.FRIDAYD_URL ?? "http://localhost:8080";
import { PlaygroundContextAdapter } from "../lib/context.ts";
import { createSSEStream } from "../lib/sse.ts";
import { userAgentExists } from "../lib/user-agents.ts";

const ExecuteBody = z.object({
  agentId: z.string().min(1),
  input: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  workspaceId: z.string().optional(),
});

/**
 * POST /api/execute — execute a bundled agent and stream results via SSE.
 *
 * Connects to the daemon's MCP endpoint to provide platform tools
 * (artifacts_create, artifacts_get, etc.) so agents can create and
 * read artifacts during execution.
 */
export const executeRoute = new Hono().post("/", zValidator("json", ExecuteBody), async (c) => {
  const { agentId, input, env, workspaceId } = c.req.valid("json");

  // User agents proxy to daemon via NATS subprocess protocol
  if (await userAgentExists(agentId)) {
    const adapter = new UserAdapter(join(getFridayHome(), "agents"));
    const agentSource = await adapter.loadAgent(agentId);
    if (!agentSource.metadata.entrypoint) {
      return c.json({ error: `Agent "${agentId}" has no entrypoint` }, 400);
    }
    // Relay SSE events from daemon — raw Response passthrough is silently buffered by Hono
    return createSSEStream(async (emitter, signal) => {
      const url = workspaceId
        ? `${DAEMON_BASE_URL}/api/agents/${agentId}/run?workspaceId=${encodeURIComponent(workspaceId)}`
        : `${DAEMON_BASE_URL}/api/agents/${agentId}/run`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, env }),
        signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(text);
      }
      for await (const msg of parseSSEEvents(res.body)) {
        emitter.send(msg.event ?? "message", msg.data);
      }
    });
  }

  const agent = bundledAgents.find((a) => a.metadata.id === agentId);
  if (!agent) {
    return c.json({ error: `Agent "${agentId}" not found` }, 404);
  }

  return createSSEStream(async (emitter, signal) => {
    // Connect to the daemon's MCP server for platform tools
    const { tools, dispose } = await createMCPTools(
      { "atlas-platform": getAtlasPlatformServerConfig() },
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
