import { createLogger } from "@atlas/logger";
import { z } from "zod";
import { type MCPServerMetadata, MCPServerMetadataSchema } from "../schemas.ts";
import type { MCPRegistryStorageAdapter } from "./adapter.ts";

const CortexListResponseSchema = z.object({
  objects: z.array(z.object({ id: z.string() })).optional(),
});
const CortexCreateResponseSchema = z.object({ id: z.string() });

const logger = createLogger({ component: "mcp-registry:cortex-adapter" });

/**
 * Remote storage adapter using Cortex blob storage service.
 *
 * Uses metadata filtering:
 * - entity_type: "mcp_registry" (distinguishes from other Cortex objects)
 * - registry_id: The MCPServerMetadata.id for lookups
 * - server_name: Searchable name field
 * - source: Origin of the server entry
 */
export class CortexMCPRegistryAdapter implements MCPRegistryStorageAdapter {
  constructor(
    private baseUrl: string,
    private authToken: string,
  ) {}

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/json" };
  }

  /**
   * Find the Cortex object ID for a given registry ID.
   */
  private async findObjectByRegistryId(id: string): Promise<string | null> {
    const listRes = await fetch(
      `${this.baseUrl}/objects?metadata.entity_type=mcp_registry&metadata.registry_id=${encodeURIComponent(id)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    if (!listRes.ok) return null;

    const listData = CortexListResponseSchema.parse(await listRes.json());
    return listData.objects?.[0]?.id ?? null;
  }

  async add(entry: MCPServerMetadata): Promise<void> {
    if ((await this.get(entry.id)) !== null) {
      throw new Error(`Entry already exists: ${entry.id}`);
    }

    const createRes = await fetch(`${this.baseUrl}/objects`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content: JSON.stringify(entry) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create object: ${createRes.status}`);
    }
    const createData = CortexCreateResponseSchema.parse(await createRes.json());

    const metadataRes = await fetch(`${this.baseUrl}/objects/${createData.id}/metadata`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        entity_type: "mcp_registry",
        registry_id: entry.id,
        server_name: entry.name,
        source: entry.source,
        created_at: new Date().toISOString(),
      }),
    });
    if (!metadataRes.ok) {
      // Best-effort cleanup - swallow DELETE errors
      await fetch(`${this.baseUrl}/objects/${createData.id}`, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      throw new Error(`Failed to set metadata: ${metadataRes.status}. Object cleaned up.`);
    }
  }

  async get(id: string): Promise<MCPServerMetadata | null> {
    const objectId = await this.findObjectByRegistryId(id);
    if (!objectId) return null;

    const contentRes = await fetch(`${this.baseUrl}/objects/${objectId}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!contentRes.ok) return null;
    return MCPServerMetadataSchema.parse(await contentRes.json());
  }

  async list(): Promise<MCPServerMetadata[]> {
    const listRes = await fetch(`${this.baseUrl}/objects?metadata.entity_type=mcp_registry`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!listRes.ok) return [];

    const listData = CortexListResponseSchema.parse(await listRes.json());
    if (!listData.objects?.length) return [];

    const results = await Promise.allSettled(
      listData.objects.map(async (obj) => {
        const contentRes = await fetch(`${this.baseUrl}/objects/${obj.id}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!contentRes.ok) {
          throw new Error(`Failed to fetch object ${obj.id}: ${contentRes.status}`);
        }
        return MCPServerMetadataSchema.parse(await contentRes.json());
      }),
    );

    const entries: MCPServerMetadata[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        entries.push(result.value);
      } else {
        logger.warn("Failed to fetch MCP registry entry", { error: result.reason });
      }
    }
    return entries;
  }

  async delete(id: string): Promise<boolean> {
    const objectId = await this.findObjectByRegistryId(id);
    if (!objectId) return false;

    const deleteRes = await fetch(`${this.baseUrl}/objects/${objectId}`, {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    return deleteRes.ok;
  }
}
