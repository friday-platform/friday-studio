import type { Artifact, ArtifactStorageAdapter } from "@atlas/core/artifacts";
import type { ResourceMetadata, ResourceStorageAdapter } from "@atlas/ledger";
import type { ResourceCatalogEntry, ResourceEntry } from "./types.ts";

/** Type guard for objects with string-keyed properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps Ledger metadata rows to ResourceCatalogEntry by fetching type-specific
 * fields (artifactId, provider, ref) from resource data for non-document types.
 */
export async function toCatalogEntries(
  metadata: ResourceMetadata[],
  adapter: ResourceStorageAdapter,
  workspaceId: string,
): Promise<ResourceCatalogEntry[]> {
  const entries: ResourceCatalogEntry[] = [];

  for (const m of metadata) {
    if (m.type === "document") {
      entries.push({
        type: "document",
        slug: m.slug,
        name: m.name,
        description: m.description,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      });
      continue;
    }

    const resource = await adapter.getResource(workspaceId, m.slug);
    if (!resource) continue;

    const data = resource.version.data;

    if (m.type === "artifact_ref") {
      const artifactId =
        isRecord(data) && typeof data.artifactId === "string" ? data.artifactId : "";
      entries.push({
        type: "artifact_ref",
        slug: m.slug,
        name: m.name,
        description: m.description,
        artifactId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      });
    } else if (m.type === "external_ref") {
      const provider = isRecord(data) && typeof data.provider === "string" ? data.provider : "";
      const ref = isRecord(data) && typeof data.ref === "string" ? data.ref : undefined;
      const meta =
        isRecord(data) && isRecord(data.metadata)
          ? (data.metadata as Record<string, unknown>)
          : undefined;
      entries.push({
        type: "external_ref",
        slug: m.slug,
        name: m.name,
        description: m.description,
        provider,
        ref,
        metadata: meta,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      });
    }
  }

  return entries;
}

/**
 * Enriches catalog entries with artifact metadata.
 * Artifact-ref entries get `artifactType` (and `rowCount` for databases).
 * Missing artifacts produce `artifactType: "unavailable"`.
 */
export async function enrichCatalogEntries(
  entries: ResourceCatalogEntry[],
  artifactStorage: ArtifactStorageAdapter,
): Promise<ResourceEntry[]> {
  const artifactRefEntries = entries.filter(
    (e): e is Extract<ResourceCatalogEntry, { type: "artifact_ref" }> => e.type === "artifact_ref",
  );

  const artifactMap = new Map<string, Artifact>();

  if (artifactRefEntries.length > 0) {
    const ids = artifactRefEntries.map((e) => e.artifactId);
    const result = await artifactStorage.getManyLatest({ ids });

    if (result.ok) {
      for (const artifact of result.data) {
        artifactMap.set(artifact.id, artifact);
      }
    }
  }

  return entries.map((entry): ResourceEntry => {
    if (entry.type !== "artifact_ref") {
      return entry;
    }

    const artifact = artifactMap.get(entry.artifactId);

    if (!artifact) {
      return { ...entry, artifactType: "unavailable" };
    }

    if (artifact.data.type === "database") {
      return {
        ...entry,
        artifactType: artifact.type,
        rowCount: artifact.data.data.schema.rowCount,
      };
    }

    return { ...entry, artifactType: artifact.type };
  });
}
