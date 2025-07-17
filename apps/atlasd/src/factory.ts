import { createFactory } from "hono/factory";
import type { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import type { WorkspaceManager } from "@atlas/core";

// Define app context that will be available to all routes
export interface AppContext {
  runtimes: Map<string, WorkspaceRuntime>;
  startTime: number;
  sseClients: Map<string, Array<{ controller: ReadableStreamDefaultController<Uint8Array> }>>;
  getWorkspaceManager(): WorkspaceManager;
  // Add other app internals as needed
}

// Define variables available in context
export type AppVariables = {
  Variables: { app: AppContext };
};

// Create the factory with our types
export const daemonFactory = createFactory<AppVariables>();

// Helper to create a Hono app with context
export const createApp = (context: AppContext) => {
  const app = daemonFactory.createApp();

  // Set app context as a variable available to all routes
  app.use("*", async (c, next) => {
    c.set("app", context);
    await next();
  });

  return app;
};

// Helper to create handlers that have access to app context
export const createHandler = daemonFactory.createHandlers;
