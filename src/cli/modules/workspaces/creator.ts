import { type MCPDiscoveryRequest, MCPRegistry } from "@atlas/core";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import * as yaml from "@std/yaml";
import { generateUniqueWorkspaceName } from "../../../core/utils/id-generator.ts";
import { checkDaemonRunning, getDaemonClient } from "../../utils/daemon-client.ts";

interface WorkspaceCreationOptions {
  name: string;
  path: string;
  description?: string;
  agents?: string[];
  signals?: string[];
}

export async function createAndRegisterWorkspace(
  options: WorkspaceCreationOptions,
): Promise<{ id: string; name: string; path: string }> {
  const { name, path, description, agents = [], signals = [] } = options;

  // Ensure directory exists
  await ensureDir(path);

  // Build workspace config object (without ID - daemon will generate one)
  const workspaceConfig = {
    version: "1.0",
    workspace: { name: name, description: description || `Atlas workspace: ${name}` },
    signals: {},
    jobs: {},
    agents: {},
    tools: {},
  };

  // Add configured signals
  if (signals.length > 0) {
    for (const signal of signals) {
      if (signal === "cli") {
        workspaceConfig.signals["manual-trigger"] = {
          provider: "cli",
          description: "Manual signal trigger from CLI",
        };
      } else if (signal === "http") {
        workspaceConfig.signals["webhook"] = {
          provider: "http",
          description: "HTTP webhook trigger",
          config: { port: 8080, path: "/webhook" },
        };
      } else if (signal === "schedule") {
        workspaceConfig.signals["scheduled"] = {
          provider: "schedule",
          description: "Scheduled trigger",
          config: { cron: "0 0 * * *" },
        };
      } else if (signal === "fs-watch") {
        // Default to watching the 'content/' directory to avoid triggering on all workspace changes
        workspaceConfig.signals["file-watch"] = {
          provider: "fs-watch",
          description: "Filesystem watcher trigger",
          config: { path: "content/", recursive: true },
        };
      }
    }
  }

  // Add configured agents
  if (agents.length > 0) {
    for (const agent of agents) {
      if (agent === "llm") {
        workspaceConfig.agents["llm-agent"] = {
          type: "llm",
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          purpose: "AI-powered agent for complex reasoning tasks",
        };
      } else if (agent === "tempest") {
        workspaceConfig.agents["tempest-agent"] = {
          type: "tempest",
          purpose: "Built-in agent for system operations",
        };
      } else if (agent === "remote") {
        workspaceConfig.agents["remote-agent"] = {
          type: "remote",
          protocol: "mcp",
          endpoint: "http://localhost:3000/mcp",
          purpose: "Remote agent via HTTP API",
        };
      }
    }
  }

  // Auto-discover MCP servers based on basic requirements
  const mcpServers = await discoverMCPServersForBasicWorkspace(name, description);
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    workspaceConfig.tools = { mcp: { servers: mcpServers } };
  }

  // Add sample job based on selected agents
  if (agents.length > 0) {
    workspaceConfig.jobs["example-job"] = {
      description: "Example job for workspace initialization",
      agents: agents.map((agent) => `${agent}-agent`),
      mappings: [
        { signal: Object.keys(workspaceConfig.signals)[0] || "manual-trigger", conditions: [] },
      ],
    };
  }

  // Write workspace.yml
  const yamlContent = yaml.stringify(workspaceConfig);
  const workspacePath = join(path, "workspace.yml");
  await Deno.writeTextFile(workspacePath, yamlContent);

  // Create additional files based on configuration
  // Create .env file if LLM agent selected
  if (agents.includes("llm")) {
    const envContent = "# Add your Anthropic API key here\nANTHROPIC_API_KEY=\n";
    await Deno.writeTextFile(join(path, ".env"), envContent);
  }

  // Create jobs directory
  await ensureDir(join(path, "jobs"));

  // If fs-watch was selected, ensure the default watched directory exists
  if (signals.includes("fs-watch")) {
    await ensureDir(join(path, "content"));
  }

  // Register workspace with daemon if it's running, otherwise create locally
  let workspaceId: string;
  let workspaceName: string;

  if (await checkDaemonRunning()) {
    try {
      const client = getDaemonClient();
      const registeredWorkspace = await client.createWorkspace({
        name: name,
        description: description || `Atlas workspace: ${name}`,
        config: workspaceConfig,
      });
      workspaceId = registeredWorkspace.id;
      workspaceName = registeredWorkspace.name;
    } catch (error) {
      // Fallback to local creation if daemon registration fails
      workspaceId = generateUniqueWorkspaceName(new Set());
      workspaceName = name;
    }
  } else {
    // Create workspace locally (daemon not running)
    workspaceId = generateUniqueWorkspaceName(new Set());
    workspaceName = name;
  }

  return { id: workspaceId, name: workspaceName, path: path };
}

/**
 * Auto-discover MCP servers for basic workspace creation
 * This ensures MCP registry is used in CLI workspace creation
 */
async function discoverMCPServersForBasicWorkspace(
  name: string,
  description?: string,
): Promise<Record<string, unknown> | null> {
  try {
    const registry = await MCPRegistry.getInstance();
    const requirements = extractRequirementsFromNameAndDescription(name, description);

    if (requirements.length === 0) {
      return null;
    }

    const mcpServers: Record<string, unknown> = {};
    let discoveredCount = 0;

    for (const requirement of requirements) {
      const request: MCPDiscoveryRequest = { intent: requirement, capabilities: [requirement] };

      const discovery = await registry.discoverBestMCPServer(request);

      if (discovery && discovery.confidence >= 0.6) {
        const serverId = discovery.server.id;
        if (!mcpServers[serverId]) {
          mcpServers[serverId] = discovery.server.configTemplate;
          discoveredCount++;
        }
      }
    }

    if (discoveredCount > 0) {
      console.log(`Auto-discovered ${discoveredCount} MCP servers for workspace requirements`);
    }

    return Object.keys(mcpServers).length > 0 ? mcpServers : null;
  } catch (error) {
    console.warn("MCP discovery failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Extract likely requirements from workspace name and description
 */
function extractRequirementsFromNameAndDescription(name: string, description?: string): string[] {
  const requirements: string[] = [];
  const fullText = `${name} ${description || ""}`.toLowerCase();

  // Common patterns
  const patterns = [
    { keywords: ["github", "git", "repo"], requirement: "GitHub repository management" },
    { keywords: ["discord", "chat", "notification"], requirement: "Discord notifications" },
    { keywords: ["email", "mail", "smtp"], requirement: "Email notifications" },
    { keywords: ["stripe", "payment", "billing"], requirement: "Stripe payment processing" },
    { keywords: ["slack", "message"], requirement: "Slack messaging" },
    { keywords: ["database", "sql", "postgres", "mysql"], requirement: "Database operations" },
    { keywords: ["api", "rest", "http"], requirement: "HTTP API access" },
    { keywords: ["file", "upload", "storage"], requirement: "File operations" },
    { keywords: ["monitor", "health", "check"], requirement: "System monitoring" },
    { keywords: ["report", "analytics", "metrics"], requirement: "Analytics and reporting" },
  ];

  for (const pattern of patterns) {
    if (pattern.keywords.some((keyword) => fullText.includes(keyword))) {
      requirements.push(pattern.requirement);
    }
  }

  return requirements;
}
