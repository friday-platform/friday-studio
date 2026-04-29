import type { ArtifactType } from "@atlas/core/artifacts";

/**
 * @description Catalog entry from resource storage — what the adapter returns.
 * Thin entries before artifact enrichment. Discriminated on `type`.
 */
export type ResourceCatalogEntry =
  | {
      type: "document";
      slug: string;
      name: string;
      description: string;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "external_ref";
      slug: string;
      name: string;
      description: string;
      provider: string;
      ref?: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "artifact_ref";
      slug: string;
      name: string;
      description: string;
      artifactId: string;
      createdAt: string;
      updatedAt: string;
    };

/**
 * @description Enriched resource entry for HTTP endpoints and UI.
 * Same as catalog but artifact-ref variant includes resolved artifact metadata.
 */
export type ResourceEntry =
  | {
      type: "document";
      slug: string;
      name: string;
      description: string;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "external_ref";
      slug: string;
      name: string;
      description: string;
      provider: string;
      ref?: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "artifact_ref";
      slug: string;
      name: string;
      description: string;
      artifactId: string;
      artifactType: ArtifactType | "unavailable";
      mimeType?: string;
      rowCount?: number;
      createdAt: string;
      updatedAt: string;
    };
