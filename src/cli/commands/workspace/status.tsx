import { Box, Newline, Text } from "ink";
import { useEffect, useState } from "react";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import {
  WorkspaceEntry,
  WorkspaceStatus as WSStatus,
} from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceCommandProps } from "./utils.ts";

export function WorkspaceStatusCommand({ args }: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>("");
  interface WorkspaceConfig {
    workspace?: {
      id?: string;
      name?: string;
      description?: string;
    };
    runtime?: {
      server?: {
        port?: number;
      };
    };
    agents?: Record<string, unknown>;
    signals?: Record<string, unknown>;
    jobs?: Record<string, unknown>;
  }

  const [data, setData] = useState<
    {
      workspace: WorkspaceEntry | null;
      config: WorkspaceConfig;
      serverRunning: boolean;
      port: number;
    } | null
  >(null);

  useEffect(() => {
    const execute = async () => {
      try {
        const idOrName = args[0];
        await handleStatus(idOrName);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleStatus(idOrName?: string) {
    const registry = getWorkspaceRegistry();
    let workspace: WorkspaceEntry | null = null;
    let workspacePath: string;

    if (idOrName) {
      // Find by ID or name
      workspace = (await registry.findById(idOrName)) ||
        (await registry.findByName(idOrName));

      if (!workspace) {
        throw new Error(
          `Workspace '${idOrName}' not found. Use 'atlas workspace list' to see available workspaces.`,
        );
      }

      workspacePath = workspace.path;
    } else {
      // Use current directory
      workspace = await registry.getCurrentWorkspace();
      workspacePath = Deno.cwd();

      if (!workspace) {
        // Check if there's a workspace.yml in current directory
        if (await exists("workspace.yml")) {
          throw new Error(
            "Workspace exists but is not registered. Run 'atlas workspace init' to register it.",
          );
        } else {
          throw new Error(
            "No workspace found in current directory. Run 'atlas workspace init <name>' to create one.",
          );
        }
      }
    }

    // Load workspace configuration
    const originalCwd = Deno.cwd();
    try {
      Deno.chdir(workspacePath);

      // Read workspace.yml
      const configContent = await Deno.readTextFile("workspace.yml");
      const config = yaml.parse(configContent) as WorkspaceConfig;

      // Check if server is running
      let serverRunning = false;
      const port = config.runtime?.server?.port || 8080;

      if (workspace.status === WSStatus.RUNNING && workspace.port) {
        try {
          const response = await fetch(`http://localhost:${workspace.port}/health`);
          serverRunning = response.ok;
        } catch {
          serverRunning = false;
        }
      }

      setData({
        workspace,
        config,
        serverRunning,
        port,
      });
      setStatus("ready");
    } finally {
      Deno.chdir(originalCwd);
    }
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (!data) {
    return <Text>No data available</Text>;
  }

  return <WorkspaceStatusDisplay data={data} />;
}

interface WorkspaceConfig {
  workspace?: {
    id?: string;
    name?: string;
    description?: string;
  };
  runtime?: {
    server?: {
      port?: number;
    };
  };
  agents?: Record<string, unknown>;
  signals?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
}

// Shared component for rendering workspace status
export function WorkspaceStatusDisplay({
  data,
}: {
  data: {
    workspace: WorkspaceEntry;
    config: WorkspaceConfig;
    serverRunning: boolean;
    port: number;
  };
}) {
  const { workspace, config, serverRunning, port } = data;

  // Format status color
  const statusColor = workspace.status === WSStatus.RUNNING
    ? "green"
    : workspace.status === WSStatus.CRASHED
    ? "red"
    : workspace.status === WSStatus.STARTING
    ? "yellow"
    : workspace.status === WSStatus.STOPPING
    ? "yellow"
    : "gray";

  // Count agents and signals
  const agentCount = Object.keys(config.agents || {}).length;
  const signalCount = Object.keys(config.signals || {}).length;
  const jobCount = Object.keys(config.jobs || {}).length;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Workspace Status
      </Text>
      <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      <Newline />

      <Text bold>Identification</Text>
      <Text>
        Name: <Text color="white">{workspace.name}</Text>
      </Text>
      <Text>
        Registry ID: <Text color="blue">{workspace.id}</Text>
      </Text>
      <Text>
        Workspace ID: <Text color="gray">{config.workspace?.id || "N/A"}</Text>
      </Text>
      <Text>
        Description:{" "}
        <Text color="gray">
          {workspace.metadata?.description || config.workspace?.description || "No description"}
        </Text>
      </Text>
      <Newline />

      <Text bold>Location</Text>
      <Text>
        Path: <Text color="gray">{workspace.path}</Text>
      </Text>
      <Text>
        Config: <Text color="gray">{workspace.configPath}</Text>
      </Text>
      <Newline />

      <Text bold>Status</Text>
      <Text>
        Registry Status: <Text color={statusColor}>{workspace.status}</Text>
      </Text>
      <Text>
        Server: {serverRunning
          ? <Text color="green">Running on port {workspace.port || port}</Text>
          : <Text color="gray">Not running</Text>}
      </Text>
      {workspace.pid && (
        <Text>
          Process ID: <Text color="gray">{workspace.pid}</Text>
        </Text>
      )}
      <Newline />

      <Text bold>Configuration</Text>
      <Text>
        Agents: <Text color="white">{agentCount}</Text>
      </Text>
      <Text>
        Signals: <Text color="white">{signalCount}</Text>
      </Text>
      <Text>
        Jobs: <Text color="white">{jobCount}</Text>
      </Text>
      <Text>
        Atlas Version: <Text color="gray">{workspace.metadata?.atlasVersion || "Unknown"}</Text>
      </Text>
      <Newline />

      <Text bold>Timestamps</Text>
      <Text>
        Created: <Text color="gray">{new Date(workspace.createdAt).toLocaleString()}</Text>
      </Text>
      <Text>
        Last Seen: <Text color="gray">{new Date(workspace.lastSeen).toLocaleString()}</Text>
      </Text>
      {workspace.startedAt && (
        <Text>
          Started: <Text color="gray">{new Date(workspace.startedAt).toLocaleString()}</Text>
        </Text>
      )}
      {workspace.stoppedAt && (
        <Text>
          Stopped: <Text color="gray">{new Date(workspace.stoppedAt).toLocaleString()}</Text>
        </Text>
      )}
    </Box>
  );
}
