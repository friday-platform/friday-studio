/**
 * Agent metadata interface for agent configuration and execution
 */
export interface AgentMetadata {
  id: string;
  type: string;
  config?: unknown;
  parentScopeId?: string;
}
