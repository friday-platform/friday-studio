import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { Column, Table } from "../components/Table.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { scanAvailableWorkspaces } from "./workspace.tsx";
import { ConfigLoader } from "../../core/config-loader.ts";

export interface AgentCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function AgentCommand({ subcommand, args, flags }: AgentCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const execute = async () => {
      try {
        switch (subcommand) {
          case "list":
            await handleList(args[0]);
            break;
          case "describe":
            await handleDescribe(args[0]);
            break;
          case "test":
            await handleTest(args[0], flags);
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
    let workspacePath = Deno.cwd();

    if (workspaceId) {
      // Find workspace by ID
      const availableWorkspaces = await scanAvailableWorkspaces();
      const targetWorkspace = availableWorkspaces.find(
        (w) => w.id === workspaceId || w.slug === workspaceId,
      );

      if (!targetWorkspace) {
        throw new Error(
          `Workspace '${workspaceId}' not found. Use 'atlas workspace list' to see available workspaces.`,
        );
      }

      workspacePath = targetWorkspace.path;
    } else {
      // Check current directory for workspace.yml
      if (!(await exists("workspace.yml"))) {
        throw new Error(
          "Provide a workspace id or run this command inside of a workspace",
        );
      }
    }

    // Load configuration from the determined workspace path
    const originalCwd = Deno.cwd();
    try {
      Deno.chdir(workspacePath);

      const configLoader = new ConfigLoader();
      const mergedConfig = await configLoader.load();
      const config = mergedConfig.workspace;

      const agents = Object.entries(config.agents || {}).map(
        ([id, agent]: [string, any]) => ({
          name: id,
          type: agent.type || "local",
          model: agent.model ||
            "claude-4-sonnet-20250514",
          status: "ready",
          purpose: agent.purpose || "No description",
        }),
      );

      setData({
        type: "list",
        agents,
        workspaceName: config.workspace?.name,
        workspaceId: workspaceId || "current",
      });
      setStatus("ready");
    } finally {
      Deno.chdir(originalCwd);
    }
  }

  async function handleDescribe(agentName: string | undefined) {
    if (!agentName) {
      throw new Error(
        "Agent name required. Usage: atlas agent describe <name>",
      );
    }

    if (!(await exists("workspace.yml"))) {
      throw new Error(
        'No workspace.yml found. Run "atlas workspace init" first.',
      );
    }

    const config = yaml.parse(await Deno.readTextFile("workspace.yml")) as any;
    const agentConfig = config.agents?.[agentName];

    if (!agentConfig) {
      throw new Error(
        `Agent '${agentName}' not found in workspace configuration`,
      );
    }

    setData({
      type: "detail",
      agent: {
        name: agentName,
        ...agentConfig,
        model: agentConfig.model ||
          config.supervisor?.model ||
          "claude-4-sonnet-20250514",
      },
    });
    setStatus("ready");
  }

  async function handleTest(agentName: string | undefined, flags: any) {
    if (!agentName) {
      throw new Error(
        'Agent name required. Usage: atlas agent test <name> --message "..."',
      );
    }

    const message = flags.message || flags.m;
    if (!message) {
      throw new Error(
        'Message required. Usage: atlas agent test <name> --message "..."',
      );
    }

    // TODO: Implement direct agent testing
    setData({
      type: "test",
      agent: agentName,
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

function AgentOutput({ data }: { data: any }) {
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

    case "detail":
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
          {agent.path && (
            <Text>
              Path: <Text color="gray">{agent.path}</Text>
            </Text>
          )}
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
                ([key, value]: [string, any]) => (
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
