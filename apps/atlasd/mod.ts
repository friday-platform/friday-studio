export type { LinkRoutes } from "@atlas/link";
export { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
export type { ArtifactsRoutes } from "./routes/artifacts.ts";
export type { ChatRoutes } from "./routes/chat.ts";
export type { ChatStorageRoutes } from "./routes/chat-storage.ts";
export type { ConfigRoutes } from "./routes/config.ts";
export type { DaemonRoutes } from "./routes/daemon.ts";
export type { HealthRoutes } from "./routes/health.ts";
export type { JobsRoutes } from "./routes/jobs.ts";
export type { MCPRegistryRoutes } from "./routes/mcp-registry.ts";
export type { MeRoutes, UserIdentity } from "./routes/me/index.ts";
export type { MemoryRoutes } from "./routes/memory/index.ts";
export type { ReportRoutes } from "./routes/report.ts";
export type { SessionsRoutes } from "./routes/sessions/index.ts";
export type { ShareRoutes } from "./routes/share.ts";
export type { SkillsRoutes } from "./routes/skills.ts";
export type { WorkspaceChatRoutes } from "./routes/workspaces/chat.ts";
export type { WorkspaceConfigRoutes } from "./routes/workspaces/config.ts";
export type { WorkspaceRoutes } from "./routes/workspaces/index.ts";
export type { IntegrationRoutes } from "./routes/workspaces/integrations.ts";
export type { WorkspaceMCPRoutes } from "./routes/workspaces/mcp.ts";
// Type-only re-export so consumers can reference `AtlasDaemon` and other
// runtime types without dragging the daemon's full module graph into their
// process. Anything that actually constructs / runs the daemon must import
// directly from `./src/atlas-daemon.ts`. Keeping this `export type *`
// matters for CLI tools that only need the types: a runtime `export *`
// here force-loads chat-migration, signal-stream, NATS connections etc.
// when a CLI just wanted route shapes via @atlas/client.
export type * from "./src/atlas-daemon.ts";
export { type AppContext, type AppVariables, createApp } from "./src/factory.ts";
export { OPENAPI_DOCUMENTATION } from "./src/openapi-config.ts";
export { getAtlasDaemonUrl } from "./src/utils.ts";
