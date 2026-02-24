import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

/**
 * Schema for creating new MCP registry entries.
 * Extends MCPServerMetadataSchema with stricter validation for user input:
 * - id: lowercase alphanumeric with dashes, max 64 chars
 * - name: 1-100 chars
 * - source: excludes "static" (reserved for blessed registry)
 *
 * Breaking change (improve-agent-selection): `domains` field removed from
 * MCPServerMetadataSchema. Use `urlDomains` for URL-to-server mapping.
 * Zod v4 strips unknown keys silently — clients sending `domains` won't error
 * but the field is ignored. Web client verified clean (no `domains` usage).
 */
const CreateEntrySchema = z.object({
  entry: MCPServerMetadataSchema.extend({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/)
      .max(64),
    name: z.string().min(1).max(100),
    source: z.enum(["web", "agents"]), // "static" reserved for blessed registry
  }),
});

export const mcpRegistryRouter = daemonFactory
  .createApp()
  .post("/", zValidator("json", CreateEntrySchema), async (c) => {
    const { entry } = c.req.valid("json");
    const adapter = await getMCPRegistryAdapter();

    // Check blessed first - these are static and can't be overwritten
    if (mcpServersRegistry.servers[entry.id]) {
      return c.json(
        { error: `Server "${entry.id}" exists in blessed registry. Use it instead.` },
        409,
      );
    }

    // Atomic add - throws if entry already exists
    try {
      await adapter.add(entry);
      return c.json({ server: entry }, 201);
    } catch {
      const suggested = `${entry.id}-${Date.now().toString(36).slice(-4)}`;
      return c.json({ error: `Server ID "${entry.id}" already used.`, suggestion: suggested }, 409);
    }
  })
  .get("/", async (c) => {
    const adapter = await getMCPRegistryAdapter();
    const dynamicServers = await adapter.list();
    const staticServers = Object.values(mcpServersRegistry.servers);

    const staticIds = new Set(staticServers.map((s) => s.id));
    const uniqueDynamic = dynamicServers.filter((s) => !staticIds.has(s.id));

    return c.json({
      servers: [...staticServers, ...uniqueDynamic],
      metadata: {
        version: mcpServersRegistry.metadata.version,
        staticCount: staticServers.length,
        dynamicCount: uniqueDynamic.length,
      },
    });
  })
  .get(
    "/:id",
    zValidator(
      "param",
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");

      const staticServer = mcpServersRegistry.servers[id];
      if (staticServer) {
        return c.json(staticServer);
      }

      const adapter = await getMCPRegistryAdapter();
      const dynamicServer = await adapter.get(id);
      if (dynamicServer) {
        return c.json(dynamicServer);
      }

      return c.json({ error: "Server not found" }, 404);
    },
  );

export type MCPRegistryRoutes = typeof mcpRegistryRouter;
