/**
 * POST /api/agents/:id/run — Execute a registered NATS subprocess agent directly.
 *
 * Streams SSE events matching the playground workbench format:
 *   progress, result, done, error
 *
 * When `?workspaceId=X` is provided, the agent runs against that workspace's
 * MCP servers (workspace-level + agent decorator-level), mirroring the
 * production code-agent path in `packages/workspace/src/runtime.ts`. Without
 * `workspaceId`, MCP is disabled — useful for validating pure-logic agents.
 */

import { join } from "node:path";
import type { MCPServerConfig } from "@atlas/agent-sdk";
import { UserAdapter } from "@atlas/core/agent-loader";
import { applyPlatformEnv } from "@atlas/core/mcp-registry/discovery";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { createLogger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { getFridayHome } from "@atlas/utils/paths.server";
import { createBashTool } from "@atlas/workspace/bash-tool";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const logger = createLogger({ name: "agent-run-api" });

const RunRequestSchema = z.object({
  input: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
});

const RunQuerySchema = z.object({ workspaceId: z.string().optional() });

export const runAgentRoute = daemonFactory.createApp();

runAgentRoute.post(
  "/:id/run",
  zValidator("query", RunQuerySchema),
  zValidator("json", RunRequestSchema),
  async (c) => {
    const { id } = c.req.param();
    const { workspaceId } = c.req.valid("query");
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

    // When a workspaceId is supplied, resolve the merged MCP config the same way
    // the production runtime does (workspace.tools.mcp.servers + agent decorator
    // mcp + atlas-platform). Validate the workspace exists upfront so we fail
    // before opening the SSE stream.
    let mcpConfigs: Record<string, MCPServerConfig> | undefined;
    if (workspaceId) {
      const manager = c.get("app").daemon.getWorkspaceManager();
      const merged = await manager.getWorkspaceConfig(workspaceId);
      if (!merged) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      mcpConfigs = buildMcpConfigs(merged.workspace, agentSource.metadata.mcp);
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

        let mcpResult: Awaited<ReturnType<typeof createMCPTools>> | undefined;

        try {
          const startTime = performance.now();

          if (mcpConfigs) {
            mcpResult = await createMCPTools(mcpConfigs, logger, {
              signal: AbortSignal.timeout(30000),
            });
            // Match runtime.ts: code agents get a built-in bash tool.
            mcpResult.tools.bash = createBashTool();
          }

          const tools = mcpResult?.tools ?? {};
          const mcpToolCall = mcpResult
            ? async (name: string, args: Record<string, unknown>) => {
                const tool = tools[name];
                if (!tool?.execute) throw new Error(`Unknown tool: ${name}`);
                return await tool.execute(args, { toolCallId: crypto.randomUUID(), messages: [] });
              }
            : () => Promise.reject(new Error("MCP tools not available in direct run"));
          const mcpListTools = mcpResult
            ? () =>
                Promise.resolve(
                  Object.entries(tools).map(([name, tool]) => ({
                    name,
                    description: tool.description ?? "",
                    inputSchema: tool.inputSchema,
                  })),
                )
            : () => Promise.resolve([]);

          const result = await executor.execute(agentPath, input, {
            logger,
            streamEmitter: { emit: (chunk) => enqueue("progress", chunk) },
            mcpToolCall,
            mcpListTools,
            sessionContext: { id: sessionId, workspaceId: workspaceId ?? "playground" },
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
          if (mcpResult) {
            await mcpResult.dispose().catch(() => {});
          }
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
  },
);

/**
 * Mirror `packages/workspace/src/runtime.ts` MCP config assembly: atlas-platform
 * + workspace.tools.mcp.servers + agent decorator mcp, with `applyPlatformEnv`
 * sourced from the registry. Direct iteration (no `discoverMCPServers` /
 * `configured` filter) gives byte-for-byte production fidelity — including
 * brittleness when a workspace server has missing credentials.
 */
function buildMcpConfigs(
  workspace: import("@atlas/config").WorkspaceConfig,
  agentMcp: Record<string, MCPServerConfig> | undefined,
): Record<string, MCPServerConfig> {
  const configs: Record<string, MCPServerConfig> = {
    "atlas-platform": getAtlasPlatformServerConfig(),
  };

  const workspaceServers = workspace.tools?.mcp?.servers;
  if (workspaceServers) {
    for (const [serverId, config] of Object.entries(workspaceServers)) {
      if (serverId === "atlas-platform") continue;
      const registryEntry = mcpServersRegistry.servers[serverId];
      configs[serverId] = registryEntry?.platformEnv
        ? applyPlatformEnv(config, registryEntry.platformEnv)
        : config;
    }
  }

  if (agentMcp) {
    for (const [serverId, config] of Object.entries(agentMcp)) {
      const registryEntry = mcpServersRegistry.servers[serverId];
      configs[serverId] = registryEntry?.platformEnv
        ? applyPlatformEnv(config, registryEntry.platformEnv)
        : config;
    }
  }

  return configs;
}
