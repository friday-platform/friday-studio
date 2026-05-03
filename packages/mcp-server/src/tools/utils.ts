/** Shared utilities for MCP tools */

import type { Artifact } from "@atlas/core/artifacts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Strip internal storage references from artifact data before returning
 * to agents. Agents reference artifacts by ID; the SHA-256 contentRef is
 * an internal Object Store name and should not leak.
 */
export function stripArtifactFilePaths(artifact: Artifact) {
  if (artifact.data.type !== "file") return artifact;
  const { contentRef: _, ...fileData } = artifact.data;
  return { ...artifact, data: fileData };
}

/** Create successful MCP response */
export function createSuccessResponse(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

/** Create error MCP response */
export function createErrorResponse(message: string, details?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, details }) }],
    isError: true,
  };
}
