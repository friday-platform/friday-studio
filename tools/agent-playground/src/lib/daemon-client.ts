import type {
  ChatRoutes,
  CronRoutes,
  HealthRoutes,
  JobsRoutes,
  MCPRegistryRoutes,
  SessionsRoutes,
  SkillsRoutes,
  WorkspaceChatRoutes,
  WorkspaceConfigRoutes,
  WorkspaceMCPRoutes,
  WorkspaceRoutes,
} from "@atlas/atlasd/types";
import { hc } from "hono/client";

/**
 * Proxy base — all daemon requests route through the SvelteKit proxy
 * at `/api/daemon/`, which strips the prefix and forwards to the daemon.
 */
const PROXY_BASE = "/api/daemon";

/**
 * Creates a typed Hono RPC client for the local daemon, routed through the
 * SvelteKit proxy. Each route group gets its own `hc` instance matching the
 * daemon's mount points.
 *
 * @param customFetch - Fetch implementation (use SvelteKit's `fetch` in load functions)
 */
function makeDaemonClient(customFetch: typeof globalThis.fetch) {
  return {
    health: hc<HealthRoutes>(`${PROXY_BASE}/health`, { fetch: customFetch }),
    // POST /api/chat routes through Chat SDK per-workspace into the `user` workspace.
    chat: hc<ChatRoutes>(`${PROXY_BASE}/api/chat`, { fetch: customFetch }),
    workspace: hc<WorkspaceRoutes>(`${PROXY_BASE}/api/workspaces`, { fetch: customFetch }),
    workspaceConfig: (workspaceId: string) =>
      hc<WorkspaceConfigRoutes>(`${PROXY_BASE}/api/workspaces/${workspaceId}/config`, {
        fetch: customFetch,
      }),
    workspaceChat: (workspaceId: string) =>
      hc<WorkspaceChatRoutes>(`${PROXY_BASE}/api/workspaces/${workspaceId}/chat`, {
        fetch: customFetch,
      }),
    workspaceMcp: (workspaceId: string) =>
      hc<WorkspaceMCPRoutes>(`${PROXY_BASE}/api/workspaces/${workspaceId}/mcp`, {
        fetch: customFetch,
      }),
    sessions: hc<SessionsRoutes>(`${PROXY_BASE}/api/sessions`, { fetch: customFetch }),
    skills: hc<SkillsRoutes>(`${PROXY_BASE}/api/skills`, { fetch: customFetch }),
    jobs: hc<JobsRoutes>(`${PROXY_BASE}/api/jobs`, { fetch: customFetch }),
    mcp: hc<MCPRegistryRoutes>(`${PROXY_BASE}/api/mcp-registry`, { fetch: customFetch }),
    cron: hc<CronRoutes>(`${PROXY_BASE}/api/cron`, { fetch: customFetch }),
  };
}

type DaemonClient = ReturnType<typeof makeDaemonClient>;

let browserClient: DaemonClient | undefined;

/** Singleton client for browser-side use. */
export function getDaemonClient(): DaemonClient {
  if (!browserClient) {
    browserClient = makeDaemonClient(globalThis.fetch);
  }
  return browserClient;
}
