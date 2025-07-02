import { WorkspaceConfigSchema } from "@atlas/config";
import { stringify } from "@std/yaml";
import { jsonSchema, Tool } from "ai";
import { z } from "zod";
import { AtlasLogger } from "../utils/logger.ts";
import { LLMProviderManager } from "./agents/llm-provider-manager.ts";
import {
  generateValidationFixSuggestions,
  validateCrossReferences,
} from "./services/workspace-conversation-helpers.ts";
import { createKVStorage, StorageConfigs, WorkspaceDraftStorageAdapter } from "./storage/index.ts";
import { AtlasClient } from "@atlas/client";

// MCP tool name validation - dots are illegal in MCP tool names
const MCPToolNameSchema = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_-]*$/,
  "MCP tool names must start with a letter and contain only letters, numbers, underscores, and hyphens (no dots)",
);

// Create a singleton draft storage adapter
let draftStorageAdapter: WorkspaceDraftStorageAdapter | null = null;

async function getDraftStorageAdapter(): Promise<WorkspaceDraftStorageAdapter> {
  if (!draftStorageAdapter) {
    const kvStorage = await createKVStorage(StorageConfigs.defaultKV());
    draftStorageAdapter = new WorkspaceDraftStorageAdapter(kvStorage);
    await draftStorageAdapter.initialize();
  }
  return draftStorageAdapter;
}

