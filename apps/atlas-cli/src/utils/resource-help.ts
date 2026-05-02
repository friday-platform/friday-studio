/**
 * Resource-specific help documentation for Atlas CLI commands
 */

interface ResourceHelp {
  overview: string;
  concepts?: string;
  commonTasks?: string[];
  troubleshooting?: string[];
  seeAlso?: string[];
}

const resourceHelp: Record<string, ResourceHelp> = {
  daemon: {
    overview: `
The Atlas daemon is the core service that manages all workspaces and agent
executions. It runs as a single process that serves multiple workspaces
on-demand, creating runtimes only when signals arrive.`,
    concepts: `
Key Concepts:
  • Single Process Model: One daemon manages all registered workspaces
  • On-Demand Runtimes: Workspaces activate only when signals arrive
  • Workspace Registry: Workspaces must be registered with the daemon
  • Resource Management: Configurable limits for concurrent workspaces`,
    commonTasks: [
      "Start the daemon: atlas daemon start",
      "Start in background: atlas daemon start --detached",
      "Check daemon status: atlas daemon status",
      "Stop the daemon: atlas daemon stop",
      "Restart daemon: atlas daemon restart",
    ],
    troubleshooting: [
      "Port already in use: Use --port flag to specify a different port",
      "Daemon not responding: Check if it's running with 'atlas daemon status'",
      "Cannot stop daemon: Use --force flag to forcefully terminate",
    ],
    seeAlso: ["workspace", "session", "ps"],
  },

  workspace: {
    overview: `
Workspaces contain AI agents, signals, and job configurations. They are
registered with the Atlas daemon and activate on-demand when signals arrive.`,
    concepts: `
Key Concepts:
  • Template-Based Init: Create workspaces from pre-built templates
  • Daemon Registration: Workspaces must be registered with the daemon
  • On-Demand Activation: Runtimes created only when signals trigger
  • Configuration-Based: Defined by workspace.yml and jobs/*.yml files`,
    commonTasks: [
      "Initialize from template: atlas workspace init",
      "Initialize at path: atlas workspace init ~/my-workspace",
      "Add workspace to daemon: atlas workspace add /path/to/workspace",
      "List registered workspaces: atlas workspace list",
      "Check workspace status: atlas workspace status my-agent",
      "Remove from daemon: atlas workspace remove my-agent",
      "View workspace logs: atlas workspace logs my-agent",
    ],
    troubleshooting: [
      "Daemon not running: Start with 'atlas daemon start'",
      "Workspace not registered: Use 'atlas workspace add' to register",
      "Cannot find workspace: Ensure registered with 'atlas workspace list'",
      "ANTHROPIC_API_KEY missing: Add your API key to the .env file",
      "Init requires terminal: Run directly in terminal, not through pipes",
    ],
    seeAlso: ["daemon", "session", "signal", "agent"],
  },

  session: {
    overview: `
Sessions represent unique executions of jobs triggered by signals. When a signal
arrives and matches a job configuration, Atlas creates a new session to execute
that job through its supervised agent pipeline.`,
    concepts: `
Key Concepts:
  • Job Execution: Each session is one run of a job (signal → job → session)
  • Unique Identity: Every session has a unique ID (e.g., sess_abc123)
  • Supervised Pipeline: Jobs execute through WorkspaceSupervisor → SessionSupervisor → Agents
  • Execution Planning: LLM-powered analysis determines which agents to invoke
  • Session Lifecycle: created → planning → executing → completed/failed`,
    commonTasks: [
      "List active sessions: atlas session list or atlas ps",
      "View session details: atlas session get sess_abc123",
      "Cancel a running session: atlas session cancel sess_xyz789",
      "Filter by workspace: atlas session list --workspace my-agent",
      "Export as JSON: atlas session list --json",
    ],
    troubleshooting: [
      "Session stuck: Check logs with 'atlas workspace logs sess_abc123'",
      "Can't cancel session: Session may have already completed or failed",
    ],
    seeAlso: ["workspace", "signal", "logs", "ps"],
  },

  signal: {
    overview: `
Signals are events that trigger job execution in your workspace. They can come
from various sources like HTTP webhooks, CLI commands, scheduled timers, or
external systems.`,
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
Agents are execution units managed by Atlas supervisors. They can be Tempest
(built-in), LLM (AI-powered), or Remote (MCP/HTTP services). All agents execute
through a supervision pipeline that ensures safety and coordination.`,
    concepts: `
Key Concepts:
  • Supervised Execution: Agents never run directly, always through supervisors
  • Agent Types: tempest (first-party), llm (custom AI), remote (external)
  • MCP Integration: Agents can use MCP servers as tool providers
  • Stateless Design: Context provided by supervisors for each invocation
  • Safety Analysis: LLM-powered assessment before execution`,
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
      "MCP connection failed: Check MCP server configuration",
    ],
    seeAlso: ["workspace", "session", "mcp"],
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
      "View workspace logs: atlas workspace logs my-agent",
      "Follow logs in real-time: atlas workspace logs --follow",
      "Show last N lines: atlas workspace logs --tail 50",
      "Filter by level: atlas workspace logs --level error",
      "Filter by time: atlas workspace logs --since 1h",
    ],
    troubleshooting: [
      "No logs found: Ensure workspace is registered and has activity",
      "Logs not updating: Check if daemon is still running",
      "Too many logs: Use --level, --tail, or --since to filter output",
    ],
    seeAlso: ["session", "workspace", "daemon"],
  },

  mcp: {
    overview: `
The Model Context Protocol (MCP) integration allows Atlas to serve as an MCP
server, enabling other AI tools to interact with Atlas workspaces through a
standardized protocol.`,
    concepts: `
Key Concepts:
  • MCP Server: Atlas exposes workspace capabilities via MCP
  • Tool Integration: Seamless integration with MCP-compatible tools
  • Resource Access: Expose workspace resources through MCP
  • Protocol Bridge: Connect Atlas agents to external MCP servers`,
    commonTasks: [
      "Start MCP server: atlas mcp serve",
      "Use with Claude Desktop: Configure in Claude app settings",
      "List available tools: Exposed automatically via MCP protocol",
    ],
    troubleshooting: [
      "Connection failed: Ensure Atlas daemon is running",
      "Tools not showing: Check workspace configuration",
      "Permission denied: Verify MCP client has proper access",
    ],
    seeAlso: ["agent", "workspace", "daemon"],
  },

  ps: {
    overview: `
Quick command to list all active sessions across all workspaces. This is an
alias for 'atlas session list' providing a familiar interface for process
monitoring.`,
    commonTasks: [
      "List all sessions: atlas ps",
      "Filter by workspace: atlas ps --workspace my-agent",
      "Show as JSON: atlas ps --json",
    ],
    seeAlso: ["session", "workspace"],
  },
};

/**
 * Get detailed help for a resource/command group
 */
function getResourceHelp(resource: string): ResourceHelp | undefined {
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
    sections.push(`\n${help.concepts.trim()}`);
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
