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

export interface JobDetailedInfo {
  name: string;
  description?: string;
  task_template?: string;
  triggers?: Array<{ signal: string; condition?: string | Record<string, unknown> }>;
  session_prompts?: { planning?: string; evaluation?: string };
  execution: {
    strategy: "sequential" | "parallel";
    agents: Array<
      | string
      | {
          id: string;
          task?: string;
          input_source?: "signal" | "previous" | "combined" | "filesystem_context";
          dependencies?: string[];
          tools?: string[];
        }
    >;
    context?: {
      filesystem?: {
        patterns: string[];
        base_path?: string;
        max_file_size?: number;
        include_content?: boolean;
      };
      memory?: { recall_limit?: number; strategy?: string };
    };
    timeout_seconds?: number;
    max_iterations?: number;
  };
  success_criteria?: Record<string, unknown>;
  error_handling?: {
    max_retries?: number;
    retry_delay_seconds?: number;
    timeout_seconds?: number;
    stage_failure_strategy?: string;
  };
  resources?: {
    estimated_duration_seconds?: number;
    max_memory_mb?: number;
    required_capabilities?: string[];
    concurrent_agent_limit?: number;
  };
}
