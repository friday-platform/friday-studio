import type { ImagePart, TextPart } from "ai";
import { isImageMimeType } from "./file-upload.ts";
import type { Artifact } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

/**
 * Resolves image artifacts into AI SDK content parts.
 *
 * Filters for image MIME types, reads binary data via storage adapter,
 * and returns ImagePart objects. Falls back to a TextPart placeholder
 * when binary read fails (graceful degradation — never throws).
 *
 * @param artifacts - Artifacts to process (non-image types are skipped)
 * @param storage - Storage adapter with readBinaryContents()
 * @returns Array of ImagePart (success) or TextPart (failure) for each image artifact
 */
export function resolveImageParts(
  artifacts: Artifact[],
  storage: ArtifactStorageAdapter,
): Promise<Array<ImagePart | TextPart>> {
  const imageArtifacts = artifacts.filter(
    (a): a is Artifact => a.data.type === "file" && isImageMimeType(a.data.mimeType),
  );

  return Promise.all(
    imageArtifacts.map(async (artifact): Promise<ImagePart | TextPart> => {
      const { mimeType, originalName } = artifact.data;
      const result = await storage.readBinaryContents({ id: artifact.id });

      if (result.ok) {
        return { type: "image", image: result.data, mediaType: mimeType };
      }
      const name = originalName ?? artifact.id;
      return { type: "text", text: `[Image: ${name} — could not be loaded]` };
    }),
  );
}
