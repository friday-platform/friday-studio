import { createLogger } from "@atlas/logger";
import { z } from "zod";
import { type DynamicProviderInput, DynamicProviderInputSchema } from "../types.ts";
import type { ProviderStorageAdapter } from "./adapter.ts";

const CortexListResponseSchema = z.object({
  objects: z.array(z.object({ id: z.string() })).optional(),
});
const CortexCreateResponseSchema = z.object({ id: z.string() });

const logger = createLogger({ component: "provider-storage:cortex-adapter" });

/**
 * Remote storage adapter using Cortex blob storage service.
 *
 * Used for cloud deployments where local storage is ephemeral.
 * Stores dynamic provider definitions as JSON blobs with metadata filtering.
 *
 * Metadata schema:
 * - entity_type: "link_provider" (distinguishes from other Cortex objects)
 * - provider_id: The DynamicProviderInput.id for lookups
 * - provider_type: "oauth" | "apikey" for filtering
 * - display_name: Searchable name field
 */
export class CortexProviderStorageAdapter implements ProviderStorageAdapter {
  constructor(
    private baseUrl: string,
    private getAuthToken: () => string,
  ) {}

  private headers(): HeadersInit {
    const token = this.getAuthToken();
    if (!token) {
      throw new Error("CortexProviderStorageAdapter: missing auth token");
    }
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  /**
   * Find the Cortex object ID for a given provider ID.
   */
  private async findObjectByProviderId(id: string): Promise<string | null> {
    const listRes = await fetch(
      `${this.baseUrl}/objects?metadata.entity_type=link_provider&metadata.provider_id=${encodeURIComponent(id)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    if (!listRes.ok) return null;

    const listData = CortexListResponseSchema.parse(await listRes.json());
    return listData.objects?.[0]?.id ?? null;
  }

  async add(provider: DynamicProviderInput): Promise<void> {
    if ((await this.findObjectByProviderId(provider.id)) !== null) {
      throw new Error(`Provider already exists: ${provider.id}`);
    }

    const createRes = await fetch(`${this.baseUrl}/objects`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content: JSON.stringify(provider) }),
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
        entity_type: "link_provider",
        provider_id: provider.id,
        provider_type: provider.type,
        display_name: provider.displayName,
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

  async get(id: string): Promise<DynamicProviderInput | null> {
    const objectId = await this.findObjectByProviderId(id);
    if (!objectId) return null;

    const contentRes = await fetch(`${this.baseUrl}/objects/${objectId}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!contentRes.ok) return null;
    const parsed = DynamicProviderInputSchema.safeParse(await contentRes.json());
    if (!parsed.success) {
      logger.warn("Corrupt provider object in Cortex", { objectId, error: parsed.error });
      return null;
    }
    return parsed.data;
  }

  async list(): Promise<DynamicProviderInput[]> {
    const listRes = await fetch(`${this.baseUrl}/objects?metadata.entity_type=link_provider`, {
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
        const parsed = DynamicProviderInputSchema.safeParse(await contentRes.json());
        if (!parsed.success) {
          logger.warn("Corrupt provider object in Cortex", {
            objectId: obj.id,
            error: parsed.error,
          });
          return null;
        }
        return parsed.data;
      }),
    );

    const providers: DynamicProviderInput[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== null) {
        providers.push(result.value);
      } else if (result.status === "rejected") {
        logger.warn("Failed to fetch provider entry", { error: result.reason });
      }
    }
    return providers;
  }

  async delete(id: string): Promise<boolean> {
    const objectId = await this.findObjectByProviderId(id);
    if (!objectId) return false;

    const deleteRes = await fetch(`${this.baseUrl}/objects/${objectId}`, {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    return deleteRes.ok;
  }
}
