/**
 * Atlas Library Tools - AI SDK Compatible
 */

import { z } from "zod";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "./utils.ts";

/**
 * Library Management Tools
 *
 * Tools for managing Atlas library items
 */
export const libraryTools = {
  atlas_library_list: tool({
    description: "Browses and searches library items with flexible filtering options.",
    parameters: z.object({
      query: z.string().optional().describe("Search query for library items"),
      type: z.array(z.string()).optional().describe("Filter by content types"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      since: z.string().optional().describe("Filter items created since this date (ISO format)"),
      until: z.string().optional().describe("Filter items created until this date (ISO format)"),
      limit: z.number().optional().describe("Maximum number of items to return"),
      offset: z.number().optional().describe("Number of items to skip"),
    }),
    execute: async ({ query, type, tags, since, until, limit, offset }) => {
      try {
        const params = new URLSearchParams();
        if (query) params.append("query", query);
        if (type) type.forEach((t) => params.append("type", t));
        if (tags) tags.forEach((t) => params.append("tags", t));
        if (since) params.append("since", since);
        if (until) params.append("until", until);
        if (limit) params.append("limit", limit.toString());
        if (offset) params.append("offset", offset.toString());

        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/library?${params}`,
        );
        const library = await handleDaemonResponse(response);
        return { library };
      } catch (error) {
        throw new Error(`Failed to list library items: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_library_get: tool({
    description:
      "Retrieves specific library items including reports, archives, templates, and analysis data. Use includeContent for full content vs metadata only.",
    parameters: z.object({
      itemId: z.string().describe("The ID of the library item to retrieve"),
      includeContent: z.boolean().optional().describe(
        "Whether to include full content in the response",
      ),
    }),
    execute: async ({ itemId, includeContent }) => {
      try {
        const params = includeContent ? "?includeContent=true" : "";
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/library/${itemId}${params}`,
        );
        const item = await handleDaemonResponse(response);
        return { item };
      } catch (error) {
        throw new Error(`Failed to get library item: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_library_store: tool({
    description: "Stores new items in library for future reference and reuse.",
    parameters: z.object({
      type: z.enum(["document", "code", "data", "template", "analysis", "report"]).describe(
        "Type of content being stored",
      ),
      name: z.string().describe("Name of the library item"),
      description: z.string().optional().describe("Description of the content"),
      content: z.string().describe("The actual content to store"),
      format: z.enum(["text", "markdown", "json", "yaml", "code"]).optional().describe(
        "Format of the content",
      ),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      workspace_id: z.string().optional().describe("Associated workspace ID"),
      session_id: z.string().optional().describe("Associated session ID"),
      agent_ids: z.array(z.string()).optional().describe("Associated agent IDs"),
      source: z.enum(["manual", "generated", "imported"]).optional().describe(
        "Source of the content",
      ),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Additional metadata"),
    }),
    execute: async (
      {
        type,
        name,
        description,
        content,
        format,
        tags,
        workspace_id,
        session_id,
        agent_ids,
        source,
        metadata,
      },
    ) => {
      try {
        const response = await fetchWithTimeout(`${defaultContext.daemonUrl}/api/library`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            name,
            description,
            content,
            format,
            tags,
            workspace_id,
            session_id,
            agent_ids,
            source,
            metadata,
          }),
        });
        const item = await handleDaemonResponse(response);
        return { item };
      } catch (error) {
        throw new Error(`Failed to store library item: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_library_stats: tool({
    description: "Gets library usage statistics and analytics.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const response = await fetchWithTimeout(`${defaultContext.daemonUrl}/api/library/stats`);
        const stats = await handleDaemonResponse(response);
        return { stats };
      } catch (error) {
        throw new Error(`Failed to get library stats: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_library_templates: tool({
    description: "Lists available content generation templates.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/library/templates`,
        );
        const templates = await handleDaemonResponse(response);
        return { templates };
      } catch (error) {
        throw new Error(`Failed to get library templates: ${getErrorMessage(error)}`);
      }
    },
  }),
};
