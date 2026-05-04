/**
 * Regex-based image artifact discovery with artifact validation.
 * Extracts UUID-shaped strings from the prompt, validates them against the
 * artifact store, and filters to image files. No LLM call needed —
 * UUIDs have a fixed, unambiguous format.
 */

import { type Artifact, ArtifactStorage } from "@atlas/core/artifacts/server";

export interface DiscoveredImages {
  artifactIds: string[];
  /** Validated artifact metadata, keyed by ID. Avoids re-fetching in the agent handler. */
  artifacts: Map<string, Artifact>;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Checks whether an artifact is an image file by MIME type. */
function isImageArtifact(artifact: Artifact): boolean {
  if (artifact.data.type !== "file") return false;
  const { mimeType } = artifact.data;
  return IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Discovers image artifacts by extracting UUIDs from the prompt,
 * validating them against the artifact store, and filtering to image files.
 */
export async function discoverImageFiles(
  prompt: string,
  _abortSignal?: AbortSignal,
): Promise<DiscoveredImages> {
  const candidateIds = [...new Set(prompt.match(UUID_PATTERN) ?? [])];

  if (candidateIds.length === 0) {
    return { artifactIds: [], artifacts: new Map() };
  }

  const result = await ArtifactStorage.getManyLatest({ ids: candidateIds });
  if (!result.ok) {
    return { artifactIds: [], artifacts: new Map() };
  }

  const artifactIds: string[] = [];
  const artifacts = new Map<string, Artifact>();

  for (const artifact of result.data) {
    if (isImageArtifact(artifact)) {
      artifactIds.push(artifact.id);
      artifacts.set(artifact.id, artifact);
    }
  }

  return { artifactIds, artifacts };
}
