/**
 * Built-in Workspace Capabilities Registry
 * Manages ambient workspace capabilities that are available to agents
 */

import type { WorkspaceAgentConfig, WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import { DaemonCapabilityRegistry } from "./daemon-capabilities.ts";
import { ConversationDraftAdapter, createKVStorage, StorageConfigs } from "./storage/index.ts";
import {
  generateValidationFixSuggestions,
  validateCrossReferences,
} from "./services/workspace-conversation-helpers.ts";
import { stringify } from "@std/yaml";
import { AtlasClient } from "@atlas/client";
import { z } from "zod/v4";

export interface WorkspaceCapability {
  id: string;
  name: string;
  description: string;
  category: "jobs" | "sessions" | "memory" | "signals" | "workspace";
  inputSchema?: any; // JSON Schema for input validation
  implementation: (context: AgentExecutionContext, ...args: any[]) => Promise<any>;
}

export interface AgentExecutionContext {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  conversationId?: string; // For conversation workspaces
  // Runtime services
  workspaceRuntime?: any;
  sessionSupervisor?: any;
  memoryManager?: any;
  responseChannel?: any; // For streaming responses
}

export interface CapabilityFilter {
  agentId: string;
  agentConfig: WorkspaceAgentConfig;
  grantedTools: string[];
}

// Create a singleton draft storage adapter
let draftStorageAdapter: ConversationDraftAdapter | null = null;

async function getDraftStorageAdapter(): Promise<ConversationDraftAdapter> {
  if (!draftStorageAdapter) {
    const kvStorage = await createKVStorage(StorageConfigs.defaultKV());
    draftStorageAdapter = new ConversationDraftAdapter(kvStorage);
    await draftStorageAdapter.initialize();
  }
  return draftStorageAdapter;
}

// MCP tool name validation - dots are illegal in MCP tool names
const MCPToolNameSchema = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_-]*$/,
  "MCP tool names must start with a letter and contain only letters, numbers, underscores, and hyphens (no dots)",
);

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
      return {
        valid: false,
        errors: [{ message: error }],
      };
    }

    return await response.json();
  } catch (error) {
    return {
      valid: false,
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export class WorkspaceCapabilityRegistry {
  private static capabilities = new Map<string, WorkspaceCapability>();
  private static initialized = false;

  /**
   * Initialize built-in workspace capabilities
   */
  static initialize(): void {
    if (this.initialized) return;

    // Jobs capabilities
    this.registerCapability({
      id: "workspace_jobs_trigger",
      name: "Trigger Job",
      description: "Trigger a job in the current workspace",
      category: "jobs",
      implementation: async (context, jobName: string, payload?: any) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.triggerJob(jobName, payload);
      },
    });

    this.registerCapability({
      id: "workspace_jobs_list",
      name: "List Jobs",
      description: "List all jobs in the current workspace",
      category: "jobs",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.listJobs();
      },
    });

    this.registerCapability({
      id: "workspace_jobs_describe",
      name: "Describe Job",
      description: "Get detailed information about a specific job",
      category: "jobs",
      implementation: async (context, jobName: string) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.describeJob(jobName);
      },
    });

    // Sessions capabilities
    this.registerCapability({
      id: "workspace_sessions_list",
      name: "List Sessions",
      description: "List all sessions in the current workspace",
      category: "sessions",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.listSessions();
      },
    });

    this.registerCapability({
      id: "workspace_sessions_describe",
      name: "Describe Session",
      description: "Get detailed information about a specific session",
      category: "sessions",
      implementation: async (context, sessionId: string) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.describeSession(sessionId);
      },
    });

    this.registerCapability({
      id: "workspace_sessions_cancel",
      name: "Cancel Session",
      description: "Cancel a running session",
      category: "sessions",
      implementation: async (context, sessionId: string) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.cancelSession(sessionId);
      },
    });

    // Memory capabilities
    this.registerCapability({
      id: "workspace_memory_recall",
      name: "Recall Memory",
      description: "Retrieve memories based on query",
      category: "memory",
      implementation: async (context, query: string, options?: any) => {
        if (!context.memoryManager) {
          throw new Error("Memory manager not available");
        }
        return await context.memoryManager.recall(query, options);
      },
    });

    this.registerCapability({
      id: "workspace_memory_store",
      name: "Store Memory",
      description: "Store information in memory",
      category: "memory",
      implementation: async (context, content: any, type?: string) => {
        if (!context.memoryManager) {
          throw new Error("Memory manager not available");
        }
        return await context.memoryManager.store(content, type);
      },
    });

    // Signals capabilities
    this.registerCapability({
      id: "workspace_signals_list",
      name: "List Signals",
      description: "List all signals in the current workspace",
      category: "signals",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.listSignals();
      },
    });

    this.registerCapability({
      id: "workspace_signals_trigger",
      name: "Trigger Signal",
      description: "Trigger a signal in the current workspace",
      category: "signals",
      implementation: async (context, signalName: string, payload?: any) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.triggerSignal(signalName, payload);
      },
    });

    // Workspace capabilities
    this.registerCapability({
      id: "workspace_describe",
      name: "Describe Workspace",
      description: "Get information about the current workspace",
      category: "workspace",
      implementation: async (context) => {
        if (!context.workspaceRuntime) {
          throw new Error("Workspace runtime not available");
        }
        return await context.workspaceRuntime.describeWorkspace();
      },
    });

    // Workspace creation capabilities
    this.registerCapability({
      id: "workspace_draft_create",
      name: "Create Workspace Draft",
      description: "Create a new workspace draft with optional initial configuration",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (context, name: string, description: string, initialConfig?: any) => {
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
            conversationId: context.conversationId || context.sessionId,
            sessionId: context.sessionId,
            userId: "system", // TODO: Get from context
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

          // Send progress update if response channel available
          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: `Created draft workspace '${name}'`,
              details: {
                draftId: draft.id,
                status: initialConfig ? "created_with_config" : "created_empty",
                validation: validationStatus,
              },
            });
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
          return {
            success: false,
            error: `Error creating draft: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    this.registerCapability({
      id: "workspace_draft_update",
      name: "Update Workspace Draft",
      description: "Update the draft workspace configuration based on user feedback",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (context, draftId: string, updates: any, updateDescription: string) => {
        try {
          const adapter = await getDraftStorageAdapter();
          const draft = await adapter.updateDraft(draftId, updates, updateDescription);

          // Validate the updated configuration
          const validationResult = await validateDraftConfig(draft.config);
          const crossRefErrors = validateCrossReferences(draft.config);

          const isValid = validationResult.valid && crossRefErrors.length === 0;

          // Send progress update if response channel available
          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: `Updated workspace configuration`,
              details: {
                draftId: draft.id,
                updateDescription,
                valid: isValid,
                errorCount: (validationResult.errors?.length || 0) + crossRefErrors.length,
              },
            });
          }

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
          return {
            success: false,
            error: `Error updating draft: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    this.registerCapability({
      id: "validate_draft_config",
      name: "Validate Draft Config",
      description: "Validate the current draft workspace configuration without publishing",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (context, draftId: string) => {
        try {
          const adapter = await getDraftStorageAdapter();
          const conversationDraft = await adapter.getConversationDraft(draftId);
          const draft = conversationDraft || await adapter.getDraft(draftId);

          if (!draft) {
            return {
              success: false,
              error: `Draft ${draftId} not found`,
            };
          }

          // Stream validation progress
          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: "Checking agents configuration...",
            });
          }

          // Validate the configuration
          const validationResult = await validateDraftConfig(draft.config);

          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: "Validating cross-references...",
            });
          }

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
          return {
            success: false,
            error: `Error validating config: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    this.registerCapability({
      id: "pre_publish_check",
      name: "Pre-Publish Check",
      description:
        "Run all validation checks before publishing a workspace - use this before publish_workspace",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (context, draftId: string) => {
        try {
          const adapter = await getDraftStorageAdapter();
          const conversationDraft = await adapter.getConversationDraft(draftId);
          const draft = conversationDraft || await adapter.getDraft(draftId);

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
          return {
            success: false,
            error: `Error checking workspace: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    this.registerCapability({
      id: "publish_workspace",
      name: "Publish Workspace",
      description: "Publish a draft workspace to the filesystem, making it available for use",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (context, draftId: string, path?: string) => {
        try {
          const adapter = await getDraftStorageAdapter();
          const conversationDraft = await adapter.getConversationDraft(draftId);
          const draft = conversationDraft || await adapter.getDraft(draftId);

          if (!draft) {
            return {
              success: false,
              error: `Draft ${draftId} not found`,
            };
          }

          // Stream progress update
          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: "Validating configuration before publishing...",
            });
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

          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: "Creating workspace directory...",
            });
          }

          // Generate YAML from validated config
          const yaml = stringify(draft.config);

          // Get current working directory if no path specified
          const cwd = path || Deno.cwd();

          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: "Writing configuration files...",
            });
          }

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
            return {
              success: false,
              error: `Failed to publish workspace: ${error}`,
            };
          }

          const workspace = await response.json();

          if (context.responseChannel?.write) {
            await context.responseChannel.write({
              type: "progress",
              message: "Initializing workspace...",
            });
          }

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
          return {
            success: false,
            error: `Error publishing workspace: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    this.registerCapability({
      id: "show_draft_config",
      name: "Show Draft Config",
      description: "Display the current draft workspace configuration in YAML format",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (context, draftId: string, format = "summary") => {
        try {
          const adapter = await getDraftStorageAdapter();
          const conversationDraft = await adapter.getConversationDraft(draftId);
          const draft = conversationDraft || await adapter.getDraft(draftId);

          if (!draft) {
            return {
              success: false,
              error: `Draft ${draftId} not found`,
            };
          }

          if (format === "yaml") {
            // Stream YAML content if response channel available
            if (context.responseChannel?.write) {
              const yamlContent = stringify(draft.config);
              await context.responseChannel.write({
                type: "config",
                format: "yaml",
                content: yamlContent,
              });
            }

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
          return {
            success: false,
            error: `Error showing config: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    this.registerCapability({
      id: "list_session_drafts",
      name: "List Session Drafts",
      description: "List all draft workspaces for the current session",
      category: "workspace",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      implementation: async (context) => {
        try {
          const adapter = await getDraftStorageAdapter();
          const drafts = await adapter.getSessionDrafts(context.sessionId);

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
          return {
            success: false,
            error: `Error listing drafts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      },
    });

    // Library access capabilities
    this.registerCapability({
      id: "library_list",
      name: "List Library Items",
      description: "List library items with optional filtering by type, tags, or date range",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (
        context,
        type?: string,
        tags?: string[],
        limit = 20,
        workspaceId?: string,
      ) => {
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
    });

    this.registerCapability({
      id: "library_get",
      name: "Get Library Item",
      description: "Get specific library item with full content for analysis and discussion",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (
        context,
        itemId: string,
        includeContent = true,
        workspaceId?: string,
      ) => {
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
    });

    this.registerCapability({
      id: "library_search",
      name: "Search Library",
      description: "Search library items across all workspaces or globally",
      category: "workspace",
      inputSchema: {
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
      },
      implementation: async (
        context,
        query: string,
        type?: string,
        tags?: string[],
        since?: string,
        until?: string,
        limit = 20,
      ) => {
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
    });

    this.initialized = true;
  }

  /**
   * Register a new workspace capability
   */
  static registerCapability(capability: WorkspaceCapability): void {
    this.capabilities.set(capability.id, capability);
  }

  /**
   * Get all available capabilities
   */
  static getAllCapabilities(): WorkspaceCapability[] {
    this.initialize();
    return Array.from(this.capabilities.values());
  }

  /**
   * Get capability by ID
   */
  static getCapability(id: string): WorkspaceCapability | undefined {
    this.initialize();
    return this.capabilities.get(id);
  }

  /**
   * Filter capabilities for a specific agent based on granted tools
   */
  static filterCapabilitiesForAgent(filter: CapabilityFilter): WorkspaceCapability[] {
    this.initialize();

    const grantedCapabilities: WorkspaceCapability[] = [];
    const allTools = [
      ...(filter.agentConfig.default_tools || []),
      ...(Array.isArray(filter.agentConfig.tools) ? filter.agentConfig.tools : []),
      ...filter.grantedTools,
    ];

    // DEBUG: Temporary logging to understand filtering issue
    console.log(`[DEBUG] Filtering capabilities for agent ${filter.agentId}`);
    console.log(`[DEBUG] Agent config:`, filter.agentConfig);
    console.log(`[DEBUG] Granted tools:`, filter.grantedTools);
    console.log(`[DEBUG] All tools combined:`, allTools);
    console.log(`[DEBUG] Available capabilities:`, Array.from(this.capabilities.keys()));

    for (const tool of allTools) {
      console.log(`[DEBUG] Checking tool: ${tool}`);
      const capability = this.capabilities.get(tool);
      if (capability) {
        console.log(`[DEBUG] Found workspace capability for tool ${tool}:`, capability.id);
        grantedCapabilities.push(capability);
      } else {
        // Check if it's a daemon capability
        const daemonCapability = DaemonCapabilityRegistry.getCapability(tool);
        if (daemonCapability) {
          console.log(`[DEBUG] Found daemon capability for tool ${tool}:`, daemonCapability.id);
          // Convert daemon capability to workspace capability format for compatibility
          const convertedCapability: WorkspaceCapability = {
            id: daemonCapability.id,
            name: daemonCapability.name,
            description: daemonCapability.description,
            category: "sessions", // Map daemon categories to workspace categories
            inputSchema: daemonCapability.inputSchema,
            implementation: daemonCapability.implementation as any, // Type conversion for compatibility
          };
          grantedCapabilities.push(convertedCapability);
        } else {
          console.log(`[DEBUG] No capability found for tool: ${tool}`);
        }
        if (tool.endsWith("_*")) {
          // Handle wildcard patterns for workspace capabilities
          const prefix = tool.slice(0, -2);
          console.log(`[DEBUG] Checking wildcard pattern: ${prefix}_*`);
          for (const [id, cap] of this.capabilities) {
            if (id.startsWith(prefix + "_")) {
              console.log(`[DEBUG] Wildcard match: ${id}`);
              grantedCapabilities.push(cap);
            }
          }
          // Also check daemon capabilities for wildcard patterns
          DaemonCapabilityRegistry.initialize();
          for (const daemonCap of DaemonCapabilityRegistry.getAllCapabilities()) {
            if (daemonCap.id.startsWith(prefix + "_")) {
              console.log(`[DEBUG] Daemon wildcard match: ${daemonCap.id}`);
              const convertedCapability: WorkspaceCapability = {
                id: daemonCap.id,
                name: daemonCap.name,
                description: daemonCap.description,
                category: "sessions",
                inputSchema: daemonCap.inputSchema,
                implementation: daemonCap.implementation as any,
              };
              grantedCapabilities.push(convertedCapability);
            }
          }
        } else if (tool.endsWith(".*")) {
          // Handle legacy dot wildcard patterns (convert to underscore)
          const prefix = tool.slice(0, -2).replace(/\./g, "_");
          console.log(`[DEBUG] Checking legacy wildcard pattern: ${prefix}.*`);
          for (const [id, cap] of this.capabilities) {
            if (id.startsWith(prefix + "_")) {
              console.log(`[DEBUG] Legacy wildcard match: ${id}`);
              grantedCapabilities.push(cap);
            }
          }
          // Also check daemon capabilities for legacy wildcard patterns
          for (const daemonCap of DaemonCapabilityRegistry.getAllCapabilities()) {
            if (daemonCap.id.startsWith(prefix + "_")) {
              console.log(`[DEBUG] Daemon legacy wildcard match: ${daemonCap.id}`);
              const convertedCapability: WorkspaceCapability = {
                id: daemonCap.id,
                name: daemonCap.name,
                description: daemonCap.description,
                category: "sessions",
                inputSchema: daemonCap.inputSchema,
                implementation: daemonCap.implementation as any,
              };
              grantedCapabilities.push(convertedCapability);
            }
          }
        }
      }
    }

    // Remove duplicates
    const unique = new Map<string, WorkspaceCapability>();
    for (const cap of grantedCapabilities) {
      unique.set(cap.id, cap);
    }

    return Array.from(unique.values());
  }

  /**
   * Create agent execution context with filtered capabilities
   */
  static createAgentContext(
    workspaceId: string,
    sessionId: string,
    agentId: string,
    agentConfig: WorkspaceAgentConfig,
    grantedTools: string[],
    runtimeServices: {
      workspaceRuntime?: any;
      sessionSupervisor?: any;
      memoryManager?: any;
    } = {},
  ): { context: AgentExecutionContext; capabilities: WorkspaceCapability[] } {
    const context: AgentExecutionContext = {
      workspaceId,
      sessionId,
      agentId,
      ...runtimeServices,
    };

    const capabilities = this.filterCapabilitiesForAgent({
      agentId,
      agentConfig,
      grantedTools,
    });

    return { context, capabilities };
  }

  /**
   * Execute a capability
   */
  static async executeCapability(
    capabilityId: string,
    context: AgentExecutionContext,
    ...args: any[]
  ): Promise<any> {
    this.initialize();

    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(`Unknown capability: ${capabilityId}`);
    }

    return await capability.implementation(context, ...args);
  }

  /**
   * Get capability documentation
   */
  static getDocumentation(): string {
    this.initialize();

    const categories = new Map<string, WorkspaceCapability[]>();
    for (const capability of this.capabilities.values()) {
      if (!categories.has(capability.category)) {
        categories.set(capability.category, []);
      }
      categories.get(capability.category)!.push(capability);
    }

    let doc = "# Atlas Workspace Capabilities\n\n";
    doc += "Built-in capabilities available to agents in Atlas workspaces.\n\n";

    for (const [category, caps] of categories) {
      doc += `## ${category.charAt(0).toUpperCase() + category.slice(1)} Capabilities\n\n`;

      for (const cap of caps) {
        doc += `### ${cap.name} (\`${cap.id}\`)\n`;
        doc += `${cap.description}\n\n`;
      }
    }

    doc += `## Usage in Agent Configuration\n\n`;
    doc += `\`\`\`yaml\n`;
    doc += `agents:\n`;
    doc += `  my-agent:\n`;
    doc += `    type: "llm"\n`;
    doc += `    tools:\n`;
    doc += `      - "workspace_jobs_trigger"\n`;
    doc += `      - "workspace_memory_recall"\n`;
    doc += `      - "workspace_sessions_*"  # Wildcard for all session capabilities\n`;
    doc += `\`\`\`\n\n`;

    return doc;
  }

  /**
   * Reset registry (useful for testing)
   */
  static reset(): void {
    this.capabilities.clear();
    this.initialized = false;
  }
}
