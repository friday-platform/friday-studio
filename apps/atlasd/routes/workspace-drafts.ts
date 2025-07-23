import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { createDraftStore, DraftValidator, WorkspaceDraftStore } from "@atlas/workspace";
import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import { FilesystemWorkspaceCreationAdapter } from "../../../src/core/services/workspace-creation-adapter.ts";

// Create app instance using factory
const workspaceDraftRoutes = daemonFactory.createApp();

// ============================================================================
// Zod Schemas
// ============================================================================

// Input schemas
const createDraftSchema = z.object({
  name: z.string().min(1).describe("Name of the draft"),
  description: z.string().min(1).describe("Description of the draft"),
  initialConfig: z.record(z.string(), z.unknown()).optional().describe(
    "Initial workspace configuration",
  ),
  sessionId: z.string().optional().describe("Associated session ID"),
  conversationId: z.string().optional().describe("Associated conversation ID"),
}).meta({ description: "Create workspace draft request" });

const updateDraftSchema = z.object({
  updates: z.record(z.string(), z.unknown()).describe("Configuration updates to apply"),
  updateDescription: z.string().describe("Description of the updates being applied"),
}).meta({ description: "Update workspace draft request" });

const publishDraftSchema = z.object({
  path: z.string().optional().describe("Optional custom path for the workspace"),
  overwrite: z.boolean().optional().describe("Whether to overwrite existing workspace"),
}).meta({ description: "Publish draft request" });

const listDraftsQuerySchema = z.object({
  sessionId: z.string().optional().describe("Filter drafts by session ID"),
  conversationId: z.string().optional().describe("Filter drafts by conversation ID"),
  includeDetails: z.coerce.boolean().optional().describe("Include full draft details"),
}).meta({ description: "List drafts query parameters" });

const showDraftQuerySchema = z.object({
  format: z.enum(["yaml", "json", "summary"]).optional().describe(
    "Format for displaying the configuration",
  ),
}).meta({ description: "Show draft query parameters" });

const draftIdParamSchema = z.object({
  draftId: z.string().min(1).describe("Draft ID"),
}).meta({ description: "Draft ID parameter" });

// Response schemas
const workspaceDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  config: z.record(z.string(), z.unknown()),
  iterations: z.array(z.object({
    timestamp: z.string(),
    operation: z.string(),
    config: z.record(z.string(), z.unknown()),
    summary: z.string(),
  })),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["draft", "published", "abandoned"]),
  sessionId: z.string(),
  userId: z.string(),
}).meta({ description: "Workspace draft" });

const validationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
}).meta({ description: "Configuration validation result" });

const createDraftResponseSchema = z.object({
  draft: workspaceDraftSchema,
  validation: validationResultSchema.optional(),
  success: z.boolean(),
}).meta({ description: "Create draft response" });

const updateDraftResponseSchema = z.object({
  draft: workspaceDraftSchema,
  validation: validationResultSchema.optional(),
  success: z.boolean(),
}).meta({ description: "Update draft response" });

const listDraftsResponseSchema = z.object({
  drafts: z.array(workspaceDraftSchema),
  total: z.number(),
}).meta({ description: "List drafts response" });

const showDraftResponseSchema = z.object({
  draft: workspaceDraftSchema,
  config: z.string(),
  format: z.string(),
}).meta({ description: "Show draft response" });

const validateDraftResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
}).meta({ description: "Validate draft response" });

const publishDraftResponseSchema = z.object({
  success: z.boolean(),
  workspacePath: z.string().optional(),
  filesCreated: z.array(z.string()).optional(),
  error: z.string().optional(),
}).meta({ description: "Publish draft response" });

const deleteDraftResponseSchema = z.object({
  success: z.boolean(),
}).meta({ description: "Delete draft response" });

const errorResponseSchema = z.object({
  error: z.string(),
}).meta({ description: "Standard error response" });

// ============================================================================
// Helper Functions
// ============================================================================

async function getDraftStore(): Promise<WorkspaceDraftStore> {
  return await createDraftStore();
}

