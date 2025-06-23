import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { exists } from "@std/fs";
import { Column, Table } from "../components/Table.tsx";
import { getWorkspaceRegistry } from "../../core/workspace-registry.ts";
import {
  ConfigLoader,
  type NewWorkspaceConfig,
  type WorkspaceAgentConfig,
} from "../../core/config-loader.ts";

interface CommandFlags {
  workspace?: string;
  w?: string;
  message?: string;
  m?: string;
  [key: string]: unknown;
}

export interface AgentCommandProps {
  subcommand?: string;
  args: string[];
  flags: CommandFlags;
}

// Helper function to resolve workspace from ID or current directory
async function resolveWorkspace(workspaceId?: string): Promise<{
  path: string;
  id: string;
  name: string;
}> {
  const registry = getWorkspaceRegistry();

  if (workspaceId) {
    // Find by ID or name in registry
    const workspace = await registry.findById(workspaceId) ||
      await registry.findByName(workspaceId);

    if (!workspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found. ` +
          `Run 'atlas workspace list' to see available workspaces.`,
      );
    }

    return {
      path: workspace.path,
      id: workspace.id,
      name: workspace.name,
    };
  } else {
    // Try current directory
    const currentWorkspace = await registry.getCurrentWorkspace();

    if (currentWorkspace) {
      return {
        path: currentWorkspace.path,
        id: currentWorkspace.id,
        name: currentWorkspace.name,
      };
    }

    // Fallback to checking for workspace.yml in current directory
    if (await exists("workspace.yml")) {
      // Register this workspace if not already registered
      const workspace = await registry.findOrRegister(Deno.cwd());
      return {
        path: workspace.path,
        id: workspace.id,
        name: workspace.name,
      };
    }

    throw new Error(
      "No workspace specified and not in a workspace directory. " +
        "Use --workspace flag or run from a workspace directory.",
    );
  }
}

// Helper function to load workspace configuration
async function loadWorkspaceConfig(workspacePath: string): Promise<NewWorkspaceConfig> {
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    return mergedConfig.workspace;
  } finally {
    Deno.chdir(originalCwd);
  }
}

interface OutputData {
  type: "list" | "detail" | "test";
  agents?: Array<{
    name: string;
    type: string;
    model: string;
    status: string;
    purpose: string;
  }>;
  workspaceName?: string;
  workspaceId?: string;
  agent?: WorkspaceAgentConfig & {
    name: string;
    workspace?: string;
    workspaceId?: string;
  };
  agentName?: string;
  message?: string;
  result?: string;
}

export function AgentCommand({ subcommand, args, flags }: AgentCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<OutputData | null>(null);

  const workspaceId = flags.workspace || flags.w;

  useEffect(() => {
    const execute = async () => {
      try {
        switch (subcommand) {
          case "list":
            await handleList(workspaceId);
            break;
          case "describe":
            await handleDescribe(args[0], workspaceId);
            break;
          case "test":
            await handleTest(args[0], flags, workspaceId);
            break;
          default:
            setError(
              `Unknown agent command: ${subcommand}. Available: list, describe, test`,
            );
            setStatus("error");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleList(workspaceId?: string) {
    const workspace = await resolveWorkspace(workspaceId);
    const config = await loadWorkspaceConfig(workspace.path);

    const agents = Object.entries(config.agents || {}).map(
      ([id, agent]) => ({
        name: id,
        type: agent.type || "local",
        model: agent.model || "claude-3-5-sonnet-20241022",
        status: "ready",
        purpose: agent.purpose || "No description",
      }),
    );

    setData({
      type: "list",
      agents,
      workspaceName: workspace.name,
      workspaceId: workspace.id,
    });
    setStatus("ready");
  }

  async function handleDescribe(agentName: string | undefined, workspaceId?: string) {
    if (!agentName) {
      throw new Error(
        "Agent name required. Usage: atlas agent describe <name> [--workspace=<id>]",
      );
    }

    const workspace = await resolveWorkspace(workspaceId);
    const config = await loadWorkspaceConfig(workspace.path);

    const agentConfig = config.agents?.[agentName];

    if (!agentConfig) {
      throw new Error(
        `Agent '${agentName}' not found in workspace '${workspace.name}' (${workspace.id})`,
      );
    }

    setData({
      type: "detail",
      agent: {
        name: agentName,
        workspace: workspace.name,
        workspaceId: workspace.id,
        ...agentConfig,
        model: agentConfig.model || "claude-3-5-sonnet-20241022",
      },
    });
    setStatus("ready");
  }

  async function handleTest(
    agentName: string | undefined,
    flags: CommandFlags,
    workspaceId?: string,
  ) {
    if (!agentName) {
      throw new Error(
        'Agent name required. Usage: atlas agent test <name> --message "..." [--workspace=<id>]',
      );
    }

    const message = flags.message || flags.m;
    if (!message) {
      throw new Error(
        'Message required. Usage: atlas agent test <name> --message "..." [--workspace=<id>]',
      );
    }

    const workspace = await resolveWorkspace(workspaceId);
    const config = await loadWorkspaceConfig(workspace.path);

    const agentConfig = config.agents?.[agentName];
    if (!agentConfig) {
      throw new Error(
        `Agent '${agentName}' not found in workspace '${workspace.name}' (${workspace.id})`,
      );
    }

    // TODO: Implement direct agent testing
    setData({
      type: "test",
      agentName: agentName,
      workspaceName: workspace.name,
      workspaceId: workspace.id,
      message,
      result: "Agent testing not yet implemented. Use signal trigger to test agents in a workflow.",
    });
    setStatus("ready");
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  return <AgentOutput data={data} />;
}

function AgentOutput({ data }: { data: OutputData | null }) {
  if (!data) return null;

  switch (data.type) {
    case "list":
      return (
        <Box flexDirection="column">
          {data.workspaceName && (
            <>
              <Text bold color="cyan">
                Agents in workspace: {data.workspaceName}
              </Text>
              <Text color="gray">
                ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              </Text>
            </>
          )}
          {data.agents.length === 0 ? <Text color="gray">No agents configured</Text> : (
            (() => {
              const columns: Column[] = [
                { key: "name", label: "AGENT", width: 25 },
                { key: "type", label: "TYPE", width: 10 },
                { key: "model", label: "MODEL", width: 30 },
                { key: "status", label: "STATUS", width: 10 },
                { key: "purpose", label: "PURPOSE", width: 45 },
              ];
              return <Table columns={columns} data={data.agents} />;
            })()
          )}
        </Box>
      );

    case "detail": {
      const agent = data.agent;
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">
            Agent Details
          </Text>
          <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          <Text>
            Name: <Text color="white">{agent.name}</Text>
          </Text>
          <Text>
            Type: <Text color="white">{agent.type}</Text>
          </Text>
          <Text>
            Model: <Text color="white">{agent.model}</Text>
          </Text>
          {agent.purpose && (
            <Text>
              Purpose: <Text color="white">{agent.purpose}</Text>
            </Text>
          )}
          <Text></Text>
          {agent.prompts && (
            <>
              <Text>Prompts:</Text>
              {Object.entries(agent.prompts).map(
                ([key, value]) => (
                  <React.Fragment key={key}>
                    <Text>
                      {key}:{" "}
                      <Text color="gray">
                        {String(value).substring(0, 50)}...
                      </Text>
                    </Text>
                  </React.Fragment>
                ),
              )}
            </>
          )}
        </Box>
      );
    }

    case "test":
      return (
        <Box flexDirection="column">
          <Text color="yellow">{data.result}</Text>
        </Box>
      );

    default:
      return <Text>Unknown output type: {data.type}</Text>;
  }
}
