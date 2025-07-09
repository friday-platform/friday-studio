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
    get: operations["getHealth"];
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
    get: operations["getApiWorkspaces"];
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
    get: operations["getApiWorkspacesByWorkspaceId"];
    put?: never;
    post?: never;
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
  getHealth: {
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
  getApiWorkspaces: {
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
            /** @description Whether the workspace has an active runtime */
            hasActiveRuntime: boolean;
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
  getApiWorkspacesByWorkspaceId: {
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
            /** @description Whether the workspace has an active runtime */
            hasActiveRuntime: boolean;
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
}
