import type { AgentRegistry } from "@atlas/agent-sdk";
import type { AtlasDaemon } from "@atlas/atlasd";
import type { SessionHistoryAdapter } from "@atlas/core";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { LibraryStorageAdapter } from "@atlas/storage";
import type { WorkspaceManager, WorkspaceRuntime } from "@atlas/workspace";
import { cors } from "hono/cors";
import { createFactory } from "hono/factory";
import type { SessionStreamRegistry } from "./session-stream-registry.ts";
import type { StreamRegistry } from "./stream-registry.ts";

type SSEClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: number;
  lastActivity: number;
};

type SSEStreamMetadata = { createdAt: number; lastActivity: number; lastEmit: number };

export interface AppContext {
  runtimes: Map<string, WorkspaceRuntime>;
  startTime: number;
  sseClients: Map<string, SSEClient[]>;
  sseStreams: Map<string, SSEStreamMetadata>;
  getWorkspaceManager(): WorkspaceManager;

  getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime>;
  resetIdleTimeout(workspaceId: string): void;
  getWorkspaceRuntime(workspaceId: string): WorkspaceRuntime | undefined;
  destroyWorkspaceRuntime(workspaceId: string): Promise<void>;
  getLibraryStorage(): LibraryStorageAdapter;
  getAgentRegistry(): AgentRegistry;
  getLedgerAdapter(): ResourceStorageAdapter;
  daemon: AtlasDaemon;
  streamRegistry: StreamRegistry;
  sessionStreamRegistry: SessionStreamRegistry;
  sessionHistoryAdapter: SessionHistoryAdapter;
}

export interface CreateAppOptions {
  corsOrigins?: string | string[];
}

export type AppVariables = { Variables: { app: AppContext } };

export const daemonFactory = createFactory<AppVariables>();

export const createApp = (context: AppContext, options: CreateAppOptions = {}) => {
  const app = daemonFactory.createApp();

  app.use("*", async (c, next) => {
    c.set("app", context);
    await next();
  });

  app.use("*", cors({ origin: options.corsOrigins ?? "*", exposeHeaders: ["X-Turn-Started-At"] }));

  return app;
};
