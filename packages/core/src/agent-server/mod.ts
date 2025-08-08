/**
 * Atlas Agent MCP Server
 *
 * Proprietary MCP server implementation for hosting Atlas agents.
 * This server exposes agents as MCP tools with session management,
 * state persistence, and human-in-the-loop approval flows.
 *
 * Architecture:
 *   Session Supervisor
 *       ↓ (executes agents via)
 *   Agent Execution Manager
 *       ↓ (creates/manages)
 *   Agent Execution Machines (XState actors)
 *       ↓ (when approval needed)
 *   Approval Queue Manager (stores suspended states)
 */

export { AtlasAgentsMCPServer } from "./server.ts";
export { ApprovalQueueManager } from "./approval-queue-manager.ts";
export { AgentExecutionManager } from "./agent-execution-manager.ts";
export { InMemoryAgentRegistry } from "./in-memory-registry.ts";
export type { AgentServerDependencies, AgentSessionState, PendingPrompt } from "./types.ts";
