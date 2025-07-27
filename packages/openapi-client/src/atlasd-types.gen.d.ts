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
  "/api/workspaces/{workspaceId}/update": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Update workspace configuration
     * @description Update existing workspace configuration files with backup and reload capabilities
     */
    post: operations["POSTApiWorkspaces:workspaceIdUpdate"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/workspaces/create": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create workspace from configuration
     * @description Create workspace files and register workspace from generated configuration
     */
    post: operations["POSTApiWorkspacesCreate"];
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
  "/api/conversation": {
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
    get: operations["GETApiConversation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/conversation/{streamId}": {
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
    get: operations["GETApiConversation:streamId"];
    put?: never;
    /**
     * Store conversation message
     * @description Store a message in the conversation history for the given stream ID
     */
    post: operations["POSTApiConversation:streamId"];
    /**
     * Delete conversation
     * @description Delete all conversation history for the given stream ID
     */
    delete: operations["DELETEApiConversation:streamId"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/todos": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List all todo streams
     * @description Get a list of all stream IDs that have todo data (admin endpoint)
     */
    get: operations["GETApiTodos"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/todos/{streamId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Retrieve todo list
     * @description Get the todo list for the given stream ID with optional filtering
     */
    get: operations["GETApiTodos:streamId"];
    put?: never;
    /**
     * Store todo list
     * @description Store or update the complete todo list for the given stream ID
     */
    post: operations["POSTApiTodos:streamId"];
    /**
     * Delete todo list
     * @description Delete all todos for the given stream ID
     */
    delete: operations["DELETEApiTodos:streamId"];
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
  "POSTApiWorkspaces:workspaceIdUpdate": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Updated workspace configuration */
          config: {
            [key: string]: unknown;
          };
          /**
           * @description Create backup before updating
           * @default true
           */
          backup: boolean;
        };
      };
    };
    responses: {
      /** @description Workspace updated successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            /** @description Workspace information */
            workspace?: {
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
            };
            backupPath?: string;
            filesModified?: string[];
            reloadRequired?: boolean;
            error?: string;
          };
        };
      };
      /** @description Invalid configuration or workspace not found */
      400: {
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
      /** @description Update failed */
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
  POSTApiWorkspacesCreate: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Generated workspace configuration */
          config: {
            [key: string]: unknown;
          };
          /** @description Custom workspace directory name (auto-resolves conflicts with -2, -3, etc.) */
          workspaceName?: string;
        };
      };
    };
    responses: {
      /** @description Workspace created successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            /** @description Workspace information */
            workspace?: {
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
            };
            workspacePath?: string;
            filesCreated?: string[];
            error?: string;
          };
        };
      };
      /** @description Invalid configuration */
      400: {
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
      /** @description Creation failed */
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
  GETApiConversation: {
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
  "GETApiConversation:streamId": {
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
  "POSTApiConversation:streamId": {
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
  "DELETEApiConversation:streamId": {
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
  GETApiTodos: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Stream list retrieved successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            streams: string[];
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
  "GETApiTodos:streamId": {
    parameters: {
      query?: {
        status?: "pending" | "in_progress" | "completed" | "cancelled";
        priority?: "high" | "medium" | "low";
        limit?: number;
      };
      header?: never;
      path: {
        streamId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Todo list retrieved successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            todos: {
              /** @description Unique identifier for the todo item */
              id: string;
              /** @description Brief description of the task */
              content: string;
              /**
               * @description Current status of the task
               * @enum {string}
               */
              status: "pending" | "in_progress" | "completed" | "cancelled";
              /**
               * @description Priority level of the task
               * @enum {string}
               */
              priority: "high" | "medium" | "low";
              /** @description Additional context (workspace names, IDs, etc.) */
              metadata?: {
                [key: string]: unknown;
              };
              /** @description ISO timestamp of creation */
              createdAt: string;
              /** @description ISO timestamp of last update */
              updatedAt: string;
            }[];
            todoCount: number;
          };
        };
      };
      /** @description Stream not found */
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
  "POSTApiTodos:streamId": {
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
          /** @description Complete todo list to store */
          todos: {
            /** @description Unique identifier for the todo item */
            id: string;
            /** @description Brief description of the task */
            content: string;
            /**
             * @description Current status of the task
             * @enum {string}
             */
            status: "pending" | "in_progress" | "completed" | "cancelled";
            /**
             * @description Priority level of the task
             * @enum {string}
             */
            priority: "high" | "medium" | "low";
            /** @description Additional context (workspace names, IDs, etc.) */
            metadata?: {
              [key: string]: unknown;
            };
            /** @description ISO timestamp of creation */
            createdAt: string;
            /** @description ISO timestamp of last update */
            updatedAt: string;
          }[];
        };
      };
    };
    responses: {
      /** @description Todos stored successfully */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            success: boolean;
            message?: string;
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
  "DELETEApiTodos:streamId": {
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
      /** @description Todos deleted successfully */
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
      /** @description Stream not found */
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
