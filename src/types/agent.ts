/**
 * Agent metadata interface for agent configuration and execution
 */
export interface AgentMetadata {
  id: string;
  type: string;
  config?: any;
  parentScopeId?: string;
}