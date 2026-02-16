import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { parseWorkspacePlannerArtifactId } from "../modules/messages/types.ts";

/**
 * Extracts unique artifact IDs from tool calls in messages.
 * Used for batch-fetching artifacts during page load to avoid N+1 API calls.
 *
 * Handles:
 * - display_artifact: part.output.artifactId
 * - workspace-planner: part.output.data.artifactId (direct) or MCP envelope (legacy)
 */
export function extractArtifactIds(messages: AtlasUIMessage[]): string[] {
  const ids = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      // display_artifact: part.output.artifactId
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

      // workspace-planner: nested JSON structure
      if (part.type === "tool-workspace-planner" && "output" in part) {
        const artifactId = parseWorkspacePlannerArtifactId(part.output);
        if (artifactId) {
          ids.add(artifactId);
        }
      }
    }
  }

  return Array.from(ids);
}
