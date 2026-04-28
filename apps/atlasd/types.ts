/**
 * Type-only exports for consumers that only need route types (e.g., RPC clients).
 * Does NOT import any runtime code — safe for browser bundles.
 */
export type { LinkRoutes } from "@atlas/link";
export type { ArtifactsRoutes } from "./routes/artifacts.ts";
export type { CronRoutes } from "./routes/cron.ts";
export type { ChatRoutes } from "./routes/chat.ts";
export type { ChatStorageRoutes } from "./routes/chat-storage.ts";
export type { ConfigRoutes } from "./routes/config.ts";
export type { DaemonRoutes } from "./routes/daemon.ts";
export type { HealthRoutes } from "./routes/health.ts";
export type { JobsRoutes } from "./routes/jobs.ts";
export type { MCPRegistryRoutes } from "./routes/mcp-registry.ts";
export type { MeRoutes, UserIdentity } from "./routes/me/index.ts";
export type { SessionsRoutes } from "./routes/sessions/index.ts";
export type { ShareRoutes } from "./routes/share.ts";
export type { SkillsRoutes } from "./routes/skills.ts";
export type { WorkspaceChatRoutes } from "./routes/workspaces/chat.ts";
export type { WorkspaceConfigRoutes } from "./routes/workspaces/config.ts";
export type { WorkspaceRoutes } from "./routes/workspaces/index.ts";
export type { IntegrationRoutes } from "./routes/workspaces/integrations.ts";
export type { WorkspaceMCPRoutes } from "./routes/workspaces/mcp.ts";
