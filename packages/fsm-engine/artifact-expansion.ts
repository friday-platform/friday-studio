/**
 * Artifact expansion utility for FSM document serialization.
 *
 * Extracts artifact IDs from documents containing artifactRef/artifactRefs,
 * batch-fetches content from artifact storage, and injects it back as
 * artifactContent for downstream agents.
 */

import { type ArtifactRef, ArtifactRefSchema } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { logger as baseLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { Document } from "./types.ts";

const logger = baseLogger.child({ component: "artifact-expansion" });

/**
 * Extract artifact refs from a document, handling both singular and array forms.
 * Also handles Result wrapper pattern: { ok: true, data: { artifactRef: {...} } }
 * Malformed refs are logged and skipped rather than crashing.
 */
export function extractRefs(doc: Document): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const raw = doc.data;

  // Skip non-objects
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refs;

  // Unwrap Result pattern { ok: true, data: {...} } if present
  const obj = raw as Record<string, unknown>;
  const data =
    obj.ok === true && obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : obj;

  if (!data) return refs;

  // Parse singular artifactRef
  if (data.artifactRef !== undefined) {
    const result = ArtifactRefSchema.safeParse(data.artifactRef);
    if (result.success) {
      refs.push(result.data);
    } else {
      logger.warn("Malformed artifactRef, skipping", {
        docId: doc.id,
        error: result.error.message,
      });
    }
  }

  // Parse array of artifactRefs
  if (Array.isArray(data.artifactRefs)) {
    for (const rawRef of data.artifactRefs) {
      const result = ArtifactRefSchema.safeParse(rawRef);
      if (result.success) {
        refs.push(result.data);
      } else {
        logger.warn("Malformed artifactRef in array, skipping", {
          docId: doc.id,
          error: result.error.message,
        });
      }
    }
  }

  return refs;
}

/** Document with expanded artifact content injected */
export interface DocumentWithArtifactContent extends Document {
  data: Document["data"] & {
    /** Fetched artifact payloads keyed by artifact ID */
    artifactContent?: Record<string, unknown>;
  };
}

/**
 * Expand artifact references in FSM documents by fetching actual content.
 *
 * This enables downstream agents (e.g., email) to access full artifact content
 * rather than just references. Follows the pattern from session-supervisor.
 *
 * @param documents - FSM documents that may contain artifactRef/artifactRefs
 * @param abortSignal - Optional abort signal for cancellation
 * @returns Documents with artifactContent injected where refs were found
 *
 * @example
 * ```ts
 * const docs = [
 *   { id: "research_result", type: "agent-output", data: {
 *     summary: "Found 3 events",
 *     artifactRef: { id: "art-123", type: "calendar", summary: "Events" }
 *   }}
 * ];
 *
 * const expanded = await expandArtifactRefsInDocuments(docs);
 * // expanded[0].data.artifactContent = { "art-123": { events: [...] } }
 * ```
 */
export async function expandArtifactRefsInDocuments(
  documents: Document[],
  abortSignal?: AbortSignal,
): Promise<DocumentWithArtifactContent[]> {
  // 1. Collect all referenced artifact IDs and already-expanded IDs
  const referencedIds = new Set<string>();
  const expandedIds = new Set<string>();

  for (const doc of documents) {
    // Collect all artifact IDs referenced in this doc
    for (const ref of extractRefs(doc)) {
      referencedIds.add(ref.id);
    }

    // Collect IDs that already have content (from prior expansion)
    const existingContent = doc.data?.artifactContent;
    if (existingContent && typeof existingContent === "object") {
      for (const id of Object.keys(existingContent as Record<string, unknown>)) {
        expandedIds.add(id);
      }
    }
  }

  // 2. Compute which IDs are missing (referenced but not yet expanded)
  const missingIds = [...referencedIds].filter((id) => !expandedIds.has(id));

  // 3. Short-circuit if nothing to fetch (either no refs or all already expanded)
  if (missingIds.length === 0) {
    return documents as DocumentWithArtifactContent[];
  }

  logger.info("Expanding artifact refs in documents", {
    missingCount: missingIds.length,
    totalReferenced: referencedIds.size,
    documentCount: documents.length,
  });

  // 4. Batch fetch only missing artifact content with 5s timeout
  const artifactPayloads: Map<string, unknown> = new Map();

  try {
    const timeout = AbortSignal.timeout(5000);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;

    const response = await parseResult(
      client.artifactsStorage["batch-get"].$post(
        { json: { ids: missingIds } },
        { init: { signal } },
      ),
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch artifacts: ${stringifyError(response.error)}`);
    }

    // Build ID → payload map
    for (const artifact of response.data.artifacts) {
      artifactPayloads.set(artifact.id, artifact.data);
    }

    logger.info("Expanded artifacts loaded", {
      requested: missingIds.length,
      received: artifactPayloads.size,
    });
  } catch (error) {
    logger.error("Failed to expand artifacts", {
      error: stringifyError(error),
      artifactCount: missingIds.length,
    });

    throw new Error(`Artifact expansion failed: ${stringifyError(error)}`);
  }

  // 5. Inject artifact content back into documents, preserving existing content
  const expandedDocs: DocumentWithArtifactContent[] = [];

  for (const doc of documents) {
    const refs = extractRefs(doc);

    // Skip documents without artifact refs (they never get artifactContent)
    if (refs.length === 0) {
      expandedDocs.push(doc);
      continue;
    }

    // Start with existing artifactContent (preserve prior expansions)
    const existingContent = doc.data?.artifactContent;
    const artifactContent: Record<string, unknown> =
      existingContent && typeof existingContent === "object"
        ? { ...(existingContent as Record<string, unknown>) }
        : {};

    // Add newly fetched content
    for (const ref of refs) {
      const payload = artifactPayloads.get(ref.id);
      if (payload !== undefined) {
        artifactContent[ref.id] = payload;
      }
    }

    // Only add artifactContent if we have any
    if (Object.keys(artifactContent).length > 0) {
      expandedDocs.push({ ...doc, data: { ...doc.data, artifactContent } });
    } else {
      expandedDocs.push(doc);
    }
  }

  return expandedDocs;
}
