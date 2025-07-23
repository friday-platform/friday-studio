export interface paths {
  "/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Health check
     * @description Returns the current health status of the Atlas daemon including runtime metrics
     */
    get: operations["GETHealth"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/workspaces": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List all workspaces
     * @description Returns a list of all registered workspaces with their current status and runtime information
     */
    get: operations["GETApiWorkspaces"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/workspaces/{workspaceId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get workspace details
     * @description Returns detailed information about a specific workspace including its configuration and runtime status
     */
    get: operations["GETApiWorkspaces:workspaceId"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/workspaces/{workspaceId}/signals/{signalId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Trigger workspace signal
     * @description Triggers a signal within a specific workspace. Signals are defined in the workspace's
     *     configuration and can have different payload requirements. The streamId parameter
     *     enables real-time progress feedback in the UI.
     *
     *     **Dynamic Behavior:**
     *     - Workspace is resolved by ID or name at runtime
     *     - Signal availability depends on workspace configuration
     *     - Payload schema varies by signal type
     *     - Session progress streamed via streamId (optional)
     */
    post: operations["POSTApiWorkspaces:workspaceIdSignals:signalId"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/conversation-storage/{streamId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Retrieve conversation history
     * @description Get the complete conversation history for the given stream ID
     */
    get: operations["GETApiConversation-storage:streamId"];
    put?: never;
    /**
     * Store conversation message
     * @description Store a message in the conversation history for the given stream ID
     */
    post: operations["POSTApiConversation-storage:streamId"];
    /**
     * Delete conversation
     * @description Delete all conversation history for the given stream ID
     */
    delete: operations["DELETEApiConversation-storage:streamId"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/conversation-storage": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List conversations
     * @description Get a list of all conversations with summary information
     */
    get: operations["GETApiConversation-storage"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/drafts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List workspace drafts
     * @description Get a list of workspace drafts with optional filtering
     */
    get: operations["GETApiDrafts"];
    put?: never;
    /**
     * Create workspace draft
     * @description Create a new workspace draft for iterative development
     */
    post: operations["POSTApiDrafts"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/drafts/{draftId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Show draft configuration
     * @description Display current draft configuration with formatting options
     */
    get: operations["GETApiDrafts:draftId"];
    put?: never;
    post?: never;
    /**
     * Delete workspace draft
     * @description Delete a workspace draft and its history
     */
    delete: operations["DELETEApiDrafts:draftId"];
    options?: never;
    head?: never;
    /**
     * Update workspace draft
     * @description Apply incremental updates to a workspace draft
     */
    patch: operations["PATCHApiDrafts:draftId"];
    trace?: never;
  };
  "/api/drafts/{draftId}/validate": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Validate draft configuration
     * @description Validate the current draft configuration against workspace schema
     */
    post: operations["POSTApiDrafts:draftIdValidate"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/drafts/{draftId}/publish": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Publish draft as workspace
     * @description Convert draft to actual workspace configuration file
     */
    post: operations["POSTApiDrafts:draftIdPublish"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: never;
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  GETHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Daemon is healthy and operational */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Number of currently active workspaces */
            activeWorkspaces: number;
            /** @description Daemon uptime in milliseconds */
            uptime: number;
            /**
             * Format: date-time
             * @description Current server timestamp in ISO 8601 format
             */
            timestamp: string;
            /** @description Version information for runtime components */
            version: {
              /** @description Deno runtime version */
              deno: string;
              /** @description V8 engine version */
              v8: string;
              /** @description TypeScript version */
              typescript: string;
            };
          };
        };
      };
    };
  };
  GETApiWorkspaces: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved workspaces */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Unique workspace identifier (Docker-style name) */
            id: string;
            /** @description Human-readable workspace name */
            name: string;
            /** @description Workspace description */
            description?: string;
            /**
             * @description Current status of the workspace
             * @enum {string}
             */
            status: "stopped" | "starting" | "running" | "stopping" | "crashed" | "unknown";
            /** @description Filesystem path to the workspace */
            path: string;
            /** @description ISO 8601 timestamp when workspace was created */
            createdAt: string;
            /** @description ISO 8601 timestamp when workspace was last seen */
            lastSeen: string;
          }[];
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
            /** @description Error code */
            code?: string;
            /** @description Additional error details */
            details?: unknown;
          };
        };
      };
    };
  };
  "GETApiWorkspaces:workspaceId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved workspace details */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Unique workspace identifier (Docker-style name) */
            id: string;
            /** @description Human-readable workspace name */
            name: string;
            /** @description Workspace description */
            description?: string;
            /**
             * @description Current status of the workspace
             * @enum {string}
             */
            status: "stopped" | "starting" | "running" | "stopping" | "crashed" | "unknown";
            /** @description Filesystem path to the workspace */
            path: string;
            /** @description ISO 8601 timestamp when workspace was created */
            createdAt: string;
            /** @description ISO 8601 timestamp when workspace was last seen */
            lastSeen: string;
            /** @description Full workspace configuration */
            config: unknown;
            /** @description Runtime information if the workspace is active */
            runtime?: {
              /** @description Runtime status */
              status: string;
              /** @description ISO 8601 timestamp when runtime started */
              startedAt: string;
              /** @description Number of active sessions */
              sessions: number;
              /** @description Number of active workers */
              workers: number;
            };
          };
        };
      };
      /** @description Workspace not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
            /** @description Error code */
            code?: string;
            /** @description Additional error details */
            details?: unknown;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
            /** @description Error code */
            code?: string;
            /** @description Additional error details */
            details?: unknown;
          };
        };
      };
    };
  };
  "POSTApiWorkspaces:workspaceIdSignals:signalId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
        signalId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Optional payload data for the signal */
          payload?: {
            [key: string]: unknown;
          };
          /** @description Optional stream ID for UI progress feedback */
          streamId?: string;
        };
      };
    };
    responses: {
      /** @description Signal accepted for processing */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Status message */
            message: string;
            /**
             * @description Processing status
             * @constant
             */
            status: "processing";
            /** @description Workspace identifier */
            workspaceId: string;
            /** @description Signal identifier */
            signalId: string;
            /** @description Created session ID */
            sessionId: string;
          };
        };
      };
      /** @description Invalid request body or signal configuration */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
          };
        };
      };
      /** @description Workspace or signal not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
          };
        };
      };
    };
  };
  "GETApiConversation-storage:streamId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        streamId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Conversation history retrieved successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            messages: {
              messageId: string;
              userId?: string;
              content: string;
              timestamp: string;
              /** @enum {string} */
              role: "user" | "assistant";
              metadata?: {
                [key: string]: unknown;
              };
            }[];
            messageCount: number;
          };
        };
      };
      /** @description Conversation not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "POSTApiConversation-storage:streamId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        streamId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          message: {
            /** @enum {string} */
            role: "user" | "assistant";
            content: string;
          };
          metadata?: {
            [key: string]: unknown;
          };
          timestamp: string;
        };
      };
    };
    responses: {
      /** @description Message stored successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            messageId?: string;
            error?: string;
          };
        };
      };
      /** @description Invalid request data */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "DELETEApiConversation-storage:streamId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        streamId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Conversation deleted successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            deleted?: boolean;
            error?: string;
          };
        };
      };
      /** @description Conversation not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "GETApiConversation-storage": {
    parameters: {
      query?: {
        limit?: number;
        offset?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Conversation list retrieved successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            conversations: {
              streamId: string;
              messageCount: number;
              lastMessage: string;
              lastTimestamp: string;
            }[];
            total: number;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  GETApiDrafts: {
    parameters: {
      query?: {
        sessionId?: string;
        conversationId?: string;
        includeDetails?: boolean;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Drafts retrieved successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            drafts: {
              id: string;
              name: string;
              description: string;
              config: {
                [key: string]: unknown;
              };
              iterations: {
                timestamp: string;
                operation: string;
                config: {
                  [key: string]: unknown;
                };
                summary: string;
              }[];
              createdAt: string;
              updatedAt: string;
              /** @enum {string} */
              status: "draft" | "published" | "abandoned";
              sessionId: string;
              userId: string;
            }[];
            total: number;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  POSTApiDrafts: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Name of the draft */
          name: string;
          /** @description Description of the draft */
          description: string;
          /** @description Initial workspace configuration */
          initialConfig?: {
            [key: string]: unknown;
          };
          /** @description Associated session ID */
          sessionId?: string;
          /** @description Associated conversation ID */
          conversationId?: string;
        };
      };
    };
    responses: {
      /** @description Draft created successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Workspace draft */
            draft: {
              id: string;
              name: string;
              description: string;
              config: {
                [key: string]: unknown;
              };
              iterations: {
                timestamp: string;
                operation: string;
                config: {
                  [key: string]: unknown;
                };
                summary: string;
              }[];
              createdAt: string;
              updatedAt: string;
              /** @enum {string} */
              status: "draft" | "published" | "abandoned";
              sessionId: string;
              userId: string;
            };
            /** @description Configuration validation result */
            validation?: {
              valid: boolean;
              errors: string[];
              warnings: string[];
            };
            success: boolean;
          };
        };
      };
      /** @description Invalid request data */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "GETApiDrafts:draftId": {
    parameters: {
      query?: {
        format?: "yaml" | "json" | "summary";
      };
      header?: never;
      path: {
        draftId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Draft configuration retrieved successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Workspace draft */
            draft: {
              id: string;
              name: string;
              description: string;
              config: {
                [key: string]: unknown;
              };
              iterations: {
                timestamp: string;
                operation: string;
                config: {
                  [key: string]: unknown;
                };
                summary: string;
              }[];
              createdAt: string;
              updatedAt: string;
              /** @enum {string} */
              status: "draft" | "published" | "abandoned";
              sessionId: string;
              userId: string;
            };
            config: string;
            format: string;
          };
        };
      };
      /** @description Draft not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "DELETEApiDrafts:draftId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        draftId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Draft deleted successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
          };
        };
      };
      /** @description Draft not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "PATCHApiDrafts:draftId": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        draftId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Configuration updates to apply */
          updates: {
            [key: string]: unknown;
          };
          /** @description Description of the updates being applied */
          updateDescription: string;
        };
      };
    };
    responses: {
      /** @description Draft updated successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @description Workspace draft */
            draft: {
              id: string;
              name: string;
              description: string;
              config: {
                [key: string]: unknown;
              };
              iterations: {
                timestamp: string;
                operation: string;
                config: {
                  [key: string]: unknown;
                };
                summary: string;
              }[];
              createdAt: string;
              updatedAt: string;
              /** @enum {string} */
              status: "draft" | "published" | "abandoned";
              sessionId: string;
              userId: string;
            };
            /** @description Configuration validation result */
            validation?: {
              valid: boolean;
              errors: string[];
              warnings: string[];
            };
            success: boolean;
          };
        };
      };
      /** @description Draft not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "POSTApiDrafts:draftIdValidate": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        draftId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Validation completed */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            valid: boolean;
            errors: string[];
            warnings: string[];
          };
        };
      };
      /** @description Draft not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
  "POSTApiDrafts:draftIdPublish": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        draftId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Optional custom path for the workspace */
          path?: string;
          /** @description Whether to overwrite existing workspace */
          overwrite?: boolean;
        };
      };
    };
    responses: {
      /** @description Draft published successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            workspacePath?: string;
            filesCreated?: string[];
            error?: string;
          };
        };
      };
      /** @description Draft not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            error: string;
          };
        };
      };
    };
  };
}
