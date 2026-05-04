import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { appendStateEntry } from "./storage.ts";

/** Cache artifact IDs to skip listByWorkspace on repeat calls */
const artifactIdCache = new Map<string, string>();

async function resolveArtifactId(workspaceId: string): Promise<string | undefined> {
  const cached = artifactIdCache.get(workspaceId);
  if (cached) return cached;

  const listResult = await ArtifactStorage.listByWorkspace({ workspaceId, includeData: false });
  if (!listResult.ok) return undefined;

  const match = listResult.data.find((a) => a.title === "workspace-state");
  if (match) {
    artifactIdCache.set(workspaceId, match.id);
    return match.id;
  }
  return undefined;
}

/** Register MCP tool for appending entries to persistent workspace state */
export function registerStateAppendTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "state_append",
    {
      description:
        "Append an entry to persistent workspace state (JetStream-backed). " +
        "A _ts timestamp is auto-added. " +
        "Optionally prune entries older than ttl_hours. " +
        "State survives across job runs and workspace restarts.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        workspaceName: z.string().optional().describe("Human-readable workspace name"),
        key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/)
          .describe(
            "State key — becomes a table-like prefix (lowercase alphanumeric, hyphens, underscores)",
          ),
        entry: z.record(z.string(), z.unknown()).describe("JSON object to append"),
        ttl_hours: z
          .number()
          .positive()
          .optional()
          .describe("Prune entries older than this many hours"),
      },
    },
    async ({ workspaceId, workspaceName, key, entry, ttl_hours }): Promise<CallToolResult> => {
      ctx.logger.info("MCP state_append called", { workspaceId, workspaceName, key, ttl_hours });

      try {
        const { count, pruned } = await appendStateEntry(workspaceId, key, entry, ttl_hours);

        // Maintain an artifact-as-discovery-handle so the workspace UI
        // can surface that state exists. The artifact content is a tiny
        // JSON manifest — no longer the raw DB.
        const nameLabel = workspaceName ? ` [${workspaceName}]` : "";
        const summary = `Workspace${nameLabel} state (${count} entries in "${key}")`;
        const manifest = JSON.stringify(
          {
            kind: "workspace-state",
            workspaceId,
            key,
            count,
            lastUpdate: new Date().toISOString(),
          },
          null,
          2,
        );
        const manifestData = {
          type: "file" as const,
          content: manifest,
          mimeType: "application/json",
          originalName: "workspace-state.json",
        };

        const existingId = await resolveArtifactId(workspaceId);
        if (existingId) {
          const updateResult = await ArtifactStorage.update({
            id: existingId,
            data: manifestData,
            summary,
          });
          if (!updateResult.ok) {
            // Stale cache — artifact may have been deleted externally
            artifactIdCache.delete(workspaceId);
            ctx.logger.warn("Failed to update state artifact, cache invalidated", {
              error: updateResult.error,
              key,
            });
          }
        }

        // Create if no existing artifact or update failed (cache was invalidated)
        if (!artifactIdCache.has(workspaceId)) {
          const createResult = await ArtifactStorage.create({
            data: manifestData,
            title: "workspace-state",
            summary,
            workspaceId,
          });
          if (createResult.ok) {
            artifactIdCache.set(workspaceId, createResult.data.id);
          } else {
            ctx.logger.warn("Failed to create state artifact", { error: createResult.error, key });
          }
        }

        return createSuccessResponse({ count, pruned });
      } catch (error) {
        ctx.logger.error("state_append failed", { error, workspaceId, key });
        return createErrorResponse("Failed to append state", stringifyError(error));
      }
    },
  );
}
