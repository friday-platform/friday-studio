import type { AgentRegistry } from "@atlas/agent-sdk";
import type { AtlasDaemon } from "@atlas/atlasd";
import type { WorkspaceManager } from "@atlas/workspace";
import { cors } from "hono/cors";
import { createFactory } from "hono/factory";
import type { LibraryStorageAdapter } from "../../../src/core/storage/library-storage-adapter.ts";
import type { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import type { StreamRegistry } from "./stream-registry.ts";

type SSEClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: number;
  lastActivity: number;
};

type SSEStreamMetadata = { createdAt: number; lastActivity: number; lastEmit: number };

// Define app context that will be available to all routes
export interface AppContext {
  runtimes: Map<string, WorkspaceRuntime>;
  startTime: number;
  sseClients: Map<string, SSEClient[]>;
  sseStreams: Map<string, SSEStreamMetadata>;
  getWorkspaceManager(): WorkspaceManager;

  // Signal route methods
  getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime>;
  resetIdleTimeout(workspaceId: string): void;

  // Runtime management methods
  getWorkspaceRuntime(workspaceId: string): WorkspaceRuntime | undefined;
  destroyWorkspaceRuntime(workspaceId: string): Promise<void>;

  // Library storage methods
  getLibraryStorage(): LibraryStorageAdapter;

  // Agent registry
  getAgentRegistry(): AgentRegistry;

  // Core daemon access
  daemon: AtlasDaemon;

  // Stream registry for managing chat streams
  streamRegistry: StreamRegistry;
}

export interface CreateAppOptions {
  corsOrigins?: string | string[];
}

// Define variables available in context
export type AppVariables = { Variables: { app: AppContext } };

// Create the factory with our types
export const daemonFactory = createFactory<AppVariables>();

// Helper to create a Hono app with context
export const createApp = (context: AppContext, options: CreateAppOptions = {}) => {
  const app = daemonFactory.createApp();

  // Set app context as a variable available to all routes
  app.use("*", async (c, next) => {
    c.set("app", context);
    await next();
  });

  // Configure CORS - Hono natively handles string, string[], or "*"
  app.use("*", cors({ origin: options.corsOrigins ?? "*", exposeHeaders: ["X-Turn-Started-At"] }));

  return app;
};
