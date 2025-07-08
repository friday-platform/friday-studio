/**
 * Workspace Draft Management Tools for MCP Server
 *
 * These tools provide comprehensive workspace draft lifecycle management
 * through the Atlas MCP server interface. They route through the daemon API
 * to maintain consistency with existing workspace capabilities.
 */

import { z } from "zod/v4";

/**
 * Tool: workspace_draft_create
 *
 * Creates a new workspace draft with optional initial configuration.
 * Validates configuration and provides helpful error messages.
 */
export const workspace_draft_create = {
  name: "workspace_draft_create",
  description:
    "Create a new workspace draft with optional initial configuration for development and testing. The draft allows iterative configuration building with validation before final publication.",
  inputSchema: z.object({
    name: z.string().min(1).max(255).describe(
      "Human-readable workspace name (e.g., 'my-api-project', 'data-pipeline')",
    ),
    description: z.string().min(1).max(1000).describe(
      "Clear description of the workspace's purpose and functionality",
    ),
    initialConfig: z.record(z.string(), z.unknown()).optional().describe(
      "Optional initial workspace configuration following WorkspaceConfig schema",
    ),
  }),
};

/**
 * Tool: workspace_draft_update
 *
 * Updates an existing workspace draft with configuration changes.
 * Provides validation and tracks change history.
 */
export const workspace_draft_update = {
  name: "workspace_draft_update",
  description:
    "Update an existing workspace draft with configuration changes and validation. Supports iterative development with helpful error reporting.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to update (obtain from workspace_draft_create or list_session_drafts)",
    ),
    updates: z.record(z.string(), z.unknown()).describe(
      "Configuration updates to apply to the draft (partial WorkspaceConfig)",
    ),
    updateDescription: z.string().optional().describe(
      "Optional description of what changes are being made",
    ),
  }),
};

/**
 * Tool: validate_draft_config
 *
 * Validates workspace draft configuration for correctness and completeness.
 * Provides detailed validation results without publishing.
 */
export const validate_draft_config = {
  name: "validate_draft_config",
  description:
    "Validate workspace draft configuration for correctness, completeness, and best practices. Returns detailed validation results and suggestions.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to validate",
    ),
  }),
};

/**
 * Tool: pre_publish_check
 *
 * Runs comprehensive readiness checks before workspace publication.
 * Verifies all dependencies, configurations, and requirements.
 */
export const pre_publish_check = {
  name: "pre_publish_check",
  description:
    "Run comprehensive readiness checks before workspace publication. Verifies dependencies, configurations, environment requirements, and potential issues.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to check for publication readiness",
    ),
  }),
};

/**
 * Tool: publish_workspace
 *
 * Publishes validated workspace draft to filesystem for production use.
 * Creates workspace directory with proper structure and configuration.
 */
export const publish_workspace = {
  name: "publish_workspace",
  description:
    "Publish validated workspace draft to filesystem for production use. Creates workspace directory structure with configuration files and setup instructions.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to publish",
    ),
    path: z.string().optional().describe(
      "Target filesystem path for workspace creation (defaults to current directory)",
    ),
    overwrite: z.boolean().default(false).describe(
      "Whether to overwrite existing workspace directory if it exists",
    ),
  }),
};

/**
 * Tool: show_draft_config
 *
 * Displays current workspace draft configuration with formatting.
 * Provides clear view of current configuration state.
 */
export const show_draft_config = {
  name: "show_draft_config",
  description:
    "Display current workspace draft configuration with clear formatting. Shows the complete configuration structure and current values.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to display",
    ),
    format: z.enum(["yaml", "json", "summary"]).default("yaml").describe(
      "Format for displaying the configuration (yaml, json, or human-readable summary)",
    ),
  }),
};

/**
 * Tool: list_session_drafts
 *
 * Lists all workspace drafts for the current session or conversation context.
 * Helps users track and manage multiple drafts.
 */
export const list_session_drafts = {
  name: "list_session_drafts",
  description:
    "List all workspace drafts for the current session or conversation context. Shows draft status, creation times, and basic metadata.",
  inputSchema: z.object({
    sessionId: z.string().optional().describe(
      "Session ID to list drafts for (optional, defaults to current session)",
    ),
    conversationId: z.string().optional().describe(
      "Conversation ID to list drafts for (optional, used for conversation-scoped drafts)",
    ),
    includeDetails: z.boolean().default(false).describe(
      "Whether to include detailed configuration summaries for each draft",
    ),
  }),
};

/**
 * All workspace draft tools for easy import
 */
export const workspaceDraftTools = {
  workspace_draft_create,
  workspace_draft_update,
  validate_draft_config,
  pre_publish_check,
  publish_workspace,
  show_draft_config,
  list_session_drafts,
} as const;

/**
 * Type-safe tool names for workspace drafts
 */
export type WorkspaceDraftToolName = keyof typeof workspaceDraftTools;

/**
 * Workspace draft tool names as array
 */
export const WORKSPACE_DRAFT_TOOL_NAMES = Object.keys(
  workspaceDraftTools,
) as WorkspaceDraftToolName[];
