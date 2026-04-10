import type { MCPServerConfig } from "@atlas/config";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { logger } from "@atlas/logger/console";
import { createMCPTools } from "@atlas/mcp";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

/**
 * Resolves a registry configTemplate.env into plain string env vars
 * using user-provided values. Registry env entries can be:
 * - String literals (e.g. "your-api-key") — replaced by user value if provided
 * - Link credential refs (e.g. { from: "link", ... }) — replaced by user value for the same key
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

const PostToolsSchema = z.object({
  serverIds: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()),
});

/**
 * MCP server routes for the agent playground.
 *
 * GET  / — list available MCP servers from the registry
 * POST /tools — start servers in-process, fetch tool definitions, dispose
 */
export const mcpRoute = new Hono()
  .get("/servers", (c) => {
    try {
      const servers = Object.values(mcpServersRegistry.servers).map((server) => ({
        id: server.id,
        name: server.name,
        description: server.description ?? "",
        transportType: server.configTemplate.transport.type,
        requiredConfig: (server.requiredConfig ?? []).map((field) => ({
          key: field.key,
          description: field.description,
        })),
      }));

      return c.json(servers);
    } catch (error) {
      logger.error("Failed to list MCP servers", { error });
      return c.json({ error: "Failed to list MCP servers" }, 500);
    }
  })
  .post("/tools", zValidator("json", PostToolsSchema), async (c) => {
    const { serverIds, env: userEnv } = c.req.valid("json");
    const { servers } = mcpServersRegistry;

    // Validate all requested servers exist and have required env vars
    const unknownIds = serverIds.filter((id) => !servers[id]);
    if (unknownIds.length > 0) {
      return c.json({ error: `Unknown server IDs: ${unknownIds.join(", ")}` }, 400);
    }

    // Check for missing required env vars across all requested servers
    const missingByServer: Array<{ serverId: string; missing: string[] }> = [];
    for (const id of serverIds) {
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

    // Build MCPServerConfig map from registry metadata + user env
    const configs: Record<string, MCPServerConfig> = {};
    for (const id of serverIds) {
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

    // Connect, fetch tools, dispose
    try {
      const { tools: toolsRecord, dispose } = await createMCPTools(configs, logger);
      const tools: Array<{ name: string; description: string; inputSchema: unknown }> = [];

      try {
        for (const [name, tool] of Object.entries(toolsRecord)) {
          tools.push({
            name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema ?? {},
          });
        }
      } finally {
        await dispose();
      }

      return c.json({ tools });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to connect to MCP servers", { error, serverIds });
      return c.json({ error: `Failed to connect to MCP servers: ${message}` }, 500);
    }
  });