function validateWorkspaceConfiguration(
  config: unknown,
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  enhancedErrors?: Array<{ code: string; message: string; path?: string; suggestion?: string }>;
} {
  try {
    WorkspaceConfigSchema.parse(config);
    return { valid: true, errors: [], warnings: [] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Create enhanced error messages
      const enhancedErrors = error.issues.map((issue) => {
        const path = issue.path.join(".");
        let message = issue.message;
        let suggestion = "Check the schema documentation";

        // Specific error handling
        if (issue.code === "unrecognized_keys" && "keys" in issue) {
          const unknownKeys = issue.keys as string[];
          message = `Unknown ${unknownKeys.length > 1 ? "properties" : "property"} '${
            unknownKeys.join("', '")
          }'${path ? ` at ${path}` : ""}`;

          // Suggest available keys based on path
          const availableKeys = getAvailableKeysForPath(path);
          if (availableKeys.length > 0) {
            suggestion = `Available keys: [${availableKeys.join(", ")}]`;

            // Try to find close matches
            const closestMatches = unknownKeys.map((key) => {
              const closest = findClosestKey(key, availableKeys);
              return closest ? `Did you mean '${closest}' instead of '${key}'?` : null;
            }).filter(Boolean);

            if (closestMatches.length > 0) {
              suggestion += `. ${closestMatches.join(" ")}`;
            }
          }
        } else if (issue.code === "invalid_type") {
          const expected = "expected" in issue ? String(issue.expected) : "unknown";
          const received = "received" in issue ? String(issue.received) : "unknown";
          message = `Expected ${expected}, got ${received}${path ? ` at ${path}` : ""}`;
          suggestion = `Convert the value to ${expected}`;
        } else if (issue.code === "invalid_literal") {
          const expected = "expected" in issue ? String(issue.expected) : "unknown";
          suggestion = `Change to '${expected}'`;
        }

        return {
          code: issue.code.toUpperCase(),
          message,
          path: path || undefined,
          suggestion,
        };
      });

      const basicErrors = error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
        return `${path}${issue.message}`;
      });

      return {
        valid: false,
        errors: basicErrors,
        warnings: [],
        enhancedErrors,
      };
    }

    if (error instanceof Error) {
      return { valid: false, errors: [error.message], warnings: [] };
    }
    return { valid: false, errors: ["Unknown validation error"], warnings: [] };
  }
}

// Helper functions for enhanced validation
function getAvailableKeysForPath(path: string): string[] {
  if (!path || path === "") {
    return [
      "version",
      "workspace",
      "server",
      "tools",
      "signals",
      "jobs",
      "agents",
      "memory",
      "notifications",
      "federation",
    ];
  }

  if (path === "workspace") {
    return ["name", "description"];
  }

  if (path.startsWith("agents.") && path.split(".").length === 2) {
    return ["type", "model", "purpose", "prompts", "tools", "temperature", "max_tokens"];
  }

  if (path.startsWith("jobs.") && path.split(".").length === 2) {
    return ["name", "description", "triggers", "execution", "config"];
  }

  if (path.startsWith("signals.") && path.split(".").length === 2) {
    return ["description", "provider", "schedule", "path", "method", "schema"];
  }

  if (path.endsWith(".execution")) {
    return ["strategy", "agents", "timeout", "retry"];
  }

  if (path.endsWith(".prompts")) {
    return ["system", "user", "assistant"];
  }

  return [];
}

function findClosestKey(target: string, options: string[]): string | null {
  if (options.length === 0) return null;

  // Simple similarity check - look for keys that start with the same letter or contain similar substrings
  const targetLower = target.toLowerCase();

  // Exact prefix match
  for (const option of options) {
    if (option.toLowerCase().startsWith(targetLower.slice(0, 2))) {
      return option;
    }
  }

  // Contains match
  for (const option of options) {
    if (
      option.toLowerCase().includes(targetLower.slice(0, 3)) ||
      targetLower.includes(option.toLowerCase().slice(0, 3))
    ) {
      return option;
    }
  }

  return null;
}

function formatConfigForDisplay(config: unknown, format: string): string {
  switch (format) {
    case "yaml":
      return JSON.stringify(config, null, 2); // Would use YAML library in real implementation
    case "json":
      return JSON.stringify(config, null, 2);
    case "summary":
      return `Draft contains ${
        Object.keys(config as Record<string, unknown>).length
      } configuration sections`;
    default:
      return JSON.stringify(config, null, 2);
  }
}

// ============================================================================
// Route Handlers
// ============================================================================

