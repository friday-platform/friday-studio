import type { AtlasUIMessage } from "@atlas/agent-sdk";

/**
 * Extracts unique artifact IDs from display_artifact tool calls in messages.
 * Used for batch-fetching artifacts during page load to avoid N+1 API calls.
 *
 * @param messages - Array of Atlas UI messages to extract artifact IDs from
 * @returns Array of unique artifact IDs found in the messages
 */
export function extractArtifactIds(messages: AtlasUIMessage[]): string[] {
  const ids = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      // display_artifact tool calls have type "tool-display_artifact"
      // with the artifact ID in part.output.artifactId
      if (
        part.type === "tool-display_artifact" &&
        "output" in part &&
        part.output &&
        typeof part.output === "object" &&
        "artifactId" in part.output &&
        typeof part.output.artifactId === "string"
      ) {
        ids.add(part.output.artifactId);
      }
    }
  }

  return Array.from(ids);
}