// Validate draft configuration via daemon API
async function validateDraftConfig(config: unknown): Promise<{
  valid: boolean;
  errors?: Array<{
    code?: string;
    path?: string[];
    message?: string;
    expected?: string;
    received?: string;
    keys?: string[];
  }>;
  formattedError?: string;
}> {
  const logger = AtlasLogger.getInstance();

  try {
    const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
    const response = await fetch(`${daemonUrl}/api/workspaces/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ config }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error("Failed to validate config", { error, status: response.status });
      return {
        valid: false,
        errors: [{ message: error }],
      };
    }

    return await response.json();
  } catch (error) {
    logger.error("Error validating config", { error });
    return {
      valid: false,
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export interface ConversationSession {
  id: string;
  workspaceId: string;
  mode: "private" | "shared";
  participants: Array<{
    userId: string;
    clientType: string;
    joinedAt: string;
    lastSeen: string;
  }>;
  createdAt: string;
  lastActivity: string;
  messageHistory: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  fromUser: string;
  content: string;
  timestamp: string;
  type: "user" | "assistant" | "system";
}

export interface ConversationEvent {
  type:
    | "thinking"
    | "tool_call"
    | "message_chunk"
    | "transparency"
    | "orchestration"
    | "message_complete"
    | "user_message"
    | "user_joined"
    | "user_left";
  data: any;
  timestamp: string;
  messageId?: string;
  sessionId: string;
}

// Function to create tools with session context
const createCxTools = (sessionId: string): Record<string, Tool> => ({
  cx_reply: {
    description:
      "Reply to user with structured transparency envelope containing reasoning and potential agent coordination",
    parameters: jsonSchema({
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Natural conversational response to the user",
        },
        transparency: {
          type: "object",
          properties: {
            analysis: {
              type: "string",
              description: "Your detailed reasoning about this interaction",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Confidence level in your understanding and response",
            },
            complexity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Task complexity assessment",
            },
            requiresAgentCoordination: {
              type: "boolean",
              description: "Whether this request needs Atlas agent coordination",
            },
            coordinationPlan: {
              type: "object",
              properties: {
                agents: {
                  type: "array",
                  items: { type: "string" },
                  description: "Atlas agents to coordinate if coordination is needed",
                },
                strategy: {
                  type: "string",
                  enum: ["sequential", "parallel", "staged"],
                  description: "Execution strategy for agent coordination",
                },
                recommendedJob: {
                  type: "string",
                  description: "Atlas job to recommend or trigger",
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          required: ["analysis", "confidence", "complexity", "requiresAgentCoordination"],
          additionalProperties: false,
        },
      },
      required: ["message", "transparency"],
      additionalProperties: false,
    }),
    execute: async ({ message, transparency }, options) => {
      const logger = AtlasLogger.getInstance();
      const startTime = Date.now();

      logger.info("cx_reply tool executing", {
        messageLength: message.length,
        hasTransparency: !!transparency,
        toolCallId: options?.toolCallId,
        timestamp: new Date().toISOString(),
      });

      // Log the full details for debugging
      logger.debug(JSON.stringify(
        {
          tool: "cx_reply tool executed",
          message: message.substring(0, 500),
          messageLength: message.length,
          fullMessage: message,
          transparency,
          toolCallId: options?.toolCallId,
        },
        null,
        2,
      ));

      // Return a proper result object that the AI SDK expects
      const result = {
        message,
        transparency,
        success: true,
      };

      const executionTime = Date.now() - startTime;
      logger.debug("cx_reply tool returning result", {
        hasMessage: !!result.message,
        hasTransparency: !!result.transparency,
        executionTime,
        toolCallId: options?.toolCallId,
      });

      return result;
    },
  },
  // Add workspace_create tool for actual workspace creation
  workspace_create: {
    description: "Create a new workspace with the specified configuration",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Workspace name (lowercase with hyphens)",
        },
        description: {
          type: "string",
          description: "Workspace description",
        },
        path: {
          type: "string",
          description: "Optional path where workspace should be created",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    }),
    execute: async ({ name, description, path }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_create tool called", {
        name,
        description,
        path,
      });

      try {
        // Call the daemon API to actually create the workspace
        const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
        const response = await fetch(`${daemonUrl}/api/workspaces`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description,
            path,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error("Failed to create workspace", { error, status: response.status });
          return {
            success: false,
            error: `Failed to create workspace: ${error}`,
          };
        }

        const workspace = await response.json();
        logger.info("Workspace created successfully", { workspace });

        return {
          success: true,
          workspace,
          message: `Workspace '${name}' created successfully with ID: ${workspace.id}`,
        };
      } catch (error) {
        logger.error("Error creating workspace", { error });
        return {
          success: false,
          error: `Error creating workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },
  // New draft-based workspace creation tools
  workspace_draft_create: {
    description: "Create a new workspace draft with optional initial configuration",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$",
          description: "Workspace name (lowercase with hyphens, no dots)",
        },
        description: {
          type: "string",
          description: "Clear description of the workspace's purpose",
        },
        initialConfig: {
          type: "object",
          description:
            "Optional initial workspace configuration following the WorkspaceConfig schema",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    }),
    execute: async ({ name, description, initialConfig }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_draft_create called", {
        name,
        description,
        hasInitialConfig: !!initialConfig,
      });

      try {
        // Validate the name using the schema
        const nameValidation = MCPToolNameSchema.safeParse(name);
        if (!nameValidation.success) {
          return {
            success: false,
            error: nameValidation.error.issues[0].message,
          };
        }

        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.createDraft({
          name,
          description,
          sessionId,
          userId: "system",
          initialConfig,
        });

        // Validate if initial config was provided
        let validationStatus = { valid: true, errors: [] as Array<{ message?: string }> };
        if (initialConfig) {
          const result = await validateDraftConfig(draft.config);
          validationStatus = {
            valid: result.valid,
            errors: result.errors || [],
          };
        }

        return {
          success: true,
          draftId: draft.id,
          message: initialConfig
            ? `Created draft workspace '${name}' with initial configuration.`
            : `Created draft workspace '${name}'. Now let's design the agents and workflow.`,
          validation: validationStatus,
          configSummary: initialConfig
            ? {
              agentCount: Object.keys(draft.config.agents || {}).length,
              jobCount: Object.keys(draft.config.jobs || {}).length,
              hasSignals: Object.keys(draft.config.signals || {}).length > 0,
            }
            : undefined,
        };
      } catch (error) {
        logger.error("Error creating workspace draft", { error });
        return {
          success: false,
          error: `Error creating draft: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  workspace_draft_update: {
    description: "Update the draft workspace configuration based on user feedback",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID",
        },
        updates: {
          type: "object",
          description: "Configuration updates to apply (Partial<WorkspaceConfig>)",
        },
        updateDescription: {
          type: "string",
          description: "Natural language description of what changed",
        },
      },
      required: ["draftId", "updates", "updateDescription"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, updates, updateDescription }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_draft_update called", {
        draftId,
        updateDescription,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.updateDraft(draftId, updates, updateDescription);

        // Validate the updated configuration
        const validationResult = await validateDraftConfig(draft.config);
        const crossRefErrors = validateCrossReferences(draft.config);

        const isValid = validationResult.valid && crossRefErrors.length === 0;

        return {
          success: true,
          draftId: draft.id,
          message: updateDescription,
          validation: {
            valid: isValid,
            errors: [
              ...(validationResult.errors || []),
              ...crossRefErrors.map((msg) => ({ message: msg })),
            ],
          },
          configSummary: {
            agentCount: Object.keys(draft.config.agents || {}).length,
            jobCount: Object.keys(draft.config.jobs || {}).length,
            hasSignals: Object.keys(draft.config.signals || {}).length > 0,
          },
          nextSteps: isValid
            ? ["Configuration is valid. Ready to publish or make further changes."]
            : ["Fix validation errors before publishing."],
        };
      } catch (error) {
        logger.error("Error updating workspace draft", { error });
        return {
          success: false,
          error: `Error updating draft: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  publish_workspace: {
    description: "Publish a draft workspace to the filesystem, making it available for use",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID to publish",
        },
        path: {
          type: "string",
          description: "Optional path where workspace should be created",
        },
      },
      required: ["draftId"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, path }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: publish_workspace called", {
        draftId,
        path,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.getDraft(draftId);

        if (!draft) {
          return {
            success: false,
            error: `Draft ${draftId} not found`,
          };
        }

        // Validate the config before publishing using the daemon API
        const validationResult = await validateDraftConfig(draft.config);
        if (!validationResult.valid) {
          return {
            success: false,
            error: "Configuration validation failed. Please fix errors before publishing.",
            validation: {
              valid: false,
              errors: validationResult.errors,
              formattedError: validationResult.formattedError,
              suggestions: generateValidationFixSuggestions(validationResult.errors || []),
            },
          };
        }

        // Also do local schema validation for the YAML generation
        const schemaValidation = WorkspaceConfigSchema.safeParse(draft.config);
        if (!schemaValidation.success) {
          return {
            success: false,
            error: `Configuration validation failed: ${schemaValidation.error.message}`,
            issues: schemaValidation.error.issues,
          };
        }

        // Generate YAML from validated config
        const yaml = stringify(draft.config);

        // Get current working directory if no path specified
        const cwd = path || Deno.cwd();

        // Call daemon API to create workspace
        const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
        const response = await fetch(`${daemonUrl}/api/workspaces/create-from-config`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: draft.name,
            description: draft.description,
            config: yaml,
            path,
            cwd, // Add CWD to request
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error("Failed to publish workspace", { error, status: response.status });
          return {
            success: false,
            error: `Failed to publish workspace: ${error}`,
          };
        }

        const workspace = await response.json();

        // Mark draft as published
        await adapter.publishDraft(draftId);

        return {
          success: true,
          workspaceId: workspace.id,
          path: workspace.path,
          message: `Successfully published workspace '${draft.name}'`,
          summary: {
            agents: Object.keys(draft.config.agents || {}).length,
            jobs: Object.keys(draft.config.jobs || {}).length,
            iterations: draft.iterations.length,
          },
        };
      } catch (error) {
        logger.error("Error publishing workspace", { error });
        return {
          success: false,
          error: `Error publishing workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  show_draft_config: {
    description: "Display the current draft workspace configuration in YAML format",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID",
        },
        format: {
          type: "string",
          enum: ["yaml", "summary"],
          default: "summary",
          description: "Output format",
        },
      },
      required: ["draftId"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, format = "summary" }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: show_draft_config called", {
        draftId,
        format,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.getDraft(draftId);

        if (!draft) {
          return {
            success: false,
            error: `Draft ${draftId} not found`,
          };
        }

        if (format === "yaml") {
          return {
            success: true,
            config: stringify(draft.config),
            iterations: draft.iterations.length,
          };
        } else {
          return {
            success: true,
            summary: {
              name: draft.name,
              description: draft.description,
              agents: Object.entries(draft.config.agents || {}).map((
                [id, agent]: [string, any],
              ) => ({
                id,
                purpose: agent.purpose,
                type: agent.type,
              })),
              jobs: Object.entries(draft.config.jobs || {}).map(([id, job]: [string, any]) => ({
                id,
                description: job.description,
                agentCount: job.execution?.agents?.length || 0,
              })),
              signals: Object.keys(draft.config.signals || {}),
              tools: Object.keys(draft.config.tools?.mcp?.servers || {}),
            },
          };
        }
      } catch (error) {
        logger.error("Error showing draft config", { error });
        return {
          success: false,
          error: `Error showing config: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  list_session_drafts: {
    description: "List all draft workspaces for the current session",
    parameters: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (_) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: list_session_drafts called", { sessionId });

      try {
        const adapter = await getDraftStorageAdapter();
        const drafts = await adapter.getSessionDrafts(sessionId);

        return {
          success: true,
          drafts: drafts.map((d) => ({
            id: d.id,
            name: d.name,
            description: d.description,
            createdAt: d.createdAt,
            agentCount: Object.keys(d.config.agents || {}).length,
            jobCount: Object.keys(d.config.jobs || {}).length,
          })),
        };
      } catch (error) {
        logger.error("Error listing session drafts", { error });
        return {
          success: false,
          error: `Error listing drafts: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  validate_draft_config: {
    description: "Validate the current draft workspace configuration without publishing",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID to validate",
        },
      },
      required: ["draftId"],
      additionalProperties: false,
    }),
    execute: async ({ draftId }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: validate_draft_config called", { draftId });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.getDraft(draftId);

        if (!draft) {
          return {
            success: false,
            error: `Draft ${draftId} not found`,
          };
        }

        // Validate the configuration
        const validationResult = await validateDraftConfig(draft.config);
        const crossRefErrors = validateCrossReferences(draft.config);

        const isValid = validationResult.valid && crossRefErrors.length === 0;

        if (isValid) {
          return {
            success: true,
            valid: true,
            message: "Configuration is valid and ready to publish",
          };
        } else {
          return {
            success: true,
            valid: false,
            errors: validationResult.errors,
            crossReferenceErrors: crossRefErrors,
            formattedError: validationResult.formattedError,
            suggestions: [
              ...generateValidationFixSuggestions(validationResult.errors || []),
              ...crossRefErrors,
            ],
          };
        }
      } catch (error) {
        logger.error("Error validating draft config", { error });
        return {
          success: false,
          error: `Error validating config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  pre_publish_check: {
    description:
      "Run all validation checks before publishing a workspace - use this before publish_workspace",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID to check",
        },
      },
      required: ["draftId"],
      additionalProperties: false,
    }),
    execute: async ({ draftId }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: pre_publish_check called", { draftId });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.getDraft(draftId);

        if (!draft) {
          return {
            success: false,
            error: `Draft ${draftId} not found`,
          };
        }

        // Run all validations
        const validation = await validateDraftConfig(draft.config);
        const crossRefs = validateCrossReferences(draft.config);

        const hasAgents = Object.keys(draft.config.agents || {}).length > 0;
        const hasJobs = Object.keys(draft.config.jobs || {}).length > 0;
        const hasSignals = Object.keys(draft.config.signals || {}).length > 0;

        const ready = validation.valid && crossRefs.length === 0 && hasAgents && hasJobs &&
          hasSignals;

        return {
          success: true,
          ready,
          checks: {
            schemaValid: validation.valid
              ? "✅ Schema validation passed"
              : "❌ Schema validation failed",
            crossReferences: crossRefs.length === 0
              ? "✅ All references valid"
              : `❌ ${crossRefs.join("; ")}`,
            hasAgents: hasAgents
              ? `✅ Has ${Object.keys(draft.config.agents || {}).length} agent(s)`
              : "❌ No agents defined",
            hasJobs: hasJobs
              ? `✅ Has ${Object.keys(draft.config.jobs || {}).length} job(s)`
              : "❌ No jobs defined",
            hasSignals: hasSignals
              ? `✅ Has ${Object.keys(draft.config.signals || {}).length} signal(s)`
              : "❌ No signals defined",
          },
          message: ready
            ? "✅ All checks passed! Workspace is ready to publish."
            : "❌ Workspace needs fixes before publishing.",
          nextSteps: ready ? ["Ready to publish! Use publish_workspace to complete."] : [
            ...(validation.valid ? [] : ["Fix schema validation errors"]),
            ...(crossRefs.length > 0 ? ["Fix cross-reference errors"] : []),
            ...(hasAgents ? [] : ["Add at least one agent"]),
            ...(hasJobs ? [] : ["Add at least one job"]),
            ...(hasSignals ? [] : ["Add at least one signal"]),
          ],
        };
      } catch (error) {
        logger.error("Error in pre-publish check", { error });
        return {
          success: false,
          error: `Error checking workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  // =================================================================
  // LIBRARY ACCESS TOOLS
  // =================================================================

  library_list: {
    description: "List library items with optional filtering by type, tags, or date range",
    parameters: jsonSchema({
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["report", "session_archive", "template", "artifact", "user_upload"],
          description: "Filter by library item type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (e.g., ['session-report', 'analysis'])",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of items to return",
        },
        workspaceId: {
          type: "string",
          description: "Optional workspace ID to filter results to specific workspace",
        },
      },
      additionalProperties: false,
    }),
    execute: async ({ type, tags, limit = 20, workspaceId }) => {
      const client = new AtlasClient();

      try {
        const query = {
          type,
          tags,
          limit,
        };

        const result = workspaceId
          ? await client.listWorkspaceLibraryItems(workspaceId, query)
          : await client.listLibraryItems(query);

        return {
          success: true,
          items: result.items.map((item) => ({
            id: item.id,
            type: item.type,
            name: item.name,
            size: item.size_bytes,
            created: item.created_at,
            tags: item.tags,
            description: item.description,
          })),
          total: result.total,
          message: `Found ${result.items.length} library items${
            workspaceId ? ` in workspace ${workspaceId}` : ""
          }`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to list library items: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  library_get: {
    description: "Get specific library item with full content for analysis and discussion",
    parameters: jsonSchema({
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The ID of the library item to retrieve",
        },
        includeContent: {
          type: "boolean",
          default: true,
          description: "Whether to include the full content of the item",
        },
        workspaceId: {
          type: "string",
          description: "Optional workspace ID if this is a workspace-specific item",
        },
      },
      required: ["itemId"],
      additionalProperties: false,
    }),
    execute: async ({ itemId, includeContent = true, workspaceId }) => {
      const client = new AtlasClient();

      try {
        const item = workspaceId
          ? await client.getWorkspaceLibraryItem(workspaceId, itemId, includeContent)
          : await client.getLibraryItem(itemId, includeContent);

        return {
          success: true,
          item: {
            id: item.item.id,
            type: item.item.type,
            name: item.item.name,
            size: item.item.size_bytes,
            created: item.item.created_at,
            tags: item.item.tags,
            description: item.item.description,
            format: item.item.metadata.format,
            content: item.content,
          },
          message: `Retrieved library item: ${item.item.name}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to get library item: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  library_search: {
    description: "Search library items across all workspaces or globally",
    parameters: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find in item names, descriptions, or content",
        },
        type: {
          type: "string",
          enum: ["report", "session_archive", "template", "artifact", "user_upload"],
          description: "Filter by library item type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
        since: {
          type: "string",
          description: "ISO date string - only items created after this date",
        },
        until: {
          type: "string",
          description: "ISO date string - only items created before this date",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of results to return",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query, type, tags, since, until, limit = 20 }) => {
      const client = new AtlasClient();

      try {
        const searchQuery = {
          query,
          type,
          tags,
          since,
          until,
          limit,
        };

        const result = await client.searchLibrary(searchQuery);

        return {
          success: true,
          items: result.items.map((item) => ({
            id: item.id,
            type: item.type,
            name: item.name,
            size: item.size_bytes,
            created: item.created_at,
            tags: item.tags,
            description: item.description,
          })),
          total: result.total,
          query: query,
          message: `Found ${result.items.length} items matching "${query}"`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to search library: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  library_search_workspace: {
    description: "Search library items within a specific workspace",
    parameters: jsonSchema({
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "Workspace ID to search within",
        },
        query: {
          type: "string",
          description: "Search query to find in item names, descriptions, or content",
        },
        type: {
          type: "string",
          enum: ["report", "session_archive", "template", "artifact", "user_upload"],
          description: "Filter by library item type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of results to return",
        },
      },
      required: ["workspaceId", "query"],
      additionalProperties: false,
    }),
    execute: async ({ workspaceId, query, type, tags, limit = 20 }) => {
      const client = new AtlasClient();

      try {
        const searchQuery = {
          query,
          type,
          tags,
          limit,
        };

        const result = await client.searchWorkspaceLibrary(workspaceId, searchQuery);

        return {
          success: true,
          workspaceId,
          items: result.items.map((item) => ({
            id: item.id,
            type: item.type,
            name: item.name,
            size: item.size_bytes,
            created: item.created_at,
            tags: item.tags,
            description: item.description,
          })),
          total: result.total,
          query: query,
          message:
            `Found ${result.items.length} items matching "${query}" in workspace ${workspaceId}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to search workspace library: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },
});

export class ConversationSupervisor {
  constructor(
    private workspaceId: string,
    private workspaceContext?: any, // TODO: Add proper workspace context type
  ) {}

  async *processMessage(
    sessionId: string,
    messageId: string,
    message: string,
    fromUser: string,
    messageHistory?: ConversationMessage[], // QUICK FIX: Accept conversation history
  ): AsyncIterableIterator<ConversationEvent> {
    const timestamp = new Date().toISOString();

    // Emit thinking event
    yield {
      type: "thinking",
      data: {
        status: "processing",
        message: "ConversationSupervisor is analyzing your request...",
        fromUser,
      },
      timestamp,
      messageId,
      sessionId,
    };

    // QUICK FIX: Build conversation context from message history
    let conversationContext = "";
    if (messageHistory && messageHistory.length > 0) {
      // Include last 10 messages for context (5 exchanges)
      const recentHistory = messageHistory.slice(-10);
      conversationContext = "\n\nRECENT CONVERSATION HISTORY:\n";

      const logger = AtlasLogger.getInstance();
      logger.debug("ConversationSupervisor: Including conversation history", {
        sessionId,
        historyLength: messageHistory.length,
        recentHistoryLength: recentHistory.length,
      });

      for (const msg of recentHistory) {
        const role = msg.type === "user" ? "User" : "Assistant";
        conversationContext += `${role}: ${msg.content}\n`;
      }

      conversationContext += "\nCurrent message:\n";
    }

    const systemPrompt =
      `You are Addy, the Atlas AI assistant - your purpose is to help users work with Atlas, the AI agent orchestration platform.

  <identity>
  You are a knowledgeable, helpful assistant who understands all aspects of Atlas and guides users through various tasks with clarity and precision.
  </identity>

  <core_principles>
  1. Use cx_reply to communicate with the user - every interaction should include user communication
  2. Call cx_reply ONCE per response unless you need to provide updates during a multi-step process
  3. Explain what you're doing and why before calling other tools
  4. Be proactive in helping users understand Atlas and what you're creating for them
  5. Default to clear prose explanations; provide technical details only when requested
  </core_principles>

  <capabilities>
  <!-- Current Capabilities -->
  <capability name="explain_atlas">
  <description>Explain what Atlas is and how it works</description>
  <response>Atlas is an AI agent orchestration platform where engineers create workspaces for AI agents to collaborate on tasks. Think of it as Kubernetes for AI
   agents. You define agents, jobs, and signals in YAML files, and Atlas manages the execution.</response>
  </capability>

  <capability name="workspace_creation">
  <description>Create and configure multi-agent workspaces</description>
  <module>workspace_creation_module</module>
  </capability>

  <capability name="library_access">
  <description>Access and search the Atlas library for reports, session archives, and other workspace artifacts</description>
  <tools>
  - library_list: List library items with filtering options
  - library_get: Retrieve specific items with full content for discussion
  - library_search: Search across all libraries with flexible queries
  - library_search_workspace: Search within specific workspaces
  </tools>
  <use_cases>
  - Analyze AI agent discovery reports
  - Review session execution details
  - Compare findings across time periods
  - Explore workspace artifacts and templates
  </use_cases>
  </capability>

  <!-- Future capabilities can be added here -->
  <!-- Examples: workspace management, monitoring, debugging, etc. -->
  </capabilities>

  <!-- WORKSPACE CREATION MODULE - Full fidelity preserved -->
  <workspace_creation_module>

  <critical_workflow_requirement>
  IMPORTANT: Follow a two-step process for workspace creation:
  
  STEP 1 - PLANNING:
  - Start with cx_reply to describe what you plan to build
  - Do not call workspace_draft_create in your first response
  - Present a clear plan and ask for user confirmation
  - This gives users a chance to correct misunderstandings early
  
  STEP 2 - BUILDING (only after user approval):
  - Only proceed with workspace_draft_create after user confirms the plan
  - Then validate and iterate as needed
  </critical_workflow_requirement>

  <thinking_process>
  For EVERY workspace request, mentally work through:
  1. What is the user trying to accomplish? (business goal)
  2. What external systems need integration? (APIs, tools)
  3. What data flows between agents? (input/output chain)
  4. What can I reasonably infer vs what needs clarification?
  5. How should the workspace be triggered? (signal type)
  </thinking_process>

  <response_structure>
  STEP 1 - Initial Planning Response:
  Use cx_reply with:
  1. "I'll create a workspace that [restate goal]"
  2. "Here's what I'm planning to build:"
     - Signal type and trigger mechanism
     - Number and purpose of agents
     - Data flow between agents
     - Any MCP tools needed
  3. "Does this match what you have in mind?"
  
  STEP 2 - After User Confirmation:
  1. Call workspace_draft_create with full configuration
  2. Validate and fix any errors
  3. Report status and ask about publishing
  </response_structure>

  <clarification_guidelines>
  When user requests are incomplete or ambiguous:
  1. Create what you can reasonably infer
  2. Explicitly state what assumptions you made
  3. Ask specific, focused questions about missing details
  4. Provide examples of what you need

  Example:
  User: "I need a workspace for processing customer data"

  Your response:
  "I'll create a workspace for processing customer data. To design the best solution, I need to understand:

  1. **Data Source**: Where does the customer data come from? (API webhook, database, file upload, etc.)
  2. **Processing Type**: What kind of processing? (enrichment, validation, transformation, analysis?)
  3. **Output**: Where should results go? (database, notification, another API?)

  For example:
  - 'Process Stripe webhooks to enrich customer profiles and send to Slack'
  - 'Daily batch process CSV files to validate and import to database'

  Based on your needs, I'll design the appropriate agent pipeline."
  </clarification_guidelines>

  <model_selection_guide>
  When choosing models for agents:
  - **claude-3-5-haiku-20241022**: Use for simple tasks like data extraction, formatting, basic analysis
  - **claude-3-5-sonnet-20241022**: Use for complex tasks like research, detailed analysis, creative writing
  Always include a brief rationale in your explanation.
  </model_selection_guide>

  <validation_workflow>
  After creating or updating a configuration:
  1. Call validate_draft_config to check for errors
  2. If validation fails:
     - Analyze the specific errors
     - Fix the issues in the configuration
     - Explain what you're fixing and why
     - Re-validate after fixes
  3. Only suggest publishing after successful validation
  </validation_workflow>

  <workspace_patterns>
  <!-- Business Integration Pattern -->
  <pattern name="api_integration_workflow">
  <description>External API → AI Processing → Notification/Storage</description>
  <trigger>Usually HTTP webhook or scheduled</trigger>
  <agents>
  1. Data extractor (Haiku) - Parse and validate incoming data
  2. AI processor (Sonnet) - Enrich, analyze, or transform
  3. Output handler (Haiku) - Format and send to destination
  </agents>
  </pattern>

  <!-- Scheduled Automation Pattern -->
  <pattern name="scheduled_task">
  <description>Timer → Fetch → Process → Deliver</description>
  <trigger>Schedule with cron expression</trigger>
  <agents>
  1. Data fetcher (Haiku) - Retrieve from source
  2. Content processor (Sonnet) - Generate or transform
  3. Publisher (Haiku) - Send to destination
  </agents>
  </pattern>

  <!-- Code Review Pattern -->
  <pattern name="code_analysis">
  <description>Code Event → Analysis → Feedback</description>
  <trigger>GitHub webhook or manual</trigger>
  <agents>
  1. Code fetcher (Haiku) - Get PR/commit details
  2. Code analyzer (Sonnet) - Review and analyze
  3. Feedback poster (Haiku) - Post comments
  </agents>
  <note>Requires GitHub MCP server</note>
  </pattern>
  </workspace_patterns>

  <agent_prompt_templates>
  For common agent types, use these templates as starting points:

  <template name="data_extractor">
  You receive [input format] containing [expected data].

  Extract and structure the following information:
  - [Field 1]: [description]
  - [Field 2]: [description]

  Output as JSON:
  {
    "field1": "extracted value",
    "field2": "extracted value"
  }

  If data is missing or invalid, use null values and include an "errors" array.
  </template>

  <template name="ai_enricher">
  You receive [input format] with [data description].

  Your task:
  1. [Primary analysis/enrichment task]
  2. [Secondary task if applicable]

  Guidelines:
  - [Specific instruction 1]
  - [Specific instruction 2]

  Output format:
  [Describe expected output structure]
  </template>

  <template name="notifier">
  You receive [input format] to send to [destination].

  Format a [friendly/professional/technical] message that:
  - [Key point 1]
  - [Key point 2]

  [Any specific formatting requirements]
  </template>
  </agent_prompt_templates>

  <conversation_examples>
  <example scenario="incomplete_request">
  User: "Build a workspace that monitors GitHub"

  Assistant (cx_reply):
  "I'll help you create a GitHub monitoring workspace. To design the most effective solution, I need to understand what specifically you want to monitor:

  1. **What to Monitor**:
     - New pull requests?
     - Issues (created/updated)?
     - Commits to specific branches?
     - Repository stars/forks?

  2. **Action to Take**:
     - Send notifications?
     - Run automated checks?
     - Generate reports?
     - Trigger other workflows?

  3. **Frequency**:
     - Real-time via webhooks?
     - Scheduled checks?

  For example: 'Monitor new PRs and run code review' or 'Daily report of repository activity'.

  What would you like your GitHub monitoring workspace to do?"
  </example>

  <example scenario="hacker_news_monitoring">
  User: "Build an agent that monitors Hacker News for any mentions of OpenAI. When new articles are discovered, notify me in Slack with the article title, URL and an AI summary and assessment of the sentiment."

  Assistant (cx_reply ONLY - no workspace_draft_create):
  "I'll create a workspace that monitors Hacker News for OpenAI mentions and sends AI-analyzed summaries to Slack.

  Here's what I'm planning to build:

  **Trigger**: Schedule-based (every 30 minutes)
  - Regular checks for new HN articles mentioning OpenAI

  **Agents** (3 total):
  1. **HN Scanner** (Haiku) - Searches Hacker News for OpenAI mentions and extracts article details
  2. **Content Analyzer** (Sonnet) - Fetches articles, generates summaries, and analyzes sentiment
  3. **Slack Notifier** (Haiku) - Formats and sends notifications to your Slack channel

  **Data Flow**:
  - Timer → HN Scanner → Content Analyzer → Slack Notifier

  **MCP Tools Required**:
  - Web search/fetch for accessing Hacker News
  - Slack server for sending notifications

  Does this match what you have in mind? I can also make it webhook-based if you prefer real-time monitoring."

  User: "Yes, that sounds perfect!"

  [NOW the assistant calls workspace_draft_create with full configuration]
  </example>

  <example scenario="business_workflow">
  User: "Build a workspace that adds new Stripe customers to HubSpot and uses AI to summarize their company based on domain metadata or web presence. Send the summary to Slack."

  Assistant (cx_reply ONLY - no workspace_draft_create):
  "I'll create a workspace that automatically enriches new Stripe customers with AI-generated company summaries and syncs them to HubSpot and Slack.

  Here's what I'm planning to build:

  **Trigger**: HTTP webhook from Stripe
  - Receives customer.created events in real-time

  **Agents** (4 total):
  1. **Customer Parser** (Haiku) - Extracts customer data and domain from email
  2. **Company Researcher** (Sonnet) - Researches company online and generates detailed summary
  3. **HubSpot Syncer** (Haiku) - Creates/updates contact with enriched data
  4. **Slack Notifier** (Haiku) - Sends formatted summary to your team

  **Data Flow**:
  - Stripe webhook → Customer Parser → Company Researcher → HubSpot Syncer + Slack Notifier

  **MCP Tools Required**:
  - Web search for company research
  - HubSpot server for CRM integration
  - Slack server for notifications

  Does this match what you have in mind?"

  User: "Yes, let's build it!"

  [NOW the assistant calls workspace_draft_create with full configuration]
  </example>
  </conversation_examples>

  <complete_telephone_game_example>
  User: "Create a telephone game workspace with 3 agents that mishear, embellish, and create haikus"

  Assistant (cx_reply ONLY - no workspace_draft_create):
  "I'll create a telephone game workspace where messages are transformed through three stages of playful distortion.

  Here's what I'm planning to build:

  **Trigger**: CLI command
  - You'll start the game by sending a message via command line

  **Agents** (3 total):
  1. **Mishear Agent** (Haiku) - Slightly garbles the message as if misheard
  2. **Embellish Agent** (Haiku) - Makes the story more dramatic and theatrical
  3. **Haiku Agent** (Haiku) - Transforms the embellished message into a 5-7-5 haiku

  **Data Flow**:
  - Your message → Mishear → Embellish → Haiku → Final output

  The workspace will sequentially transform your input through these three creative filters, resulting in a haiku that captures the essence of your increasingly distorted message.

  Does this sound like the telephone game you had in mind?"

  User: "Yes, that's exactly what I want!"

  [NOW the assistant proceeds with workspace_draft_create]
  Your workspace_draft_create call:
  {
    name: "telephone-game",
    description: "A game of telephone where messages are transformed through mishearing, embellishment, and haiku creation",
    initialConfig: {
      version: "1.0",
      workspace: {
        name: "telephone-game",
        description: "A game of telephone where messages are transformed through mishearing, embellishment, and haiku creation"
      },
      signals: {
        "telephone-game-trigger": {
          description: "Start the telephone game with a message",
          provider: "cli"
        }
      },
      agents: {
        "mishear-agent": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Slightly mishears and garbles the incoming message",
          prompts: {
            system: "You are playing telephone and have slightly misheard the message. Introduce small, humorous errors like mishearing similar-sounding words,
  dropping articles, or slightly changing phrases. Keep the general structure but make it sound like you didn't quite catch everything correctly."
          }
        },
        "embellish-agent": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Embellishes and exaggerates the misheard message",
          prompts: {
            system: "You love to embellish stories. Take the message you received and make it more dramatic, add colorful details, use superlatives, and
  generally make it sound more exciting than it was. Don't change the core story, just make it more theatrical."
          }
        },
        "haiku-agent": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Transforms the embellished message into a haiku",
          prompts: {
            system: "You are a haiku poet. Take the message you received and distill its essence into a traditional haiku (5-7-5 syllables). Capture the key
  imagery or emotion from the embellished story."
          }
        }
      },
      jobs: {
        "telephone-game-process": {
          name: "telephone-game-process",
          description: "Run messages through the telephone game transformation",
          triggers: [{ signal: "telephone-game-trigger" }],
          execution: {
            strategy: "sequential",
            agents: [
              { id: "mishear-agent", input_source: "signal" },
              { id: "embellish-agent", input_source: "previous" },
              { id: "haiku-agent", input_source: "previous" }
            ]
          }
        }
      }
    }
  }
  </complete_telephone_game_example>

  <workspace_update_guidelines>
  When users request changes, use workspace_draft_update with direct configuration updates:

  Example: "Add an error handler agent"

  Your workspace_draft_update call:
  {
    draftId: "...",
    updates: {
      agents: {
        "error-handler": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Handle and log errors gracefully",
          prompts: {
            system: "When you receive an error, log it clearly and provide helpful context."
          }
        }
      }
    },
    updateDescription: "Added error-handler agent to handle errors gracefully"
  }
  </workspace_update_guidelines>

  <publishing_guidance>
  When the user says "publish it" or wants to finalize their workspace:
  1. FIRST call pre_publish_check to verify the configuration is valid
  2. If all checks pass, call publish_workspace with the draftId
  3. If checks fail, help the user fix the issues before publishing
  4. The workspace will be created in the user's current directory with collision detection
  5. If a directory with that name exists, it will use name-2, name-3, etc.
  6. IMPORTANT: In your cx_reply, include the FULL PATH where the workspace was created
  7. Tell the user they can cd to that directory and start using the workspace

  Example response after publishing:
  "✅ I've successfully published your workspace 'telephone-game'!

  The workspace has been created at:
  /Users/username/code/telephone-game

  You can now use it by:
  1. Navigate to the workspace: cd /Users/username/code/telephone-game
  2. Add your ANTHROPIC_API_KEY to the .env file
  3. Run signals like: deno task atlas signal trigger telephone-game-trigger"
  </publishing_guidance>

  <important_reminders>
  - Communicate with the user using cx_reply - one message per response is usually sufficient
  - Do not call workspace_draft_create in your first response - plan first
  - Follow the two-step process: Plan → Confirm → Build
  - Do not publish without validation - check configuration first
  - Ask for clarification when details are unclear
  - Explain your reasoning and what you're building
  - Mention which model you're using for each agent and why
  - Agent system prompts use "prompts.system" not "system_prompt"
  - Use full model identifiers (e.g., "claude-3-5-haiku-20241022")
  - Default to prose explanations; show YAML only when requested
  </important_reminders>

  </workspace_creation_module>

  Available tools:
  - cx_reply: Send messages to the user (REQUIRED for all responses)
  - workspace_draft_create: Create a draft workspace with optional initial configuration
  - workspace_draft_update: Update draft configuration based on user feedback
  - validate_draft_config: Validate the current draft configuration
  - pre_publish_check: Run ALL validation checks before publishing
  - show_draft_config: Display the current draft configuration
  - publish_workspace: Publish a draft workspace to make it active
  - list_session_drafts: Show all draft workspaces in the current session

  ${conversationContext}`;

    // Check for specific questions and handle them directly
    const lowerMessage = message.toLowerCase().trim();
    if (lowerMessage === "what is atlas?" || lowerMessage.includes("what is atlas")) {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: Direct response for 'what is atlas?'");

      // Emit the response directly without calling the LLM
      const atlasDescription =
        "Atlas is an AI agent orchestration platform where engineers create workspaces for AI agents to collaborate on tasks. Think of it as Kubernetes for AI agents. You define agents, jobs, and signals in YAML files, and Atlas manages the execution.";

      // Emit as message chunks for typing effect
      const words = atlasDescription.split(" ");
      let content = "";

      for (let i = 0; i < words.length; i++) {
        content += (i > 0 ? " " : "") + words[i];

        yield {
          type: "message_chunk",
          data: {
            content,
            partial: i < words.length - 1,
          },
          timestamp: new Date().toISOString(),
          messageId,
          sessionId,
        };

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Emit completion
      yield {
        type: "message_complete",
        data: {
          messageId,
          complete: true,
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };

      return; // Skip LLM call entirely
    }

    try {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: Processing message", {
        exactMessage: message,
        messageLength: message.length,
        trimmedMessage: message.trim(),
        lowercaseMessage: message.toLowerCase().trim(),
        isWhatIsAtlas: message.toLowerCase().trim() === "what is atlas?",
      });

      // Create tools with sessionId context
      const tools = createCxTools(sessionId);

      logger.debug("ConversationSupervisor: Calling LLM with tools", {
        message,
        toolNames: Object.keys(tools),
        sessionId,
        systemPromptLength: systemPrompt.length,
        systemPromptPreview: systemPrompt.substring(0, 200) + "...",
      });

      // Log the available tools
      logger.info("ConversationSupervisor: Starting LLM generation", {
        toolNames: Object.keys(tools),
        model: "claude-3-7-sonnet-latest",
        maxSteps: 10,
        timeout: 90000,
        sessionId,
        messageId,
      });

      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools,
        model: "claude-3-7-sonnet-latest",
        temperature: 0.7,
        maxSteps: 10, // Allow multiple steps for complex workspace creation workflows
        toolChoice: "auto", // Let the AI decide when to call tools (it will still follow the system prompt)
        operationContext: { operation: "conversation_supervision" },
        timeout: 90000, // 90 seconds for complex multi-agent workspace creation
      });

      logger.debug("ConversationSupervisor: LLM result", {
        toolCallsCount: result.toolCalls.length,
        toolNames: result.toolCalls.map((tc) => tc.toolName),
        toolResultsCount: result.toolResults.length,
        hasText: !!result.text,
        sessionId,
        // Add more debug info
        toolResults: result.toolResults.map((tr) => ({
          toolCallId: tr.toolCallId,
          resultType: typeof tr.result,
          hasResult: !!tr.result,
        })),
        steps: result.steps?.length || 0,
      });

      // Log detailed step information if available
      if (result.steps && result.steps.length > 0) {
        logger.info(JSON.stringify(
          {
            message: "AI SDK Steps Analysis",
            stepCount: result.steps.length,
            steps: result.steps.map((step: any, idx: number) => ({
              index: idx,
              type: step.type || "unknown",
              toolCalls: step.toolCalls?.map((tc: any) => ({
                id: tc.toolCallId,
                name: tc.toolName,
              })) || [],
              toolResults: step.toolResults?.map((tr: any) => ({
                id: tr.toolCallId,
                hasResult: !!tr.result,
              })) || [],
              hasText: !!step.text,
              textPreview: step.text?.substring(0, 100),
            })),
            sessionId,
            messageId,
          },
          null,
          2,
        ));
      }

      // Log the full result for debugging
      logger.info(JSON.stringify(
        {
          message: "ConversationSupervisor: Full LLM result",
          toolCallsLength: result.toolCalls.length,
          toolResultsLength: result.toolResults.length,
          stepsLength: result.steps?.length || 0,
          hasText: !!result.text,
          text: result.text?.substring(0, 100) || "NO TEXT",
          firstToolResult: result.toolResults.length > 0
            ? {
              toolCallId: result.toolResults[0].toolCallId,
              result: result.toolResults[0].result,
              hasResult: !!result.toolResults[0].result,
            }
            : null,
          sessionId,
        },
        null,
        2,
      ));

      // Log detailed tool call information
      if (result.toolCalls.length > 0) {
        logger.info(JSON.stringify(
          {
            message: "ConversationSupervisor: Tool calls made",
            toolCalls: result.toolCalls.map((tc) => ({
              name: tc.toolName,
              args: tc.args,
            })),
            sessionId,
            messageId,
          },
          null,
          2,
        ));
      } else {
        logger.error(JSON.stringify(
          {
            message: "ConversationSupervisor: No tool calls made for message",
            error: message,
            sessionId,
            messageId,
          },
          null,
          2,
        ));
      }

      // Emit tool call events for ALL tools from ALL steps
      const allToolCalls: Array<{ toolName: string; args: any }> = [];

      // Collect tool calls from all steps
      if (result.steps && result.steps.length > 0) {
        for (const step of result.steps as any[]) {
          if (step.toolCalls && Array.isArray(step.toolCalls)) {
            for (const toolCall of step.toolCalls) {
              allToolCalls.push({
                toolName: toolCall.toolName,
                args: toolCall.args,
              });
            }
          }
        }
      }

      // Also include top-level tool calls (if not already in steps)
      for (const toolCall of result.toolCalls) {
        // Check if this tool call is already in allToolCalls
        const exists = allToolCalls.some((tc) =>
          tc.toolName === toolCall.toolName &&
          JSON.stringify(tc.args) === JSON.stringify(toolCall.args)
        );
        if (!exists) {
          allToolCalls.push({
            toolName: toolCall.toolName,
            args: toolCall.args,
          });
        }
      }

      // Emit tool call events
      if (allToolCalls.length > 0) {
        const logger = AtlasLogger.getInstance();
        logger.info(`Emitting ${allToolCalls.length} tool call events`, {
          toolNames: allToolCalls.map((tc) => tc.toolName),
          sessionId,
          messageId,
        });

        for (const toolCall of allToolCalls) {
          logger.debug("ConversationSupervisor tool call", {
            toolName: toolCall.toolName,
            args: toolCall.args,
            sessionId,
            messageId,
          });

          yield {
            type: "tool_call",
            data: {
              toolName: toolCall.toolName,
              args: toolCall.args,
            },
            timestamp: new Date().toISOString(),
            messageId,
            sessionId,
          };
        }
      }

      // Check if workspace tools were called without cx_reply
      // Check both top-level and in steps
      const allToolCallsFromSteps: any[] = [];
      if (result.steps) {
        for (const step of result.steps as any[]) {
          if (step.toolCalls && Array.isArray(step.toolCalls)) {
            allToolCallsFromSteps.push(...step.toolCalls);
          }
        }
      }

      const allToolCallsCombined = [...result.toolCalls, ...allToolCallsFromSteps];

      const workspaceToolsCalled = allToolCallsCombined.filter((tc) =>
        [
          "workspace_draft_create",
          "update_workspace_config",
          "publish_workspace",
          "show_draft_config",
        ].includes(tc.toolName)
      );
      const cxReplyCalled = allToolCallsCombined.some((tc) => tc.toolName === "cx_reply");

      // CRITICAL FIX: Handle case where cx_reply was called but results are missing
      // Note: allToolResults hasn't been populated yet at this point, so check steps directly
      const hasAnyToolResults = result.toolResults.length > 0 ||
        (result.steps?.some((step: any) => step.toolResults && step.toolResults.length > 0) ||
          false);

      if (cxReplyCalled && !hasAnyToolResults) {
        logger.error("CRITICAL: cx_reply was called but no results returned", {
          toolCalls: allToolCallsCombined.filter((tc) => tc.toolName === "cx_reply"),
          sessionId,
          messageId,
        });

        // Extract the message from the tool call args as a fallback
        const cxReplyCall = allToolCallsCombined.find((tc) => tc.toolName === "cx_reply");
        if (cxReplyCall && cxReplyCall.args) {
          const args = cxReplyCall.args as { message?: string; transparency?: any };
          if (args.message) {
            // Emit the message directly as a fallback
            const words = args.message.split(" ");
            let content = "";

            for (let i = 0; i < words.length; i++) {
              content += (i > 0 ? " " : "") + words[i];

              yield {
                type: "message_chunk",
                data: {
                  content,
                  partial: i < words.length - 1,
                },
                timestamp: new Date().toISOString(),
                messageId,
                sessionId,
              };

              await new Promise((resolve) => setTimeout(resolve, 10));
            }

            // Emit transparency if available
            if (args.transparency) {
              yield {
                type: "transparency",
                data: args.transparency,
                timestamp: new Date().toISOString(),
                messageId,
                sessionId,
              };
            }
          }
        }
      }

      // Collect ALL tool results from ALL steps
      const allToolResults: Array<{ toolCallId: string; result: any }> = [];
      const processedToolCalls = new Set<string>();

      // Process results from all steps if available
      if (result.steps && result.steps.length > 0) {
        logger.info("Processing tool results from steps", {
          stepCount: result.steps.length,
          sessionId,
          messageId,
        });

        for (const step of result.steps as any[]) {
          if (step.toolResults && Array.isArray(step.toolResults)) {
            for (const toolResult of step.toolResults) {
              if (!processedToolCalls.has(toolResult.toolCallId)) {
                allToolResults.push(toolResult);
                processedToolCalls.add(toolResult.toolCallId);
              }
            }
          }
        }
      }

      // Also include top-level tool results (in case they're not in steps)
      for (const toolResult of result.toolResults) {
        if (!processedToolCalls.has(toolResult.toolCallId)) {
          allToolResults.push(toolResult);
          processedToolCalls.add(toolResult.toolCallId);
        }
      }

      // Check if we have tool calls but no results
      if (result.toolCalls.length > 0 && allToolResults.length === 0) {
        logger.error("Tool calls were made but no tool results were returned", {
          toolCalls: result.toolCalls.map((tc) => ({ name: tc.toolName, id: tc.toolCallId })),
          sessionId,
          messageId,
        });
      }

      // Process tool results and emit events
      if (allToolResults.length > 0) {
        logger.info(JSON.stringify(
          {
            message: "Processing ALL tool results (from steps and top-level)",
            totalCount: allToolResults.length,
            originalCount: result.toolResults.length,
            fromSteps: allToolResults.length - result.toolResults.length,
            toolResults: allToolResults.map((tr, idx) => ({
              index: idx,
              toolCallId: tr.toolCallId,
              resultType: typeof tr.result,
              hasResult: !!tr.result,
              resultKeys: tr.result ? Object.keys(tr.result) : [],
            })),
            sessionId,
            messageId,
          },
          null,
          2,
        ));

        // Log mismatches between tool calls and results
        const toolCallIds = result.toolCalls.map((tc) => tc.toolCallId);
        const toolResultIds = allToolResults.map((tr) => tr.toolCallId);
        const missingResults = toolCallIds.filter((id) => !toolResultIds.includes(id));

        if (missingResults.length > 0) {
          logger.error(JSON.stringify(
            {
              message: "CRITICAL: Tool calls missing results",
              toolCallIds,
              toolResultIds,
              missingResults,
              missingTools: result.toolCalls
                .filter((tc) => missingResults.includes(tc.toolCallId))
                .map((tc) => ({ id: tc.toolCallId, name: tc.toolName })),
              sessionId,
              messageId,
            },
            null,
            2,
          ));

          // FALLBACK: Manually execute tools that are missing results
          const tools = createCxTools(sessionId);
          for (const toolCall of result.toolCalls) {
            if (missingResults.includes(toolCall.toolCallId)) {
              logger.warn(`Manually executing missing tool: ${toolCall.toolName}`, {
                toolCallId: toolCall.toolCallId,
                sessionId,
                messageId,
              });

              const tool = tools[toolCall.toolName];
              if (tool && tool.execute) {
                try {
                  const manualResult = await tool.execute(toolCall.args, {
                    toolCallId: toolCall.toolCallId,
                    messages: [],
                  });
                  allToolResults.push({
                    toolCallId: toolCall.toolCallId,
                    result: manualResult,
                  });
                  logger.info(`Successfully executed missing tool: ${toolCall.toolName}`, {
                    toolCallId: toolCall.toolCallId,
                    hasResult: !!manualResult,
                    sessionId,
                    messageId,
                  });
                } catch (error) {
                  logger.error(`Failed to manually execute tool: ${toolCall.toolName}`, {
                    toolCallId: toolCall.toolCallId,
                    error: error instanceof Error ? error.message : String(error),
                    sessionId,
                    messageId,
                  });
                }
              }
            }
          }
        }

        // Process ALL tool results from all steps
        // Create a map to avoid processing duplicate cx_reply messages
        const processedMessages = new Set<string>();

        for (const toolResultWrapper of allToolResults) {
          const toolResult = toolResultWrapper.result as any;

          // Find which tool was called - check all steps for tool calls
          let toolName: string | undefined;

          // First check top-level tool calls
          let toolCall = result.toolCalls.find((tc) =>
            tc.toolCallId === toolResultWrapper.toolCallId
          );

          // If not found in top-level, check in steps
          if (!toolCall && result.steps) {
            for (const step of result.steps as any[]) {
              if (step.toolCalls && Array.isArray(step.toolCalls)) {
                toolCall = step.toolCalls.find((tc: any) =>
                  tc.toolCallId === toolResultWrapper.toolCallId
                );
                if (toolCall) break;
              }
            }
          }

          toolName = toolCall?.toolName;

          logger.info(JSON.stringify(
            {
              message: "Processing individual tool result",
              toolName,
              toolCallId: toolResultWrapper.toolCallId,
              hasToolResult: !!toolResult,
              toolResultType: typeof toolResult,
              toolResultKeys: toolResult ? Object.keys(toolResult) : [],
              sessionId,
              messageId,
            },
            null,
            2,
          ));

          if (!toolResult) continue;

          // Handle cx_reply tool result
          if (toolName === "cx_reply" && toolResult.message) {
            // Check if we've already processed this exact message
            const messageHash = JSON.stringify({
              message: toolResult.message,
              transparency: toolResult.transparency,
            });
            if (processedMessages.has(messageHash)) {
              logger.info("Skipping duplicate cx_reply message", {
                toolCallId: toolResultWrapper.toolCallId,
                messageLength: toolResult.message.length,
                sessionId,
                messageId,
              });
              continue;
            }
            processedMessages.add(messageHash);

            logger.info(JSON.stringify(
              {
                message: "Processing cx_reply tool result",
                messageLength: toolResult.message.length,
                hasTransparency: !!toolResult.transparency,
                sessionId,
                messageId,
              },
              null,
              2,
            ));
            const words = toolResult.message.split(" ");
            let content = "";

            for (let i = 0; i < words.length; i++) {
              content += (i > 0 ? " " : "") + words[i];

              // Log every 10th word or the last word
              if (i % 10 === 0 || i === words.length - 1) {
                logger.debug(JSON.stringify(
                  {
                    message: "Yielding message chunk",
                    wordIndex: i,
                    totalWords: words.length,
                    contentLength: content.length,
                    sessionId,
                    messageId,
                  },
                  null,
                  2,
                ));
              }

              yield {
                type: "message_chunk",
                data: {
                  content,
                  partial: i < words.length - 1,
                },
                timestamp: new Date().toISOString(),
                messageId,
                sessionId,
              };

              // Small delay for realistic typing feel - skip delay for duplicate messages
              if (allToolResults.length <= 1) {
                await new Promise((resolve) => setTimeout(resolve, 5)); // Reduced delay for single messages
              }
              // No delay for multiple tool results to avoid long waits
            }
          }

          // Emit transparency data (from cx_reply)
          if (toolName === "cx_reply" && toolResult.transparency) {
            const logger = AtlasLogger.getInstance();
            logger.debug("ConversationSupervisor reasoning", {
              analysis: toolResult.transparency.analysis,
              confidence: toolResult.transparency.confidence,
              complexity: toolResult.transparency.complexity,
              requiresAgentCoordination: toolResult.transparency.requiresAgentCoordination,
              sessionId,
              messageId,
            });

            yield {
              type: "transparency",
              data: toolResult.transparency,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };
          }

          // Emit orchestration data if present
          if (toolResult.orchestration) {
            yield {
              type: "orchestration",
              data: toolResult.orchestration,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };
          }
        } // End of for loop processing all tool results
      }

      // Handle case where no tools were called at all
      // Check both top-level toolCalls AND tool calls in steps
      const hasToolCallsInSteps = result.steps?.some((step: any) =>
        step.toolCalls && step.toolCalls.length > 0
      ) || false;

      if (result.toolCalls.length === 0 && !hasToolCallsInSteps) {
        logger.error("ConversationSupervisor: No tools were called, which should not happen", {
          message,
          sessionId,
          messageId,
        });

        // Emit a default error message
        const errorMessage =
          "I apologize, but I encountered an issue processing your request. Please try rephrasing your workspace creation request.";
        const words = errorMessage.split(" ");
        let content = "";

        for (let i = 0; i < words.length; i++) {
          content += (i > 0 ? " " : "") + words[i];

          yield {
            type: "message_chunk",
            data: {
              content,
              partial: i < words.length - 1,
            },
            timestamp: new Date().toISOString(),
            messageId,
            sessionId,
          };

          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // If workspace tools were called without cx_reply, provide a default message
      if (workspaceToolsCalled.length > 0 && !cxReplyCalled) {
        logger.warn("ConversationSupervisor: Workspace tools called without cx_reply follow-up", {
          tools: workspaceToolsCalled.map((tc) => tc.toolName),
          sessionId,
          messageId,
        });

        // Generate a continuation message based on what tools were called
        let continuationMessage = "";

        for (const toolCall of workspaceToolsCalled) {
          const toolResult = result.toolResults.find((tr) => tr.toolCallId === toolCall.toolCallId)
            ?.result as any;

          if (toolCall.toolName === "workspace_draft_create" && toolResult?.success) {
            const workspaceName = toolResult.message?.match(/'([^']+)'/)?.[1] || "your workspace";
            continuationMessage =
              `I've created a draft workspace called '${workspaceName}' for your telephone game. ${
                toolResult.suggestionsText || toolResult.suggestions?.join(" ") ||
                "What would you like to add to this workspace?"
              }`;
          } else if (toolCall.toolName === "update_workspace_config" && toolResult?.success) {
            continuationMessage = `${
              toolResult.message || "I've updated your workspace configuration."
            }${toolResult.nextSteps ? "\n\nNext steps:\n" + toolResult.nextSteps.join("\n") : ""}`;
          } else if (toolCall.toolName === "show_draft_config" && toolResult?.success) {
            const args = toolCall.args as { format?: string };
            if (args.format === "yaml" && toolResult.config) {
              continuationMessage =
                `Here's your current workspace configuration in YAML format:\n\n\`\`\`yaml\n${toolResult.config}\`\`\`\n\nWhat would you like to modify or shall we proceed to publish it?`;
            } else if (toolResult.summary) {
              const summary = toolResult.summary;
              let summaryText = `Here's your current workspace configuration:\n\n`;
              summaryText += `**Workspace**: ${summary.name}\n`;
              summaryText += `**Description**: ${summary.description}\n\n`;

              if (summary.agents && summary.agents.length > 0) {
                summaryText += `**Agents** (${summary.agents.length}):\n`;
                summary.agents.forEach(
                  (agent: { id: string; purpose: string; type: string }, i: number) => {
                    summaryText += `${i + 1}. **${agent.id}** - ${agent.purpose} (${agent.type})\n`;
                  },
                );
                summaryText += `\n`;
              }

              if (summary.jobs && summary.jobs.length > 0) {
                summaryText += `**Jobs** (${summary.jobs.length}):\n`;
                summary.jobs.forEach(
                  (job: { id: string; description: string; agentCount: number }, i: number) => {
                    summaryText += `${
                      i + 1
                    }. **${job.id}** - ${job.description} (${job.agentCount} agents)\n`;
                  },
                );
                summaryText += `\n`;
              }

              if (summary.signals && summary.signals.length > 0) {
                summaryText += `**Signals**: ${summary.signals.join(", ")}\n`;
              }

              if (summary.tools && summary.tools.length > 0) {
                summaryText += `**MCP Tools**: ${summary.tools.join(", ")}\n`;
              }

              summaryText += `\nWhat would you like to modify or shall we proceed to publish it?`;
              continuationMessage = summaryText;
            } else {
              continuationMessage =
                "Here's your current workspace configuration. What would you like to modify or shall we proceed to publish it?";
            }
          } else if (toolCall.toolName === "publish_workspace" && toolResult?.success) {
            // Include the full path in the continuation message
            const workspacePath = toolResult.path;
            const workspaceName = toolResult.message?.match(/'([^']+)'/)?.[1] || "your workspace";
            continuationMessage = `✅ I've successfully published ${workspaceName}!\n\n` +
              `The workspace has been created at:\n` +
              `\`${workspacePath}\`\n\n` +
              `You can now use it by:\n` +
              `1. Navigate to the workspace: \`cd ${workspacePath}\`\n` +
              `2. Add your ANTHROPIC_API_KEY to the .env file\n` +
              `3. Run signals like: \`deno task atlas signal trigger ${workspaceName}-trigger\``;
          }
        }

        // Emit the continuation message if we generated one
        if (continuationMessage) {
          const words = continuationMessage.split(" ");
          let content = "";

          for (let i = 0; i < words.length; i++) {
            content += (i > 0 ? " " : "") + words[i];

            yield {
              type: "message_chunk",
              data: {
                content,
                partial: i < words.length - 1,
              },
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };

            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }

      // Emit completion event
      yield {
        type: "message_complete",
        data: {
          messageId,
          complete: true,
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };
    } catch (error) {
      // Emit error event
      yield {
        type: "message_complete",
        data: {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };
    }
  }
}
