/**
 * Atlas Agent MCP Server
 *
 * Proprietary MCP server implementation for hosting Atlas agents.
 * This server exposes agents as MCP tools with session management
 * and state persistence.
 *
 * Architecture:
 *   Session Supervisor
 *       ↓ (executes agents via)
 *   Agent Execution Manager
 *       ↓ (creates/manages)
 *   Agent Execution Machines (XState actors)
 */

export { AtlasAgentsMCPServer } from "./server.ts";
export type { AgentServerDependencies, AgentSessionState, PendingPrompt } from "./types.ts";
