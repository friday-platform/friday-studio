/**
 * Agent Orchestrator Module
 *
 * Exports the centralized agent execution orchestrator that replaces
 * AgentExecutionActor with MCP-based communication.
 */

export { AgentOrchestrator } from "./agent-orchestrator.ts";
export type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentExpertise,
  AgentMetadata,
  AgentOrchestratorConfig,
  AgentResult,
  ApprovalDecision,
  AwaitingApprovalResult,
  CompletedAgentResult,
  IAgentOrchestrator,
} from "./agent-orchestrator.ts";
