/**
 * Shared types for agents and execution
 * These types were previously in deleted files but are still needed
 */

/**
 * Runtime agent configuration
 */
export interface RuntimeAgentConfig {
  id: string;
  type: "llm" | "system" | "remote";
  model?: string;
  purpose?: string;
  prompts?: {
    system?: string;
    user?: string;
  };
  tools?: string[] | { mcp?: string[] };
  config?: Record<string, unknown>;
}

/**
 * Job specification for execution
 */
export interface JobSpecification {
  name: string;
  description?: string;
  triggers?: Array<{
    signal: string;
    response?: {
      mode?: string;
      format?: string;
      timeout?: number;
    };
  }>;
  execution: {
    strategy: "sequential" | "parallel" | "conditional";
    agents: Array<{
      id: string;
      input_source?: "signal" | "previous" | "context";
      config?: Record<string, unknown>;
    }>;
  };
  supervision?: {
    level?: "minimal" | "standard" | "paranoid";
  };
  memory?: {
    enabled?: boolean;
    fact_extraction?: boolean;
    working_memory_summary?: boolean;
  };
  resources?: {
    estimated_duration_seconds?: number;
  };
}

/**
 * Agent metadata for execution
 */
export interface AgentMetadata {
  id: string;
  name: string;
  type: "llm" | "system" | "remote";
  purpose?: string;
  model?: string;
  config?: Record<string, unknown>;
}
