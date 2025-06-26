import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import * as yaml from "@std/yaml";
import { checkDaemonRunning, getDaemonClient } from "../../utils/daemon-client.ts";
import { generateUniqueWorkspaceName } from "../../../core/utils/id-generator.ts";

interface WorkspaceCreationOptions {
  name: string;
  path: string;
  description?: string;
  agents?: string[];
  signals?: string[];
}

export async function createAndRegisterWorkspace(options: WorkspaceCreationOptions): Promise<{
  id: string;
  name: string;
  path: string;
}> {
  const { name, path, description, agents = [], signals = [] } = options;

  // Ensure directory exists
  await ensureDir(path);

  // Build workspace config object (without ID - daemon will generate one)
  const workspaceConfig = {
    version: "1.0",
    workspace: {
      name: name,
      description: description || `Atlas workspace: ${name}`,
    },
    signals: {} as Record<string, unknown>,
    jobs: {} as Record<string, unknown>,
    agents: {} as Record<string, unknown>,
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
          config: {
            port: 8080,
            path: "/webhook",
          },
        };
      } else if (signal === "schedule") {
        workspaceConfig.signals["scheduled"] = {
          provider: "schedule",
          description: "Scheduled trigger",
          config: {
            cron: "0 0 * * *",
          },
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
          model: "claude-3-5-sonnet-20241022",
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

  // Add sample job based on selected agents
  if (agents.length > 0) {
    workspaceConfig.jobs["example-job"] = {
      description: "Example job for workspace initialization",
      agents: agents.map((agent) => `${agent}-agent`),
      mappings: [
        {
          signal: Object.keys(workspaceConfig.signals)[0] || "manual-trigger",
          conditions: [],
        },
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
      console.warn("Failed to register with daemon, creating workspace locally");
      workspaceId = generateUniqueWorkspaceName();
      workspaceName = name;
    }
  } else {
    // Create workspace locally (daemon not running)
    workspaceId = generateUniqueWorkspaceName();
    workspaceName = name;
    console.info(
      "Daemon not running - workspace created locally. Use 'atlas daemon start' to register it.",
    );
  }

  return {
    id: workspaceId,
    name: workspaceName,
    path: path,
  };
}
