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

// Example workspace config
export const exampleWorkspaceConfig: WorkspaceConfig = {
  name: "My AI Workspace",
  description: "Example workspace configuration",
  version: "1.0.0",
  owner: "user@example.com",
  
  supervisor: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    prompts: {
      system: "You are a helpful workspace supervisor."
    }
  },
  
  providers: [
    {
      id: "github-webhook",
      type: "signal" as any,
      provider: "http-webhook",
      config: {
        endpoint: "/webhooks/github"
      }
    },
    {
      id: "claude-provider",
      type: "agent" as any,
      provider: "anthropic",
      config: {
        defaultModel: "claude-3-haiku-20240307"
      }
    }
  ],
  
  signals: [
    {
      id: "pr-opened",
      name: "Pull Request Opened",
      providerId: "github-webhook",
      config: {
        event: "pull_request",
        action: "opened"
      }
    }
  ],
  
  agents: [
    {
      id: "code-reviewer",
      name: "Code Review Agent",
      providerId: "claude-provider",
      type: "reviewer",
      config: {
        model: "claude-3-5-sonnet-20241022",
        temperature: 0.3
      }
    }
  ],
  
  sessions: {
    maxConcurrent: 3,
    timeout: 300000
  },
  
  server: {
    port: 8080,
    host: "localhost"
  }
};