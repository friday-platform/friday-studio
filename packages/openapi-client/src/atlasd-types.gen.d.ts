export interface paths {
  "/health": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
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
  "/api/workspaces/{workspaceId}/config": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Get workspace configuration
     * @description Returns the complete workspace configuration for agent server consumption, including MCP server configurations and agent definitions
     */
    get: operations["GETApiWorkspaces:workspaceIdConfig"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/workspaces/{workspaceId}/update": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
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
  "/api/chat-storage": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * List past conversations
     * @description List the complete conversation history for the given stream ID
     */
    get: operations["GETApiChat-storage"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/chat-storage/{streamId}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Retrieve conversation history
     * @description Get the complete conversation history for the given stream ID
     */
    get: operations["GETApiChat-storage:streamId"];
    /**
     * Replace conversation messages
     * @description Replace entire conversation history for the given stream ID
     */
    put: operations["PUTApiChat-storage:streamId"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/user": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Retrieve current user
     * @description Get the current user for the session
     */
    get: operations["GETApiUser"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/todos/{streamId}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Retrieve todo list
     * @description Get the todo list for the given stream ID
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
  "/api/sessions/{sessionId}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Cancel session
     * @description Cancel a running session across any workspace
     */
    delete: operations["DELETEApiSessions:sessionId"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/agents": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * List all available agents
     * @description Returns a list of all agents available in the system, including their metadata and expertise information
     */
    get: operations["GETApiAgents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/agents/{id}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Get agent details
     * @description Returns detailed information about a specific agent
     */
    get: operations["GETApiAgents:id"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/agents/{id}/expertise": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Get agent expertise
     * @description Returns expertise information for a specific agent including domains, capabilities, and example prompts
     */
    get: operations["GETApiAgents:idExpertise"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sse": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get?: never;
    put?: never;
    /**
     * Create a new stream session
     * @description Creates a new stream session with optional signal triggering
     */
    post: operations["POSTApiSse"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sse/{streamId}/stream": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Subscribe to stream events (AI SDK Protocol)
     * @description Opens SSE stream using Vercel AI SDK protocol for real-time agent responses
     */
    get: operations["GETApiSse:streamIdStream"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sse/{streamId}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get?: never;
    put?: never;
    /**
     * Send a message through the stream
     * @description Send user message to trigger conversation agent processing
     */
    post: operations["POSTApiSse:streamId"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sse/{streamId}/emit": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get?: never;
    put?: never;
    /**
     * Emit UIMessageChunk event to stream
     * @description Forward AI SDK events from agents to SSE clients
     */
    post: operations["POSTApiSse:streamIdEmit"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Search and list library items
     * @description Search library items with optional filters for type, tags, date range, and text query. Returns paginated results.
     */
    get: operations["GETApiLibrary"];
    put?: never;
    /**
     * Create library item
     * @description Create a new library item with content and metadata.
     */
    post: operations["POSTApiLibrary"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library/search": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Search and list library items
     * @description Search library items with optional filters for type, tags, date range, and text query. Returns paginated results.
     */
    get: operations["GETApiLibrarySearch"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library/templates": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * List available templates
     * @description Get all available templates for content generation.
     */
    get: operations["GETApiLibraryTemplates"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library/stats": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Get library statistics
     * @description Get usage statistics for the library including item counts, sizes, and recent activity.
     */
    get: operations["GETApiLibraryStats"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library/generate": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get?: never;
    put?: never;
    /**
     * Generate content from template
     * @description Generate content using a template with provided data and options.
     */
    post: operations["POSTApiLibraryGenerate"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library/{itemId}/download": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Download library item file
     * @description Download the actual file content of a library item with proper headers.
     */
    get: operations["GETApiLibrary:itemIdDownload"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/library/{itemId}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Get library item by ID
     * @description Retrieve a specific library item by its ID. Optionally include content by setting content=true query parameter.
     */
    get: operations["GETApiLibrary:itemId"];
    put?: never;
    post?: never;
    /**
     * Delete library item
     * @description Permanently delete a library item and its content by ID.
     */
    delete: operations["DELETEApiLibrary:itemId"];
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Daemon is healthy and operational */
      200: {
        headers: { [name: string]: unknown };
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved workspaces */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            /** @description Unique workspace identifier (Docker-style name) */
            id: string;
            /** @description Human-readable workspace name */
            name: string;
            /** @description Workspace description */
            description?: string;
            /** @enum {string} */
            status: "inactive" | "running" | "stopped";
            /** @description Filesystem path to the workspace */
            path: string;
            /** @description ISO 8601 timestamp when workspace was created */
            createdAt: string;
            /** @description ISO 8601 timestamp when workspace was last seen */
            lastSeen: string;
            metadata?: {
              description?: string;
              tags?: string[];
              system?: boolean;
              atlasVersion?: string;
              lastError?: string;
              /** Format: date-time */
              lastErrorAt?: string;
              failureCount?: number;
              lastFinishedSession?: {
                id: string;
                /** @enum {string} */
                status: "completed" | "failed";
                /** Format: date-time */
                finishedAt: string;
                summary?: string;
              };
            };
          }[];
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
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
        /** @description Workspace identifier */
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved workspace details */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            /** @description Unique workspace identifier (Docker-style name) */
            id: string;
            /** @description Human-readable workspace name */
            name: string;
            /** @description Workspace description */
            description?: string;
            /** @enum {string} */
            status: "inactive" | "running" | "stopped";
            /** @description Filesystem path to the workspace */
            path: string;
            /** @description ISO 8601 timestamp when workspace was created */
            createdAt: string;
            /** @description ISO 8601 timestamp when workspace was last seen */
            lastSeen: string;
            metadata?: {
              description?: string;
              tags?: string[];
              system?: boolean;
              atlasVersion?: string;
              lastError?: string;
              /** Format: date-time */
              lastErrorAt?: string;
              failureCount?: number;
              lastFinishedSession?: {
                id: string;
                /** @enum {string} */
                status: "completed" | "failed";
                /** Format: date-time */
                finishedAt: string;
                summary?: string;
              };
            };
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
        headers: { [name: string]: unknown };
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
        headers: { [name: string]: unknown };
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
  "GETApiWorkspaces:workspaceIdConfig": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description Workspace identifier */
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved workspace configuration */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            config: {
              /**
               * @description Configuration version (currently '1.0')
               * @constant
               */
              version: "1.0";
              workspace: {
                /** @description Workspace ID (required for platform workspace) */
                id?: string;
                name: string;
                /** @description Workspace version */
                version?: string;
                /** @description Workspace description */
                description?: string;
                /** @description Timeout configuration for workspace operations */
                timeout?: {
                  /**
                   * @description Time allowed between progress signals before cancelling for inactivity
                   * @default 2m
                   */
                  progressTimeout: string;
                  /**
                   * @description Hard upper limit for any operation
                   * @default 30m
                   */
                  maxTotalTimeout: string;
                };
              };
              server?: {
                /** @description Atlas exposing itself as MCP server */
                mcp?: {
                  /** @default false */
                  enabled: boolean;
                  discoverable?: {
                    /** @description Capability patterns to expose (e.g., 'workspace_*') */
                    capabilities?: string[];
                    /** @description Job patterns to expose as MCP tools */
                    jobs?: string[];
                  };
                };
              };
              tools?: {
                /** @description MCP servers that agents can call */
                mcp?: {
                  /** @default {
                   *       "timeout": {
                   *         "progressTimeout": "2m",
                   *         "maxTotalTimeout": "30m"
                   *       }
                   *     } */
                  client_config: {
                    /**
                     * @description Watchdog timeout configuration
                     * @default {
                     *       "progressTimeout": "2m",
                     *       "maxTotalTimeout": "30m"
                     *     }
                     */
                    timeout: {
                      /**
                       * @description Time allowed between progress signals before cancelling for inactivity
                       * @default 2m
                       */
                      progressTimeout: string;
                      /**
                       * @description Hard upper limit for any operation
                       * @default 30m
                       */
                      maxTotalTimeout: string;
                    };
                  };
                  servers?: {
                    [key: string]: {
                      transport:
                        | {
                            /** @constant */
                            type: "stdio";
                            command: string;
                            args?: string[];
                          }
                        | {
                            /** @constant */
                            type: "http";
                            /** Format: uri */
                            url: string;
                          }
                        | {
                            /** @constant */
                            type: "sse";
                            /** Format: uri */
                            url: string;
                          };
                      client_config?: {
                        timeout?: {
                          /**
                           * @description Time allowed between progress signals before cancelling for inactivity
                           * @default 2m
                           */
                          progressTimeout: string;
                          /**
                           * @description Hard upper limit for any operation
                           * @default 30m
                           */
                          maxTotalTimeout: string;
                        };
                      };
                      auth?: {
                        /** @enum {string} */
                        type: "bearer" | "api_key" | "basic";
                        /** @description Header name for the token */
                        header?: string;
                        /** @description Environment variable containing the token */
                        token_env?: string;
                        /** @description For basic auth */
                        username_env?: string;
                        /** @description For basic auth */
                        password_env?: string;
                      };
                      /** @description Filter which tools to allow or deny from this MCP server */
                      tools?: { allow?: string[]; deny?: string[] };
                      /** @description Environment variables for the server process */
                      env?: { [key: string]: string };
                    };
                  };
                };
              };
              signals?: {
                [key: string]:
                  | {
                      description: string;
                      /** @description JSON Schema for signal payload validation */
                      schema?: { [key: string]: unknown };
                      /** @constant */
                      provider: "http";
                      config: {
                        /** @description HTTP path for the webhook (method is always POST) */
                        path: string;
                        /** @description Timeout for signal processing */
                        timeout?: string;
                      };
                    }
                  | {
                      description: string;
                      /** @description JSON Schema for signal payload validation */
                      schema?: { [key: string]: unknown };
                      /** @constant */
                      provider: "schedule";
                      config: {
                        /** @description Cron expression (e.g., '0 9 * * *' for daily at 9 AM) */
                        schedule: string;
                        /**
                         * @description Timezone for the schedule
                         * @default UTC
                         */
                        timezone: string;
                      };
                    }
                  | {
                      description: string;
                      /** @description JSON Schema for signal payload validation */
                      schema?: { [key: string]: unknown };
                      /** @constant */
                      provider: "system";
                    }
                  | {
                      description: string;
                      /** @description JSON Schema for signal payload validation */
                      schema?: { [key: string]: unknown };
                      /** @constant */
                      provider: "fs-watch";
                      config: {
                        /** @description Absolute or workspace-relative path to watch */
                        path: string;
                        /**
                         * @description Watch subdirectories when path is a directory
                         * @default true
                         */
                        recursive: boolean;
                      };
                    };
              };
              jobs?: {
                [key: string]: {
                  /** @description MCP-compliant job name */
                  name?: string;
                  description?: string;
                  triggers?: {
                    /** @description Signal name that triggers this job */
                    signal: string;
                    /** @description Condition for triggering */
                    condition?:
                      | {
                          /** @description JSONLogic expression (cached and executed at runtime) */
                          jsonlogic: unknown;
                        }
                      | {
                          /** @description Natural language prompt (converted to JSONLogic and cached) */
                          prompt: string;
                        };
                  }[];
                  context?: {
                    /** @description Job-level file context */
                    files?: {
                      /** @description Glob patterns for files (supports exclusions with !) */
                      patterns: string[];
                      base_path?: string;
                      max_file_size?: number;
                      /** @default true */
                      include_content: boolean;
                    };
                  };
                  /** @description Single prompt string for supervisor */
                  prompt?: string;
                  execution: {
                    /**
                     * @default sequential
                     * @enum {string}
                     */
                    strategy: "sequential" | "parallel";
                    /** @description Agent pipeline */
                    agents: (
                      | string
                      | {
                          /** @description Agent ID */
                          id: string;
                          /** @description Optional nickname for reference */
                          nickname?: string;
                          context?: {
                            /** @description Include signal data */
                            signal?: boolean;
                            /**
                             * @description Include step outputs
                             * @enum {string}
                             */
                            steps?: "previous" | "all";
                            /** @description Specific agent outputs to include */
                            agents?: string[];
                            /** @description Include filesystem context */
                            files?: boolean;
                            /** @description Additional task description appended to prompt */
                            task?: string;
                          };
                          /** @description Explicit agent dependencies */
                          dependencies?: string[];
                          /** @description Tool access override for this agent */
                          tools?: { allow?: string[]; deny?: string[] };
                        }
                    )[];
                    /** @description Execution-level context */
                    context?: {
                      files?: {
                        /** @description Glob patterns for files (supports exclusions with !) */
                        patterns: string[];
                        base_path?: string;
                        max_file_size?: number;
                        /** @default true */
                        include_content: boolean;
                      };
                    };
                  };
                  success?: {
                    /** @description Condition that can be either JSONLogic or a natural language prompt */
                    condition:
                      | {
                          /** @description JSONLogic expression (cached and executed at runtime) */
                          jsonlogic: unknown;
                        }
                      | {
                          /** @description Natural language prompt (converted to JSONLogic and cached) */
                          prompt: string;
                        };
                    /** @description Structured output schema */
                    schema?: { [key: string]: unknown };
                  };
                  error?: {
                    /** @description Condition that can be either JSONLogic or a natural language prompt */
                    condition:
                      | {
                          /** @description JSONLogic expression (cached and executed at runtime) */
                          jsonlogic: unknown;
                        }
                      | {
                          /** @description Natural language prompt (converted to JSONLogic and cached) */
                          prompt: string;
                        };
                  };
                  config?: {
                    timeout?: string;
                    supervision?: {
                      /** @enum {string} */
                      level?: "minimal" | "standard" | "detailed";
                      /** @description Skip planning phase for simple jobs */
                      skip_planning?: boolean;
                    };
                    memory?: {
                      /** @default true */
                      enabled: boolean;
                      /** @default true */
                      fact_extraction: boolean;
                      /**
                       * @description Include summary in session receipt
                       * @default true
                       */
                      summary: boolean;
                    };
                  };
                };
              };
              agents?: {
                [key: string]:
                  | {
                      /** @description Agent purpose/description */
                      description: string;
                      /** @constant */
                      type: "llm";
                      config: {
                        /** @enum {string} */
                        provider: "anthropic" | "openai" | "google";
                        /** @description Model identifier (e.g., 'claude-3-7-sonnet-latest') */
                        model: string;
                        /** @description System prompt for the agent */
                        prompt: string;
                        /**
                         * @description Temperature (0-0.7 range)
                         * @default 0.3
                         */
                        temperature: number;
                        max_tokens?: number;
                        /** @description Max steps for multi-step tool calling */
                        max_steps?: number;
                        tool_choice?: "auto" | "required" | "none";
                        /** @description Available tools (simple array) */
                        tools?: string[];
                        /** @description Provider-specific options passed directly to the LLM SDK */
                        provider_options?: { [key: string]: unknown };
                        success?: {
                          /** @description Condition that can be either JSONLogic or a natural language prompt */
                          condition:
                            | {
                                /** @description JSONLogic expression (cached and executed at runtime) */
                                jsonlogic: unknown;
                              }
                            | {
                                /** @description Natural language prompt (converted to JSONLogic and cached) */
                                prompt: string;
                              };
                          /** @description Structured output schema */
                          schema?: { [key: string]: unknown };
                        };
                        error?: {
                          /** @description Condition that can be either JSONLogic or a natural language prompt */
                          condition:
                            | {
                                /** @description JSONLogic expression (cached and executed at runtime) */
                                jsonlogic: unknown;
                              }
                            | {
                                /** @description Natural language prompt (converted to JSONLogic and cached) */
                                prompt: string;
                              };
                        };
                        max_retries?: number;
                        timeout?: string;
                      };
                    }
                  | {
                      /** @description Agent purpose/description */
                      description: string;
                      /** @constant */
                      type: "system";
                      /** @description System agent identifier */
                      agent: string;
                      /** @description System agent configuration */
                      config?: {
                        /** @description LLM model to use */
                        model?: string;
                        /**
                         * @description LLM temperature
                         * @default 0.3
                         */
                        temperature: number;
                        /** @description Maximum tokens for LLM response */
                        max_tokens?: number;
                        /** @description Array of tool names available to the agent */
                        tools?: string[];
                        /** @description Enable reasoning capabilities */
                        use_reasoning?: boolean;
                        /** @description Maximum reasoning steps */
                        max_reasoning_steps?: number;
                        /** @description System prompt for the agent */
                        prompt?: string;
                      };
                    }
                  | {
                      /** @description Agent purpose/description */
                      description: string;
                      /** @constant */
                      type: "remote";
                      config: {
                        /** @constant */
                        protocol: "acp";
                        /** Format: uri */
                        endpoint: string;
                        agent_name: string;
                        /**
                         * @default async
                         * @enum {string}
                         */
                        default_mode: "sync" | "async" | "stream";
                        /** @default 30s */
                        health_check_interval: string;
                        auth?: {
                          /** @enum {string} */
                          type: "bearer" | "api_key" | "basic";
                          /** @description Header name for the token */
                          header?: string;
                          /** @description Environment variable containing the token */
                          token_env?: string;
                          /** @description For basic auth */
                          username_env?: string;
                          /** @description For basic auth */
                          password_env?: string;
                        };
                        timeout?: string;
                        /** @default 2 */
                        max_retries: number;
                        /** @description System prompt for the agent */
                        prompt?: string;
                        schema?: {
                          /** @default false */
                          validate_input: boolean;
                          /** @default false */
                          validate_output: boolean;
                          input?: { [key: string]: unknown };
                          output?: { [key: string]: unknown };
                        };
                        success?: {
                          /** @description Condition that can be either JSONLogic or a natural language prompt */
                          condition:
                            | {
                                /** @description JSONLogic expression (cached and executed at runtime) */
                                jsonlogic: unknown;
                              }
                            | {
                                /** @description Natural language prompt (converted to JSONLogic and cached) */
                                prompt: string;
                              };
                          /** @description Structured output schema */
                          schema?: { [key: string]: unknown };
                        };
                        error?: {
                          /** @description Condition that can be either JSONLogic or a natural language prompt */
                          condition:
                            | {
                                /** @description JSONLogic expression (cached and executed at runtime) */
                                jsonlogic: unknown;
                              }
                            | {
                                /** @description Natural language prompt (converted to JSONLogic and cached) */
                                prompt: string;
                              };
                        };
                      };
                    }
                  | {
                      /** @constant */
                      type: "atlas";
                      /** @description Atlas Agent ID from registry */
                      agent: string;
                      /** @description Agent description */
                      description: string;
                      /** @description Agent prompt */
                      prompt: string;
                      /** @description Environment variables for the agent (supports ${VAR} interpolation) */
                      env?: { [key: string]: string };
                    };
              };
              memory?: {
                /** @default true */
                enabled: boolean;
                /**
                 * @description Memory scope level
                 * @enum {string}
                 */
                scope?: "workspace" | "session" | "agent";
                retention?: {
                  max_age_days: number;
                  max_entries: number;
                  cleanup_interval_hours?: number;
                };
                session?: { include_in_context?: boolean; max_context_entries?: number };
                /** @description Types of memory to track */
                include_types?: string[];
                /** @description Session bridge memory for cross-session continuity */
                sessionBridge?: {
                  enabled: boolean;
                  /** @default 10 */
                  maxTurns: number;
                  /** @default 48 */
                  retentionHours: number;
                  /** @default 0.1 */
                  tokenAllocation: number;
                  /** @default 0.6 */
                  relevanceThreshold: number;
                };
                /** @description Automated worklog for institutional memory */
                worklog?: {
                  enabled: boolean;
                  /** @default true */
                  autoDetect: boolean;
                  /** @default 0.7 */
                  confidenceThreshold: number;
                  /** @default 20 */
                  maxEntriesPerSession: number;
                  /** @default 90 */
                  retentionDays: number;
                };
              };
              notifications?: {
                /** @description Notification providers by name */
                providers?: {
                  [key: string]:
                    | {
                        /**
                         * @description Whether this provider is enabled
                         * @default true
                         */
                        enabled: boolean;
                        /** @description Human-readable description of this provider */
                        description?: string;
                        /** @constant */
                        provider: "sendgrid";
                        config: {
                          /** @description Environment variable containing SendGrid API key */
                          api_key_env: string;
                          /**
                           * Format: email
                           * @description Default from email address
                           */
                          from_email: string;
                          /** @description Default from name */
                          from_name?: string;
                          /** @description Default template ID */
                          template_id?: string;
                          /**
                           * @description Request timeout
                           * @default 30s
                           */
                          timeout: string;
                          /**
                           * @description Enable sandbox mode for testing
                           * @default false
                           */
                          sandbox_mode: boolean;
                        };
                      }
                    | {
                        /**
                         * @description Whether this provider is enabled
                         * @default true
                         */
                        enabled: boolean;
                        /** @description Human-readable description of this provider */
                        description?: string;
                        /** @constant */
                        provider: "slack";
                        config: {
                          /** @description Environment variable containing Slack webhook URL */
                          webhook_url_env: string;
                          /** @description Default channel (e.g., '#general') */
                          channel?: string;
                          /** @description Bot username */
                          username?: string;
                          /** @description Bot icon emoji */
                          icon_emoji?: string;
                          /**
                           * @description Request timeout
                           * @default 30s
                           */
                          timeout: string;
                        };
                      }
                    | {
                        /**
                         * @description Whether this provider is enabled
                         * @default true
                         */
                        enabled: boolean;
                        /** @description Human-readable description of this provider */
                        description?: string;
                        /** @constant */
                        provider: "teams";
                        config: {
                          /** @description Environment variable containing Teams webhook URL */
                          webhook_url_env: string;
                          /**
                           * @description Request timeout
                           * @default 30s
                           */
                          timeout: string;
                        };
                      }
                    | {
                        /**
                         * @description Whether this provider is enabled
                         * @default true
                         */
                        enabled: boolean;
                        /** @description Human-readable description of this provider */
                        description?: string;
                        /** @constant */
                        provider: "discord";
                        config: {
                          /** @description Environment variable containing Discord webhook URL */
                          webhook_url_env: string;
                          /** @description Bot username */
                          username?: string;
                          /**
                           * Format: uri
                           * @description Bot avatar URL
                           */
                          avatar_url?: string;
                          /**
                           * @description Request timeout
                           * @default 30s
                           */
                          timeout: string;
                        };
                      };
                };
                /** @description Default notification settings */
                defaults?: {
                  /**
                   * @description Whether notifications are enabled by default
                   * @default true
                   */
                  enabled: boolean;
                  /** @description Default provider name to use */
                  provider?: string;
                  /**
                   * @description Default number of retry attempts
                   * @default 3
                   */
                  retry_attempts: number;
                  /**
                   * @description Default delay between retry attempts
                   * @default 5s
                   */
                  retry_delay: string;
                  /**
                   * @description Retry backoff multiplier
                   * @default 2
                   */
                  retry_backoff: number;
                  /**
                   * @description Default request timeout
                   * @default 30s
                   */
                  timeout: string;
                };
              };
              federation?: {
                sharing?: {
                  [key: string]: {
                    workspaces?: string | string[];
                    /** @description Single scope or array of scopes */
                    scopes?: string | string[];
                    grants?: {
                      workspace: string;
                      /** @description Single scope or array of scopes */
                      scopes: string | string[];
                    }[];
                  };
                };
                scope_sets?: { [key: string]: string[] };
              };
            };
          };
        };
      };
      /** @description Workspace not found */
      404: {
        headers: { [name: string]: unknown };
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
        headers: { [name: string]: unknown };
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
        /** @description Workspace identifier */
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Updated workspace configuration */
          config: { [key: string]: unknown };
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
        headers: { [name: string]: unknown };
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
              /** @enum {string} */
              status: "inactive" | "running" | "stopped";
              /** @description Filesystem path to the workspace */
              path: string;
              /** @description ISO 8601 timestamp when workspace was created */
              createdAt: string;
              /** @description ISO 8601 timestamp when workspace was last seen */
              lastSeen: string;
              metadata?: {
                description?: string;
                tags?: string[];
                system?: boolean;
                atlasVersion?: string;
                lastError?: string;
                /** Format: date-time */
                lastErrorAt?: string;
                failureCount?: number;
                lastFinishedSession?: {
                  id: string;
                  /** @enum {string} */
                  status: "completed" | "failed";
                  /** Format: date-time */
                  finishedAt: string;
                  summary?: string;
                };
              };
            };
            backupPath?: string;
            filesModified?: string[];
            reloadRequired?: boolean;
            runtimeReloaded?: boolean;
            runtimeDestroyed?: boolean;
            message?: string;
            error?: string;
          };
        };
      };
      /** @description Invalid configuration or workspace not found */
      400: {
        headers: { [name: string]: unknown };
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
        headers: { [name: string]: unknown };
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
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Generated workspace configuration */
          config: { [key: string]: unknown };
          /** @description Custom workspace directory name (auto-resolves conflicts with -2, -3, etc.) */
          workspaceName?: string;
        };
      };
    };
    responses: {
      /** @description Workspace created successfully */
      200: {
        headers: { [name: string]: unknown };
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
              /** @enum {string} */
              status: "inactive" | "running" | "stopped";
              /** @description Filesystem path to the workspace */
              path: string;
              /** @description ISO 8601 timestamp when workspace was created */
              createdAt: string;
              /** @description ISO 8601 timestamp when workspace was last seen */
              lastSeen: string;
              metadata?: {
                description?: string;
                tags?: string[];
                system?: boolean;
                atlasVersion?: string;
                lastError?: string;
                /** Format: date-time */
                lastErrorAt?: string;
                failureCount?: number;
                lastFinishedSession?: {
                  id: string;
                  /** @enum {string} */
                  status: "completed" | "failed";
                  /** Format: date-time */
                  finishedAt: string;
                  summary?: string;
                };
              };
            };
            workspacePath?: string;
            filesCreated?: string[];
            error?: string;
          };
        };
      };
      /** @description Invalid configuration */
      400: {
        headers: { [name: string]: unknown };
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
        headers: { [name: string]: unknown };
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
        /** @description Workspace identifier (ID or name) */
        workspaceId: string;
        /** @description Signal name as defined in workspace configuration */
        signalId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": {
          /** @description Optional payload data for the signal */
          payload?: { [key: string]: unknown };
          /** @description Optional stream ID for UI progress feedback */
          streamId?: string;
        };
      };
    };
    responses: {
      /** @description Signal accepted for processing */
      200: {
        headers: { [name: string]: unknown };
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
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
          };
        };
      };
      /** @description Workspace or signal not found */
      404: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            /** @description Error message */
            error: string;
          };
        };
      };
    };
  };
  "GETApiChat-storage": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Conversation list retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { conversations: unknown[]; conversationCount: number } };
      };
      /** @description No conversations found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "GETApiChat-storage:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Conversation history retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { messages: unknown[]; messageCount: number } };
      };
      /** @description Conversation not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "PUTApiChat-storage:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: { content: { "application/json": { messages: unknown[] } } };
    responses: {
      /** @description Conversation updated successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": Record<string, never> };
      };
      /** @description Invalid request data */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  GETApiUser: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description User retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; user: string } };
      };
      /** @description User not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "GETApiTodos:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Todo list retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
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
              metadata?: { [key: string]: unknown };
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
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "POSTApiTodos:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: {
      content: {
        "application/json": {
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
            metadata?: { [key: string]: unknown };
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
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; message?: string } };
      };
      /** @description Invalid request data */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "DELETEApiTodos:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Todos deleted successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; deleted: boolean } };
      };
      /** @description Stream not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "DELETEApiSessions:sessionId": {
    parameters: { query?: never; header?: never; path: { sessionId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Session cancelled successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { message: string; workspaceId: string } };
      };
      /** @description Session not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  GETApiAgents: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved agents */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            agents: {
              id: string;
              name: string;
              description?: string;
              version?: string;
              /** @enum {string} */
              category: "system" | "bundled" | "sdk" | "yaml";
              expertise?: { domains: string[]; capabilities: string[]; examples: string[] };
              metadata?: { [key: string]: unknown };
            }[];
            total: number;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "GETApiAgents:id": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description Agent identifier */
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved agent */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            id: string;
            name: string;
            description?: string;
            version?: string;
            /** @enum {string} */
            category: "system" | "bundled" | "sdk" | "yaml";
            expertise?: { domains: string[]; capabilities: string[]; examples: string[] };
            metadata?: { [key: string]: unknown };
          };
        };
      };
      /** @description Agent not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "GETApiAgents:idExpertise": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description Agent identifier */
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successfully retrieved agent expertise */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            agentId: string;
            domains: string[];
            capabilities: string[];
            examples: string[];
            recommendedFor?: string[];
          };
        };
      };
      /** @description Agent expertise not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  POSTApiSse: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: {
      content: {
        "application/json": {
          streamId?: string;
          /** @default false */
          createOnly: boolean;
          workspaceId?: string;
          signal?: string;
        };
      };
    };
    responses: {
      /** @description Stream created successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; stream_id: string; sse_url: string } };
      };
      /** @description Invalid request parameters */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "GETApiSse:streamIdStream": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description SSE stream opened (AI SDK protocol) */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "text/event-stream": {
            type: string;
            /** @constant */
            format: "event-stream";
            /** @constant */
            description: "AI SDK UI Message Stream";
          };
        };
      };
      /** @description Stream not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "POSTApiSse:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: {
      content: {
        "application/json": {
          message: string;
          /** @default cli-user */
          userId: string;
          conversationId?: string;
          scope?: { [key: string]: unknown };
          metadata?: { [key: string]: unknown };
        };
      };
    };
    responses: {
      /** @description Message sent successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; message: string; messageId: string } };
      };
      /** @description Invalid request parameters */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Stream not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "POSTApiSse:streamIdEmit": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: { content: { "application/json": unknown } };
    responses: {
      /** @description Event emitted successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            success: boolean;
            message?: string;
            clientCount?: number;
            queueDepth?: number;
          };
        };
      };
      /** @description Invalid request parameters */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Stream not found or no connected clients */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  GETApiLibrary: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Library search results */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            items: {
              id: string;
              /** @enum {string} */
              type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
              name: string;
              description?: string;
              content_path: string;
              metadata: {
                /** @enum {string} */
                format: "markdown" | "json" | "html" | "text" | "binary";
                /** @enum {string} */
                source: "agent" | "job" | "user" | "system";
                session_id?: string;
                agent_ids?: string[];
                template_id?: string;
                generated_by?: string;
                custom_fields?: { [key: string]: unknown };
              };
              created_at: string;
              updated_at: string;
              tags: string[];
              size_bytes: number;
              workspace_id?: string;
            }[];
            total: number;
            query: {
              query?: string;
              type?: string | string[];
              tags?: string[];
              workspace?: boolean;
              since?: string;
              until?: string;
              /** @default 50 */
              limit: number;
              /** @default 0 */
              offset: number;
            };
            took_ms: number;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  POSTApiLibrary: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody: { content: { "application/json": unknown; "multipart/form-data": unknown } };
    responses: {
      /** @description Library item created successfully */
      201: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            success: boolean;
            itemId: string;
            message: string;
            item: {
              id: string;
              /** @enum {string} */
              type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
              name: string;
              description: string;
              content: string;
              metadata: {
                /** @enum {string} */
                format: "markdown" | "json" | "html" | "text" | "binary";
                /** @enum {string} */
                source: "agent" | "job" | "user" | "system";
                session_id?: string;
                agent_ids: string[];
              } & { [key: string]: unknown };
              created_at: string;
              updated_at: string;
              tags: string[];
              workspace_id?: string;
            };
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  GETApiLibrarySearch: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Library search results */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            items: {
              id: string;
              /** @enum {string} */
              type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
              name: string;
              description?: string;
              content_path: string;
              metadata: {
                /** @enum {string} */
                format: "markdown" | "json" | "html" | "text" | "binary";
                /** @enum {string} */
                source: "agent" | "job" | "user" | "system";
                session_id?: string;
                agent_ids?: string[];
                template_id?: string;
                generated_by?: string;
                custom_fields?: { [key: string]: unknown };
              };
              created_at: string;
              updated_at: string;
              tags: string[];
              size_bytes: number;
              workspace_id?: string;
            }[];
            total: number;
            query: {
              query?: string;
              type?: string | string[];
              tags?: string[];
              workspace?: boolean;
              since?: string;
              until?: string;
              /** @default 50 */
              limit: number;
              /** @default 0 */
              offset: number;
            };
            took_ms: number;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  GETApiLibraryTemplates: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Templates retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            id: string;
            name: string;
            description?: string;
            /** @enum {string} */
            format: "markdown" | "json" | "html" | "text";
            engine: string;
            config: { [key: string]: unknown };
            schema?: { [key: string]: unknown };
            metadata?: {
              version?: string;
              author?: string;
              tags?: string[];
              created_at?: string;
              updated_at?: string;
              usage_count?: number;
            };
          }[];
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  GETApiLibraryStats: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Library statistics retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            total_items: number;
            total_size_bytes: number;
            types: { [key: string]: number };
            recent_activity: { date: string; items_added: number; items_modified: number }[];
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  POSTApiLibraryGenerate: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody: { content: { "application/json": unknown } };
    responses: {
      /** @description Content generated successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            message: string;
            templateId: string;
            data?: unknown;
            options?: unknown;
          };
        };
      };
      /** @description Invalid request */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Not implemented */
      501: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            message: string;
            templateId: string;
            data?: unknown;
            options?: unknown;
          };
        };
      };
    };
  };
  "GETApiLibrary:itemIdDownload": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description ID of the library item to download */
        itemId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description File content */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/octet-stream": string };
      };
      /** @description Item not found */
      404: { headers: { [name: string]: unknown }; content: { "application/json": unknown } };
      /** @description Internal server error */
      500: { headers: { [name: string]: unknown }; content: { "application/json": unknown } };
    };
  };
  "GETApiLibrary:itemId": {
    parameters: { query?: never; header?: never; path: { itemId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Library item retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            item: {
              id: string;
              /** @enum {string} */
              type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
              name: string;
              description?: string;
              content_path: string;
              metadata: {
                /** @enum {string} */
                format: "markdown" | "json" | "html" | "text" | "binary";
                /** @enum {string} */
                source: "agent" | "job" | "user" | "system";
                session_id?: string;
                agent_ids?: string[];
                template_id?: string;
                generated_by?: string;
                custom_fields?: { [key: string]: unknown };
              };
              created_at: string;
              updated_at: string;
              tags: string[];
              size_bytes: number;
              workspace_id?: string;
            };
            content?: string;
          };
        };
      };
      /** @description Library item not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
  "DELETEApiLibrary:itemId": {
    parameters: { query?: never; header?: never; path: { itemId: string }; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Library item deleted successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { message: string } };
      };
      /** @description Library item not found */
      404: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { error: string } };
      };
    };
  };
}
