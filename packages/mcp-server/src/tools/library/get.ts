import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

const schema = z.object({
  itemId: z.string().describe(
    "Unique identifier of the library item to retrieve (obtain from library_list)",
  ),
  includeContent: z.boolean().default(false).describe(
    "Whether to include the full content/data of the item, not just metadata (useful for reports, documents, or archived results)",
  ),
});

export const libraryGetTool: ToolHandler<typeof schema> = {
  name: "library_get",
  description:
    "Retrieve a specific library item including its metadata and optionally its full content. Use this to access stored reports, session archives, templates, or other resources by their unique identifier.",
  inputSchema: schema,
  handler: async ({ itemId, includeContent = false }, { daemonUrl, logger }) => {
    logger.info("MCP library_get called", { itemId, includeContent });

    // Input validation
    if (!itemId || typeof itemId !== "string" || itemId.trim().length === 0) {
      throw new Error("itemId is required and must be a non-empty string");
    }

    try {
      const params = new URLSearchParams();
      if (includeContent) params.set("content", "true");

      const queryString = params.toString();
      const url = queryString
        ? `${daemonUrl}/api/library/${itemId}?${queryString}`
        : `${daemonUrl}/api/library/${itemId}`;

      const response = await fetchWithTimeout(url);
      const result = await handleDaemonResponse(response, "library_get", logger);

      logger.info("MCP library_get response", {
        itemId,
        hasContent: includeContent && "content" in result,
      });

      return createSuccessResponse({
        ...result,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP library_get failed", { itemId, error });
      throw error;
    }
  },
};
