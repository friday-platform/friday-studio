/**
 * Atlas Draft Tools - AI SDK Compatible
 */

import { z } from "zod/v4";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "../utils.ts";

/**
 * Draft Management Tools
 *
 * Tools for managing Atlas workspace drafts
 */
export const draftTools = {
  atlas_workspace_draft_create: tool({
    description: "Creates new workspace drafts for iterative development.",
    inputSchema: z.object({
      name: z.string().describe("Name of the draft"),
      description: z.string().describe("Description of the draft"),
      initialConfig: z.record(z.string(), z.unknown()).optional().describe(
        "Initial configuration for the draft",
      ),
      sessionId: z.string().optional().describe("Associated session ID"),
      conversationId: z.string().optional().describe("Associated conversation ID"),
    }),
    execute: async ({ name, description, initialConfig, sessionId, conversationId }) => {
      try {
        const response = await fetchWithTimeout(`${defaultContext.daemonUrl}/api/drafts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, initialConfig, sessionId, conversationId }),
        });
        const draft = await handleDaemonResponse(response);
        return { draft };
      } catch (error) {
        throw new Error(`Failed to create draft: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_list_session_drafts: tool({
    description: "Lists workspace drafts for current session or conversation.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID to filter drafts"),
      conversationId: z.string().optional().describe("Conversation ID to filter drafts"),
      includeDetails: z.boolean().optional().describe("Whether to include full draft details"),
    }),
    execute: async ({ sessionId, conversationId, includeDetails }) => {
      try {
        const params = new URLSearchParams();
        if (sessionId) params.append("sessionId", sessionId);
        if (conversationId) params.append("conversationId", conversationId);
        if (includeDetails) params.append("includeDetails", "true");

        const response = await fetchWithTimeout(`${defaultContext.daemonUrl}/api/drafts?${params}`);
        const drafts = await handleDaemonResponse(response);
        return { drafts };
      } catch (error) {
        throw new Error(`Failed to list drafts: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_show_draft_config: tool({
    description: "Displays current draft configuration with formatting options.",
    inputSchema: z.object({
      draftId: z.string().describe("The ID of the draft to show"),
      format: z.enum(["yaml", "json", "summary"]).optional().describe(
        "Format for displaying the configuration",
      ),
    }),
    execute: async ({ draftId, format }) => {
      try {
        const params = format ? `?format=${format}` : "";
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/drafts/${draftId}${params}`,
        );
        const draft = await handleDaemonResponse(response);
        return { draft };
      } catch (error) {
        throw new Error(`Failed to show draft config: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_draft_update: tool({
    description: "Updates existing drafts with configuration changes and validation.",
    inputSchema: z.object({
      draftId: z.string().describe("The ID of the draft to update"),
      updates: z.record(z.string(), z.unknown()).describe("Configuration updates to apply"),
      updateDescription: z.string().optional().describe("Description of the changes being made"),
    }),
    execute: async ({ draftId, updates, updateDescription }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/drafts/${draftId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updates, updateDescription }),
          },
        );
        const draft = await handleDaemonResponse(response);
        return { draft };
      } catch (error) {
        throw new Error(`Failed to update draft: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_draft_validate: tool({
    description: "Validates draft configuration for correctness and completeness.",
    inputSchema: z.object({
      draftId: z.string().describe("The ID of the draft to validate"),
    }),
    execute: async ({ draftId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/drafts/${draftId}/validate`,
          {
            method: "POST",
          },
        );
        const validation = await handleDaemonResponse(response);
        return { validation };
      } catch (error) {
        throw new Error(`Failed to validate draft: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_publish_draft_to_workspace: tool({
    description: "Publishes validated drafts to filesystem for production use.",
    inputSchema: z.object({
      draftId: z.string().describe("The ID of the draft to publish"),
      path: z.string().optional().describe("Path where to publish the workspace"),
      overwrite: z.boolean().optional().describe("Whether to overwrite existing workspace"),
    }),
    execute: async ({ draftId, path, overwrite }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/drafts/${draftId}/publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, overwrite }),
          },
        );
        const result = await handleDaemonResponse(response);
        return { result };
      } catch (error) {
        throw new Error(`Failed to publish draft: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_delete_draft_config: tool({
    description: "Deletes drafts that are no longer needed.",
    inputSchema: z.object({
      draftId: z.string().describe("The ID of the draft to delete"),
    }),
    execute: async ({ draftId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/drafts/${draftId}`,
          {
            method: "DELETE",
          },
        );
        await handleDaemonResponse(response);
        return { success: true, draftId };
      } catch (error) {
        throw new Error(`Failed to delete draft: ${getErrorMessage(error)}`);
      }
    },
  }),
};
