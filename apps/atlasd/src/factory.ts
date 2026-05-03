import type { AgentRegistry } from "@atlas/agent-sdk";
import type { AtlasDaemon } from "@atlas/atlasd";
import type { SessionHistoryAdapter } from "@atlas/core";
import type { PlatformModels } from "@atlas/llm";
import type { WorkspaceManager, WorkspaceRuntime } from "@atlas/workspace";
import { cors } from "hono/cors";
import { createFactory } from "hono/factory";
import type { ChatSdkInstance } from "./chat-sdk/chat-sdk-instance.ts";
import type { ChatTurnRegistry } from "./chat-turn-registry.ts";
import type { SessionStreamRegistry } from "./session-stream-registry.ts";
import type { StreamRegistry } from "./stream-registry.ts";

export const KERNEL_WORKSPACE_ID = "system" as const;
export const USER_WORKSPACE_ID = "user" as const;

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

  // Agent registry
  getAgentRegistry(): AgentRegistry;

  // Chat SDK instance per workspace
  getOrCreateChatSdkInstance(workspaceId: string): Promise<ChatSdkInstance>;
  evictChatSdkInstance(workspaceId: string): Promise<void>;

  // Core daemon access
  daemon: AtlasDaemon;

  // Stream registry for managing chat streams
  streamRegistry: StreamRegistry;

  // Per-chat AbortController registry — aborts the in-flight turn when the
  // user sends a follow-up message in the same chat. See ChatTurnRegistry.
  chatTurnRegistry: ChatTurnRegistry;

  // Session stream registry for managing session event streams (v2)
  sessionStreamRegistry: SessionStreamRegistry;

  // Session history adapter for reading completed sessions (v2)
  sessionHistoryAdapter: SessionHistoryAdapter;

  // When true, the kernel workspace is visible in user-facing lists
  exposeKernel: boolean;

  // Platform LLM resolver (friday.yml models config, per-role).
  // Required for any route that invokes `smallLLM` or needs the daemon's
  // configured classifier/planner/conversational/labels model.
  platformModels: PlatformModels;
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
