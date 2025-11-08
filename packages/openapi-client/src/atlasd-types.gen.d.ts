export interface paths {
  "/api/config/env": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Get environment variables
     * @description Read environment variables from ~/.atlas/.env file
     */
    get: operations["getApiConfigEnv"];
    /**
     * Update environment variables
     * @description Write environment variables to ~/.atlas/.env file
     */
    put: operations["putApiConfigEnv"];
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
    get: operations["getApiUser"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/scratchpad/{streamId}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    /**
     * Retrieve scratchpad notes
     * @description Get notes for a stream
     */
    get: operations["getApiScratchpad:streamId"];
    put?: never;
    /**
     * Append note to scratchpad
     * @description Add a note to the scratchpad
     */
    post: operations["postApiScratchpad:streamId"];
    delete?: never;
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
    get: operations["getApiAgents"];
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
    get: operations["getApiAgents:id"];
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
    get: operations["getApiAgents:idExpertise"];
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
    post: operations["postApiSse"];
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
    get: operations["getApiSse:streamIdStream"];
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
    post: operations["postApiSse:streamId"];
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
    post: operations["postApiSse:streamIdEmit"];
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
    get: operations["getApiLibrary"];
    put?: never;
    /**
     * Create library item
     * @description Create a new library item with content and metadata. Accepts JSON or multipart/form-data.
     */
    post: operations["postApiLibrary"];
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
    get: operations["getApiLibrarySearch"];
    put?: never;
    /**
     * Create library item
     * @description Create a new library item with content and metadata. Accepts JSON or multipart/form-data.
     */
    post: operations["postApiLibrarySearch"];
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
    get: operations["getApiLibraryTemplates"];
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
    get: operations["getApiLibraryStats"];
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
    get: operations["getApiLibrary:itemId"];
    put?: never;
    post?: never;
    /**
     * Delete library item
     * @description Permanently delete a library item and its content by ID.
     */
    delete: operations["deleteApiLibrary:itemId"];
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
  getApiConfigEnv: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: {
      /** @description Environment variables retrieved successfully */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            success: boolean;
            envVars?: { [key: string]: string };
            error?: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; error: string } };
      };
    };
  };
  putApiConfigEnv: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: { content: { "application/json": { envVars: { [key: string]: string } } } };
    responses: {
      /** @description Environment variables updated successfully */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; error?: string } };
      };
      /** @description Bad request */
      400: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; error: string } };
      };
      /** @description Internal server error */
      500: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean; error: string } };
      };
    };
  };
  getApiUser: {
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
  "getApiScratchpad:streamId": {
    parameters: {
      query?: { limit?: number };
      header?: never;
      path: { streamId: string };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Notes retrieved */
      200: {
        headers: { [name: string]: unknown };
        content: {
          "application/json": {
            notes: {
              /** @description A note to track */
              note: string;
            }[];
            count: number;
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
  "postApiScratchpad:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: { content: { "application/json": { note: string } } };
    responses: {
      /** @description Note stored */
      200: {
        headers: { [name: string]: unknown };
        content: { "application/json": { success: boolean } };
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
  getApiAgents: {
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
  "getApiAgents:id": {
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
  "getApiAgents:idExpertise": {
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
  postApiSse: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: {
      content: {
        "application/json": {
          streamId?: string;
          /** @default false */
          createOnly?: boolean;
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
  "getApiSse:streamIdStream": {
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
  "postApiSse:streamId": {
    parameters: { query?: never; header?: never; path: { streamId: string }; cookie?: never };
    requestBody?: {
      content: {
        "application/json": {
          message: string;
          /** @default cli-user */
          userId?: string;
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
  "postApiSse:streamIdEmit": {
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
  getApiLibrary: {
    parameters: {
      query?: {
        query?: string;
        q?: string;
        type?: string;
        tags?: string;
        since?: string;
        until?: string;
        limit?: number;
        offset?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
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
              mime_type: string;
              metadata: {
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
              type?:
                | ("report" | "session_archive" | "template" | "artifact" | "user_upload")
                | ("report" | "session_archive" | "template" | "artifact" | "user_upload")[];
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
      /** @description Invalid query parameters */
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
  postApiLibrary: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
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
              description?: string;
              content_path: string;
              mime_type: string;
              metadata: {
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
            path: string;
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
  getApiLibrarySearch: {
    parameters: {
      query?: {
        query?: string;
        q?: string;
        type?: string;
        tags?: string;
        since?: string;
        until?: string;
        limit?: number;
        offset?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
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
              mime_type: string;
              metadata: {
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
              type?:
                | ("report" | "session_archive" | "template" | "artifact" | "user_upload")
                | ("report" | "session_archive" | "template" | "artifact" | "user_upload")[];
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
      /** @description Invalid query parameters */
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
  postApiLibrarySearch: {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    requestBody?: never;
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
              description?: string;
              content_path: string;
              mime_type: string;
              metadata: {
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
            path: string;
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
  getApiLibraryTemplates: {
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
            mime_type: string;
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
  getApiLibraryStats: {
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
  "getApiLibrary:itemId": {
    parameters: {
      query?: { content?: "true" };
      header?: never;
      path: { itemId: string };
      cookie?: never;
    };
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
              mime_type: string;
              metadata: {
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
  "deleteApiLibrary:itemId": {
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
