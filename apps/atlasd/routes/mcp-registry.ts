import { fetchReadme } from "@atlas/core/mcp-registry/readme-fetcher";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { translate } from "@atlas/core/mcp-registry/translator";
import { MCPUpstreamClient } from "@atlas/core/mcp-registry/upstream-client";
import { createLogger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const logger = createLogger({ name: "mcp-registry-routes" });

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

/**
 * Schema for install request from registry.
 */
const InstallRequestSchema = z.object({ registryName: z.string().min(1) });

/**
 * Schema for search query parameters.
 */
const SearchQuerySchema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Create upstream client (can be mocked for tests).
 */
function createUpstreamClient(): MCPUpstreamClient {
  return new MCPUpstreamClient();
}

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
  .get("/search", zValidator("query", SearchQuerySchema), async (c) => {
    const { q, limit } = c.req.valid("query");
    const client = createUpstreamClient();
    const adapter = await getMCPRegistryAdapter();

    try {
      const searchResult = await client.search(q, limit);
      const dynamicServers = await adapter.list();

      // Build set of installed canonical names for quick lookup
      const installedCanonicalNames = new Set(
        dynamicServers
          .filter((s) => s.upstream?.canonicalName)
          .map((s) => s.upstream!.canonicalName),
      );

      const servers = searchResult.servers.map((entry) => ({
        ...entry.server,
        vendor: entry.server.name.split("/")[0] ?? entry.server.name,
        alreadyInstalled: installedCanonicalNames.has(entry.server.name),
        repositoryUrl: entry.server.repository?.url ?? null,
      }));

      return c.json({ servers });
    } catch (error) {
      logger.error("upstream search failed", { error, q, limit });
      return c.json({ error: "Search failed" }, 502);
    }
  })
  .post("/install", zValidator("json", InstallRequestSchema), async (c) => {
    const { registryName } = c.req.valid("json");
    const client = createUpstreamClient();
    const adapter = await getMCPRegistryAdapter();

    try {
      // Fetch latest version from upstream
      const upstreamEntry = await client.fetchLatest(registryName);

      // Translate to MCPServerMetadata
      const translateResult = translate(upstreamEntry);
      if (!translateResult.success) {
        return c.json({ error: translateResult.reason }, 400);
      }

      const entry = translateResult.entry;

      // Check blessed collision
      if (mcpServersRegistry.servers[entry.id]) {
        return c.json(
          { error: `Server ID "${entry.id}" collides with blessed registry entry "${entry.id}".` },
          409,
        );
      }

      // Check if already installed (dynamic collision)
      const existingDynamic = await adapter.get(entry.id);
      if (existingDynamic) {
        return c.json(
          {
            error: `Server "${entry.id}" (canonical: "${entry.upstream?.canonicalName}") is already installed from registry.`,
            existingId: entry.id,
          },
          409,
        );
      }

      // Check for same canonical name already installed under different ID
      const dynamicServers = await adapter.list();
      const existingByCanonical = dynamicServers.find(
        (s) => s.upstream?.canonicalName === entry.upstream?.canonicalName,
      );
      if (existingByCanonical) {
        return c.json(
          {
            error: `Server with canonical name "${entry.upstream?.canonicalName}" is already installed as "${existingByCanonical.id}".`,
            existingId: existingByCanonical.id,
          },
          409,
        );
      }

      // Fetch README from the upstream repository (best-effort, non-blocking on failure)
      const repoUrl = upstreamEntry.server.repository?.url;
      const subfolder = upstreamEntry.server.repository?.subfolder;
      if (repoUrl) {
        try {
          const readme = await fetchReadme(repoUrl, subfolder);
          if (readme) {
            entry.readme = readme;
          }
        } catch {
          logger.debug("readme fetch failed, continuing without", { registryName, repoUrl });
        }
      }

      // Persist the entry
      await adapter.add(entry);

      return c.json({ server: entry }, 201);
    } catch (error) {
      logger.error("install failed", { error, registryName });
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: `Server "${registryName}" not found in registry.` }, 404);
      }
      return c.json({ error: "Install failed" }, 502);
    }
  })
  .get(
    "/:id/check-update",
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
      const adapter = await getMCPRegistryAdapter();

      // Get stored entry
      const storedEntry = await adapter.get(id);
      if (!storedEntry) {
        return c.json({ error: "Server not found" }, 404);
      }

      // Check if it has upstream provenance
      if (!storedEntry.upstream?.canonicalName) {
        return c.json({ hasUpdate: false, reason: "Server was not installed from registry." }, 200);
      }

      const client = createUpstreamClient();

      try {
        // Fetch latest from upstream
        const upstreamEntry = await client.fetchLatest(storedEntry.upstream.canonicalName);
        const remoteUpdatedAt =
          upstreamEntry._meta["io.modelcontextprotocol.registry/official"].updatedAt;
        const storedUpdatedAt = storedEntry.upstream.updatedAt;

        const remoteTime = Date.parse(remoteUpdatedAt);
        const storedTime = Date.parse(storedUpdatedAt);

        if (isNaN(remoteTime) || isNaN(storedTime)) {
          return c.json({ hasUpdate: false, reason: "Unable to compare version timestamps." }, 200);
        }

        if (remoteTime > storedTime) {
          return c.json({
            hasUpdate: true,
            remote: { updatedAt: remoteUpdatedAt, version: upstreamEntry.server.version },
          });
        }

        return c.json({ hasUpdate: false, reason: "Server is up to date." });
      } catch (error) {
        logger.error("check-update failed", { error, id });
        return c.json({ hasUpdate: false, reason: "Failed to check for updates." }, 200);
      }
    },
  )
  .post(
    "/:id/update",
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
      const adapter = await getMCPRegistryAdapter();

      // Get stored entry
      const storedEntry = await adapter.get(id);
      if (!storedEntry) {
        return c.json({ error: "Server not found" }, 404);
      }

      // Check if it has upstream provenance
      if (!storedEntry.upstream?.canonicalName) {
        return c.json({ error: "Server was not installed from registry." }, 400);
      }

      const client = createUpstreamClient();

      try {
        // Fetch latest from upstream
        const upstreamEntry = await client.fetchLatest(storedEntry.upstream.canonicalName);

        // Re-translate
        const translateResult = translate(upstreamEntry);
        if (!translateResult.success) {
          return c.json({ error: `Translation failed: ${translateResult.reason}` }, 400);
        }

        // Preserve the stored ID (don't let re-translation change it)
        // Update all fields except id and source per adapter contract
        const { id: _newId, source: _newSource, ...updatableFields } = translateResult.entry;

        // Re-fetch README on update (best-effort)
        const repoUrl = upstreamEntry.server.repository?.url;
        const subfolder = upstreamEntry.server.repository?.subfolder;
        if (repoUrl) {
          try {
            const readme = await fetchReadme(repoUrl, subfolder);
            if (readme) {
              (updatableFields as Record<string, unknown>).readme = readme;
            }
          } catch {
            logger.debug("readme re-fetch failed on update, keeping existing", { id, repoUrl });
          }
        }

        const updatedEntry = await adapter.update(storedEntry.id, updatableFields);
        if (!updatedEntry) {
          return c.json({ error: "Server was modified concurrently." }, 409);
        }

        return c.json({ server: updatedEntry });
      } catch (error) {
        logger.error("pull-update failed", { error, id });
        return c.json({ error: "Update failed" }, 502);
      }
    },
  )
  .delete(
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

      // Static entries cannot be deleted
      if (mcpServersRegistry.servers[id]) {
        return c.json({ error: `Built-in server "${id}" cannot be deleted.` }, 403);
      }

      const adapter = await getMCPRegistryAdapter();
      const dynamicServer = await adapter.get(id);
      if (!dynamicServer) {
        return c.json({ error: "Server not found" }, 404);
      }

      await adapter.delete(id);
      return new Response(null, { status: 204 });
    },
  )
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
