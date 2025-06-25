/**
 * Resource-specific help documentation for Atlas CLI commands
 */

export interface ResourceHelp {
  overview: string;
  concepts?: string;
  commonTasks?: string[];
  troubleshooting?: string[];
  seeAlso?: string[];
}

export const resourceHelp: Record<string, ResourceHelp> = {
  workspace: {
    overview: `
Workspaces are the fundamental units in Atlas that contain your AI agents, signals, 
and job configurations. Each workspace is a self-contained environment with its own 
configuration, state, and runtime.`,
    concepts: `
Key Concepts:
  • workspace.yml: The main configuration file defining agents, signals, and jobs
  • Agents: AI-powered or deterministic workers that execute tasks
  • Signals: Events that trigger job execution (webhooks, CLI, scheduled)
  • Jobs: Workflows that map signals to agent executions`,
    commonTasks: [
      "Initialize a new workspace: atlas workspace init my-agent",
      "Start workspace server: atlas workspace serve",
      "Run in background: atlas workspace serve --detached",
      "Check workspace status: atlas workspace status",
      "Stop a workspace: atlas workspace stop",
    ],
    troubleshooting: [
      "Port already in use: Use --port flag to specify a different port",
      "Workspace not found: Ensure you're in the workspace directory or use --workspace flag",
      "ANTHROPIC_API_KEY missing: Add your API key to the .env file",
    ],
    seeAlso: ["session", "signal", "agent", "library"],
  },

  session: {
    overview: `
Sessions represent active executions triggered by signals in your workspace. Each 
session has a unique ID and tracks the execution state of agents responding to 
a signal.`,
    concepts: `
Key Concepts:
  • Session ID: Unique identifier (e.g., sess_abc123) for tracking execution
  • Session State: created → planning → executing → completed/failed
  • Agent Coordination: Sessions manage multiple agent executions
  • Isolation: Each session runs in its own context with filtered memory`,
    commonTasks: [
      "List active sessions: atlas session list or atlas ps",
      "View session details: atlas session get sess_abc123",
      "Cancel a running session: atlas session cancel sess_xyz789",
      "Filter by workspace: atlas session list --workspace my-agent",
      "Export as JSON: atlas session list --json",
    ],
    troubleshooting: [
      "No sessions found: Ensure workspace is running and signals have been triggered",
      "Session stuck: Check logs with 'atlas logs sess_abc123'",
      "Can't cancel session: Session may have already completed or failed",
    ],
    seeAlso: ["workspace", "signal", "logs"],
  },

  signal: {
    overview: `
Signals are events that trigger job execution in your workspace. They can come from 
various sources like HTTP webhooks, CLI commands, scheduled timers, or external 
systems.`,
    concepts: `
Key Concepts:
  • Signal Providers: cli, http, schedule, github, etc.
  • Signal Payload: Data passed to jobs when triggered
  • Signal-Job Mapping: Configuration linking signals to job executions
  • Conditions: Rules that determine if a signal should trigger a job`,
    commonTasks: [
      "List configured signals: atlas signal list",
      "Trigger a signal: atlas signal trigger manual",
      'Trigger with data: atlas signal trigger webhook --data \'{"key":"value"}\'',
      "View signal history: atlas signal history --since 1h",
      "Test signal mapping: atlas signal trigger test --dry-run",
    ],
    troubleshooting: [
      "Signal not found: Check signal name in workspace.yml",
      "Signal not triggering jobs: Verify signal-job mappings and conditions",
      "Invalid payload: Ensure JSON data is properly formatted",
    ],
    seeAlso: ["session", "workspace", "agent"],
  },

  agent: {
    overview: `
Agents are the execution units in Atlas that perform tasks. They can be AI-powered 
(using LLMs), deterministic (Tempest agents), or remote HTTP services. Agents are 
stateless and receive context from supervisors.`,
    concepts: `
Key Concepts:
  • Agent Types: llm (AI-powered), tempest (built-in), remote (HTTP)
  • Stateless Design: Agents don't maintain memory between invocations
  • Supervisor Coordination: Agents are orchestrated by session supervisors
  • Tool Access: Agents can use tools/actions defined in configuration`,
    commonTasks: [
      "List workspace agents: atlas agent list",
      "View agent config: atlas agent describe llm-agent",
      "Test an agent: atlas agent test my-agent",
      "Export agent list: atlas agent list --json",
      "Check agent health: atlas agent test --health-check",
    ],
    troubleshooting: [
      "Agent not found: Verify agent name in workspace.yml",
      "LLM agent failing: Check ANTHROPIC_API_KEY in .env file",
      "Remote agent timeout: Verify remote endpoint is accessible",
    ],
    seeAlso: ["workspace", "session", "library"],
  },

  library: {
    overview: `
The library system stores reusable content, templates, and generated artifacts. It 
provides versioned storage for prompts, configurations, and any content generated 
by agents during execution.`,
    concepts: `
Key Concepts:
  • Library Items: Stored content with metadata, tags, and versioning
  • Templates: Reusable patterns for generating content
  • Content Types: prompts, configs, documents, code, etc.
  • Workspace vs Platform: Items can be workspace-specific or platform-wide`,
    commonTasks: [
      "List library items: atlas library list",
      "Search content: atlas library search 'agent config'",
      "Get item with content: atlas library get item_123 --content",
      "List templates: atlas library templates",
      "Generate from template: atlas library generate my-template data.json",
      "View statistics: atlas library stats",
    ],
    troubleshooting: [
      "Item not found: Use partial ID match or search functionality",
      "Template generation failed: Verify data file format matches template requirements",
      "Storage limit reached: Check atlas library stats and clean up old items",
    ],
    seeAlso: ["workspace", "agent"],
  },

  logs: {
    overview: `
The logging system provides detailed insights into workspace, session, and agent 
execution. Logs are structured, searchable, and organized by workspace and session.`,
    concepts: `
Key Concepts:
  • Hierarchical Logging: Workspace → Session → Agent logs
  • Structured Format: JSON logs with context and timestamps
  • Real-time Streaming: Follow logs as they're generated
  • Log Levels: debug, info, warn, error`,
    commonTasks: [
      "View session logs: atlas logs sess_abc123",
      "Follow logs in real-time: atlas logs sess_abc123 --follow",
      "Show last N lines: atlas logs sess_abc123 --tail 50",
      "Filter by level: atlas logs sess_abc123 --level error",
      "View workspace logs: atlas logs --workspace my-agent",
    ],
    troubleshooting: [
      "No logs found: Ensure session ID is correct and session has started",
      "Logs not updating: Check if workspace server is still running",
      "Too many logs: Use --level or --tail to filter output",
    ],
    seeAlso: ["session", "workspace"],
  },
};

/**
 * Get detailed help for a resource/command group
 */
export function getResourceHelp(resource: string): ResourceHelp | undefined {
  return resourceHelp[resource];
}

/**
 * Format resource help as a string for display
 */
export function formatResourceHelp(resource: string): string {
  const help = getResourceHelp(resource);
  if (!help) return "";

  const sections: string[] = [];

  sections.push(help.overview.trim());

  if (help.concepts) {
    sections.push("\n" + help.concepts.trim());
  }

  if (help.commonTasks && help.commonTasks.length > 0) {
    sections.push("\nCommon Tasks:");
    help.commonTasks.forEach((task) => {
      sections.push(`  • ${task}`);
    });
  }

  if (help.troubleshooting && help.troubleshooting.length > 0) {
    sections.push("\nTroubleshooting:");
    help.troubleshooting.forEach((tip) => {
      sections.push(`  • ${tip}`);
    });
  }

  if (help.seeAlso && help.seeAlso.length > 0) {
    sections.push(`\nSee Also: ${help.seeAlso.map((cmd) => `'atlas ${cmd}'`).join(", ")}`);
  }

  return sections.join("\n");
}
