/**
 * Serializable workspace configuration
 */

import type { ProviderConfig } from "./providers/types.ts";

export interface WorkspaceConfig {
  // Metadata
  id?: string;
  name: string;
  description?: string;
  version: string;
  owner?: string;

  // Supervisor configuration
  supervisor?: {
    provider: string; // e.g., "anthropic", "openai"
    model?: string;
    prompts?: {
      system?: string;
      user?: string;
      intent?: string;
      evaluation?: string;
      session?: string;
    };
    lazyLoad?: boolean;
  };

  // Providers
  providers?: ProviderConfig[];

  // Signals (reference providers)
  signals?: SignalConfig[];

  // Agents (reference providers)
  agents?: AgentConfig[];

  // Workflows
  workflows?: WorkflowConfig[];

  // Session configuration
  sessions?: {
    maxConcurrent?: number;
    timeout?: number;
  };

  // Server configuration
  server?: {
    port?: number;
    host?: string;
  };
}

export interface SignalConfig {
  id: string;
  name: string;
  description?: string;
  providerId: string; // References a provider
  config?: Record<string, any>; // Provider-specific config
  conditions?: {
    schedule?: string; // Cron expression
    filter?: string; // Expression to filter events
  };
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  providerId: string; // References a provider
  type: string; // Provider-specific agent type
  config?: Record<string, any>; // Provider-specific config
}

export interface WorkflowConfig {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  type: "agent" | "action" | "condition" | "parallel";
  config: Record<string, any>;
  next?: string[]; // Step IDs
}

// Note: See examples/workspaces/ for real workspace configuration examples
// The actual workspace.yml format differs from this interface and uses a more direct structure
