/**
 * Default Atlas platform configuration
 * Used as fallback when atlas.yml is missing or incomplete
 */

import type { AtlasConfig } from "../schemas.ts";
import { AtlasConfigSchema } from "../schemas.ts";

// Define the default configuration with TypeScript validation
const atlasDefaultsUnvalidated: AtlasConfig = {
  version: "1.0",

  workspace: {
    id: "atlas-platform",
    name: "Atlas Platform",
    description: "Default Atlas platform workspace with global management capabilities",
  },

  // Platform MCP server configuration
  server: {
    mcp: {
      enabled: true,
      discoverable: {
        capabilities: ["workspace_*"],
        jobs: [],
      },
    },
  },

  // Platform tools and federation policies
  tools: {
    mcp: {
      client_config: {
        timeout: 30000,
      },
      policies: {
        type: "allowlist",
        allowed: ["filesystem-mcp", "memory-mcp"],
      },
    },
  },

  // No platform-specific agents for default config
  agents: {},

  memory: {
    default: {
      enabled: true,
      storage: "coala-local",
      cognitive_loop: true,
      retention: {
        max_age_days: 30,
        max_entries: 1000,
        cleanup_interval_hours: 24,
      },
    },

    agent: {
      enabled: true,
      scope: "agent" as const,
      include_in_context: true,
      context_limits: {
        relevant_memories: 2,
        past_successes: 1,
        past_failures: 1,
      },
      memory_types: {
        working: {
          enabled: true,
          max_age_hours: 2,
          max_entries: 50,
        },
        procedural: {
          enabled: true,
          max_age_days: 7,
          max_entries: 100,
        },
        episodic: {
          enabled: false,
          max_age_days: 1,
          max_entries: 10,
        },
        semantic: {
          enabled: true,
          max_age_days: 14,
          max_entries: 200,
        },
        contextual: {
          enabled: false,
          max_age_hours: 1,
          max_entries: 5,
        },
      },
    },

    session: {
      enabled: true,
      scope: "session" as const,
      include_in_context: true,
      context_limits: {
        relevant_memories: 5,
        past_successes: 3,
        past_failures: 2,
      },
      memory_types: {
        working: {
          enabled: true,
          max_age_hours: 24,
          max_entries: 100,
        },
        episodic: {
          enabled: true,
          max_age_days: 7,
          max_entries: 50,
        },
        procedural: {
          enabled: true,
          max_age_days: 30,
          max_entries: 200,
        },
        semantic: {
          enabled: true,
          max_age_days: 90,
          max_entries: 500,
        },
        contextual: {
          enabled: true,
          max_age_hours: 24,
          max_entries: 100,
        },
      },
    },

    workspace: {
      enabled: true,
      scope: "workspace" as const,
      include_in_context: false,
      context_limits: {
        relevant_memories: 10,
        past_successes: 5,
        past_failures: 3,
      },
      memory_types: {
        working: {
          enabled: false,
          max_entries: 0,
        },
        episodic: {
          enabled: true,
          max_age_days: 90,
          max_entries: 1000,
        },
        procedural: {
          enabled: true,
          max_age_days: 365,
          max_entries: 500,
        },
        semantic: {
          enabled: true,
          max_age_days: 365,
          max_entries: 2000,
        },
        contextual: {
          enabled: true,
          max_age_days: 30,
          max_entries: 200,
        },
      },
    },
  },

  supervisors: {
    workspace: {
      model: "claude-3-5-sonnet-20241022",
      memory: "workspace",
      prompts: {
        system: `You are a WorkspaceSupervisor responsible for orchestrating AI agent execution.
Your role is to analyze signals, create filtered session contexts, and manage workspace-level concerns.

Key responsibilities:
- Analyze incoming signals to understand intent and goals
- Filter workspace context for relevant session data
- Spawn SessionSupervisors with appropriate context
- Coordinate multiple concurrent sessions
- Manage signal-to-agent mappings dynamically`,
      },
    },

    session: {
      model: "claude-3-5-sonnet-20241022",
      memory: "session",
      prompts: {
        system:
          `You are a SessionSupervisor responsible for coordinating agent execution within a session.
Your role is to create execution plans, orchestrate agents, and evaluate progress.

Key responsibilities:
- Create dynamic execution plans using LLM reasoning
- Determine agent selection, order, and data flow
- Coordinate agent execution through AgentSupervisor
- Evaluate progress and adapt strategy as needed
- Support iterative refinement loops`,
      },
    },

    agent: {
      model: "claude-3-5-sonnet-20241022",
      memory: "agent",
      prompts: {
        system: `You are an AgentSupervisor responsible for safe agent loading and execution.
Your role is to analyze agents for safety, prepare secure environments, and supervise execution.

Key responsibilities:
- Analyze agents for safety and optimization before loading
- Prepare secure execution environments
- Monitor agent execution in real-time
- Validate outputs for quality and safety
- Handle failures and recovery scenarios`,
      },
    },
  },
};

// Validate the default configuration against the schema at module load time
// This ensures our defaults are always valid according to the schema
export const atlasDefaults = AtlasConfigSchema.parse(atlasDefaultsUnvalidated);
