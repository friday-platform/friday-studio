import type { MCPServerConfig } from "@atlas/config";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { AtlasLLMProviderAdapter } from "@atlas/fsm-engine";
import { enterTraceScope, type TraceEntry } from "@atlas/llm";
import { logger } from "@atlas/logger/console";
import { createMCPTools } from "@atlas/mcp";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { createSSEStream } from "../lib/sse.ts";

const ProviderSchema = z.enum(["anthropic", "openai", "google", "groq"]);

const CustomExecuteBody = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  systemPrompt: z.string(),
  input: z.string().min(1),
  mcpServerIds: z.array(z.string().min(1)),
  env: z.record(z.string(), z.string()),
  maxSteps: z.number().int().min(1).max(100).optional(),
});

/**
 * Resolves a registry configTemplate.env into plain string env vars
 * using user-provided values.
 */
function resolveEnv(
  templateEnv: MCPServerMetadata["configTemplate"]["env"],
  userEnv: Record<string, string>,
): Record<string, string> {
  if (!templateEnv) return {};
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(templateEnv)) {
    const userValue = userEnv[key];
    if (userValue !== undefined) {
      resolved[key] = userValue;
    }
  }
  return resolved;
}

/**
 * Checks which required env vars are missing from user-provided env.
 */
function findMissingEnvVars(server: MCPServerMetadata, userEnv: Record<string, string>): string[] {
  if (!server.requiredConfig?.length) return [];
  return server.requiredConfig.filter((field) => !userEnv[field.key]).map((field) => field.key);
}

/**
 * POST /api/custom/execute — execute a custom agent config and stream results via SSE.
 *
 * Starts MCP servers, builds an LLM adapter, executes the prompt, and streams
 * progress events. MCP connections are disposed on completion or error.
 */
export const customExecuteRoute = new Hono().post(
  "/",
  zValidator("json", CustomExecuteBody),
  (c) => {
    const {
      provider,
      model,
      systemPrompt,
      input,
      mcpServerIds,
      env: userEnv,
      maxSteps,
    } = c.req.valid("json");

    const { servers } = mcpServersRegistry;

    // Validate all requested servers exist
    const unknownIds = mcpServerIds.filter((id) => !servers[id]);
    if (unknownIds.length > 0) {
      return c.json({ error: `Unknown server IDs: ${unknownIds.join(", ")}` }, 400);
    }

    // Check for missing required env vars
    const missingByServer: Array<{ serverId: string; missing: string[] }> = [];
    for (const id of mcpServerIds) {
      const server = servers[id];
      if (!server) continue;
      const missing = findMissingEnvVars(server, userEnv);
      if (missing.length > 0) {
        missingByServer.push({ serverId: id, missing });
      }
    }
    if (missingByServer.length > 0) {
      const details = missingByServer
        .map((e) => `${e.serverId}: ${e.missing.join(", ")}`)
        .join("; ");
      return c.json({ error: `Missing required env vars — ${details}` }, 400);
    }

    return createSSEStream(async (emitter, signal) => {
      // Build MCPServerConfig map from registry metadata + user env
      const configs: Record<string, MCPServerConfig> = {};
      for (const id of mcpServerIds) {
        const server = servers[id];
        if (!server) continue;
        const template = server.configTemplate;
        const resolvedEnv = resolveEnv(template.env, userEnv);
        configs[id] = {
          transport: template.transport,
          auth: template.auth,
          tools: template.tools,
          env: resolvedEnv,
        };
      }

      const { tools, dispose } = await createMCPTools(configs, logger, { signal });

      try {
        // Build the LLM adapter
        const adapter = new AtlasLLMProviderAdapter(model, provider, undefined, maxSteps);

        const traces: TraceEntry[] = [];
        const startTime = performance.now();

        const result = await enterTraceScope(traces, () =>
          adapter.call({
            agentId: "playground-custom",
            model,
            prompt: input,
            messages: [
              { role: "system" as const, content: systemPrompt },
              { role: "user" as const, content: input },
            ],
            tools: Object.keys(tools).length > 0 ? tools : undefined,
          }),
        );

        // Check abort before emitting final events
        if (signal.aborted) return;

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
      } finally {
        await dispose();
      }
    });
  },
);
