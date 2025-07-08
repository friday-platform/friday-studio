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
}
