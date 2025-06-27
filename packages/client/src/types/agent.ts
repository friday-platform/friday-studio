/**
 * Agent-related type definitions
 */

export interface AgentInfo {
  id: string;
  type: string;
  purpose?: string;
}

export interface JobInfo {
  name: string;
  description?: string;
}