// Create workspace draft
workspaceDraftRoutes.post(
  "/api/drafts",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "Create workspace draft",
    description: "Create a new workspace draft for iterative development",
    responses: {
      200: {
        description: "Draft created successfully",
        content: {
          "application/json": {
            schema: resolver(createDraftResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request data",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("json", createDraftSchema),
  async (c) => {
    try {
      const { name, description, initialConfig, sessionId, conversationId: _conversationId } = c.req
        .valid("json");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();

      // Create draft with default session ID if not provided
      const draft = await draftStore.createDraft({
        name,
        description,
        initialConfig: initialConfig as Partial<WorkspaceConfig>,
        sessionId: sessionId || "default",
        userId: "default-user", // TODO: Get from auth context
      });

      // Validate initial configuration if provided
      let validation;
      if (initialConfig) {
        validation = validateWorkspaceConfiguration({ ...draft.config, ...initialConfig });
      }

      return c.json({
        draft,
        validation,
        success: true,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// List workspace drafts
workspaceDraftRoutes.get(
  "/api/drafts",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "List workspace drafts",
    description: "Get a list of workspace drafts with optional filtering",
    responses: {
      200: {
        description: "Drafts retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(listDraftsResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("query", listDraftsQuerySchema),
  async (c) => {
    try {
      const { sessionId, conversationId: _conversationId, includeDetails: _includeDetails } = c.req
        .valid("query");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();

      // Get drafts for session (fallback to default if not specified)
      const drafts = await draftStore.getSessionDrafts(sessionId || "default");

      // TODO: Add conversationId filtering when implemented
      // TODO: Add includeDetails logic when implemented

      return c.json({
        drafts,
        total: drafts.length,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// Get specific draft details
workspaceDraftRoutes.get(
  "/api/drafts/:draftId",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "Show draft configuration",
    description: "Display current draft configuration with formatting options",
    responses: {
      200: {
        description: "Draft configuration retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(showDraftResponseSchema),
          },
        },
      },
      404: {
        description: "Draft not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", draftIdParamSchema),
  validator("query", showDraftQuerySchema),
  async (c) => {
    try {
      const { draftId } = c.req.valid("param");
      const { format } = c.req.valid("query");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();
      const draft = await draftStore.getDraft(draftId);

      if (!draft) {
        return c.json({ error: "Draft not found" }, 404);
      }

      const configFormat = format || "json";
      const configDisplay = formatConfigForDisplay(draft.config, configFormat);

      return c.json({
        draft,
        config: configDisplay,
        format: configFormat,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// Update workspace draft
workspaceDraftRoutes.patch(
  "/api/drafts/:draftId",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "Update workspace draft",
    description: "Apply incremental updates to a workspace draft",
    responses: {
      200: {
        description: "Draft updated successfully",
        content: {
          "application/json": {
            schema: resolver(updateDraftResponseSchema),
          },
        },
      },
      404: {
        description: "Draft not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", draftIdParamSchema),
  validator("json", updateDraftSchema),
  async (c) => {
    try {
      const { draftId } = c.req.valid("param");
      const { updates, updateDescription } = c.req.valid("json");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();

      const draft = await draftStore.updateDraft(
        draftId,
        updates as Partial<WorkspaceConfig>,
        updateDescription,
      );

      // Validate updated configuration
      const validation = validateWorkspaceConfiguration(draft.config);

      return c.json({
        draft,
        validation,
        success: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// Validate draft configuration
workspaceDraftRoutes.post(
  "/api/drafts/:draftId/validate",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "Validate draft configuration",
    description: "Validate the current draft configuration against workspace schema",
    responses: {
      200: {
        description: "Validation completed",
        content: {
          "application/json": {
            schema: resolver(validateDraftResponseSchema),
          },
        },
      },
      404: {
        description: "Draft not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", draftIdParamSchema),
  async (c) => {
    try {
      const { draftId } = c.req.valid("param");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();
      const draft = await draftStore.getDraft(draftId);

      if (!draft) {
        return c.json({ error: "Draft not found" }, 404);
      }

      const validation = DraftValidator.validateWorkspaceConfiguration(draft.config);

      return c.json(validation);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// Publish draft as workspace
workspaceDraftRoutes.post(
  "/api/drafts/:draftId/publish",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "Publish draft as workspace",
    description: "Convert draft to actual workspace configuration file",
    responses: {
      200: {
        description: "Draft published successfully",
        content: {
          "application/json": {
            schema: resolver(publishDraftResponseSchema),
          },
        },
      },
      404: {
        description: "Draft not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", draftIdParamSchema),
  validator("json", publishDraftSchema),
  async (c) => {
    try {
      const { draftId } = c.req.valid("param");
      const { path, overwrite: _overwrite } = c.req.valid("json");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();
      const draft = await draftStore.getDraft(draftId);

      if (!draft) {
        return c.json({ error: "Draft not found" }, 404);
      }

      // Validate configuration before publishing
      const validation = validateWorkspaceConfiguration(draft.config);
      if (!validation.valid) {
        return c.json({
          success: false,
          error: `Cannot publish invalid configuration: ${validation.errors.join(", ")}`,
        });
      }

      // Create workspace files using the adapter
      const workspaceAdapter = new FilesystemWorkspaceCreationAdapter();
      const creationResult = await workspaceAdapter.createWorkspace({
        name: draft.name,
        config: draft.config,
        targetPath: path,
        overwrite: _overwrite,
      });

      if (!creationResult.success) {
        return c.json({
          success: false,
          error: `Failed to create workspace: ${creationResult.error}`,
        }, 500);
      }

      // Mark draft as published only after successful file creation
      await draftStore.publishDraft(draftId);

      return c.json({
        success: true,
        workspacePath: creationResult.workspacePath,
        filesCreated: creationResult.filesCreated,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// Delete workspace draft
workspaceDraftRoutes.delete(
  "/api/drafts/:draftId",
  describeRoute({
    tags: ["Workspace Drafts"],
    summary: "Delete workspace draft",
    description: "Delete a workspace draft and its history",
    responses: {
      200: {
        description: "Draft deleted successfully",
        content: {
          "application/json": {
            schema: resolver(deleteDraftResponseSchema),
          },
        },
      },
      404: {
        description: "Draft not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", draftIdParamSchema),
  async (c) => {
    try {
      const { draftId } = c.req.valid("param");
      const _ctx = c.get("app");

      const draftStore = await getDraftStore();

      // Delete the draft using the store's delete method
      await draftStore.deleteDraft(draftId);

      return c.json({
        success: true,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { workspaceDraftRoutes };
