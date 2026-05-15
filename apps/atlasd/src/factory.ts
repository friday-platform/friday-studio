import type { AgentRegistry } from "@atlas/agent-sdk";
import type { AtlasDaemon } from "@atlas/atlasd";
import type { SessionHistoryAdapter } from "@atlas/core";
import type { PlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { cors } from "hono/cors";
import { createFactory } from "hono/factory";
import type { ChatSdkInstance } from "./chat-sdk/chat-sdk-instance.ts";
import type { ChatTurnRegistry } from "./chat-turn-registry.ts";
import type { SessionDispatchRegistry } from "./session-dispatch-registry.ts";
import { createSessionMiddleware } from "./session-middleware.ts";
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
  startTime: number;
  sseClients: Map<string, SSEClient[]>;
  sseStreams: Map<string, SSEStreamMetadata>;
  getWorkspaceManager(): WorkspaceManager;

  // Agent registry
  getAgentRegistry(): AgentRegistry;

  // Build a fresh chat-SDK instance for the workspace. Per-call construction;
  // callers receive a self-contained instance and must `teardown()` if they
  // need to release platform resources (most webhook handlers don't, since
  // adapters are HTTP-only and have no persistent listeners).
  getOrCreateChatSdkInstance(workspaceId: string): Promise<ChatSdkInstance>;

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

  // Daemon-level routing for session-cancel commands (NATS subscription
  // on `daemon.cancel.sessions.>`). Routes are added by the runtime as it
  // creates AbortControllers; cancel callers publish via
  // `publishSessionCancel`.
  sessionDispatchRegistry: SessionDispatchRegistry;

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
export type AppVariables = { Variables: { app: AppContext; userId?: string } };

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

  // Stamp `ctx.userId` from the opaque session cookie (or Bearer header).
  // Local mode auto-mints; non-local 401s on missing/invalid token.
  //
  // Scoped to `/api/*` so the public + signed + side-channel surfaces
  // mounted at root — `/health` (liveness probes), `/signals/*` (signed
  // provider webhooks like Slack / Discord), `/mcp` and `/agents`
  // (MCP transports that authenticate via `Mcp-Session-Id` headers,
  // not Friday session cookies) — keep working in non-dev where the
  // middleware would otherwise 401 anything without a browser cookie.
  app.use("/api/*", createSessionMiddleware());

  return app;
};
