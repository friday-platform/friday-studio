import React from "react";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { Box, render, Text } from "ink";
import {
  WorkspaceEntry,
  WorkspaceStatus as WSStatus,
} from "../../../core/workspace-registry-types.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceHealthData } from "../../types/health.ts";

interface StatusArgs {
  json?: boolean;
  workspace?: string;
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

export const command = "status [workspace]";
export const desc = "Show workspace status and configuration";

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  json: {
    type: "boolean" as const,
    describe: "Output status information as JSON",
    default: false,
  },
};

export const handler = async (argv: StatusArgs): Promise<void> => {
  try {
    const registry = getWorkspaceRegistry();
    await registry.initialize();

    let workspace: WorkspaceEntry | null = null;
    let workspacePath: string;

    if (argv.workspace) {
      // Find by ID or name
      workspace = (await registry.findById(argv.workspace)) ||
        (await registry.findByName(argv.workspace));

      if (!workspace) {
        console.error(
          `Error: Workspace '${argv.workspace}' not found. Use 'atlas workspace list' to see available workspaces.`,
        );
        Deno.exit(1);
      }

      workspacePath = workspace!.path;
    } else {
      // Use current directory
      workspace = await registry.getCurrentWorkspace();
      workspacePath = Deno.cwd();

      if (!workspace) {
        // Check if there's a workspace.yml in current directory
        if (await exists("workspace.yml")) {
          console.error(
            "Error: Workspace exists but is not registered. Run 'atlas workspace init' to register it.",
          );
        } else {
          console.error(
            "Error: No workspace found in current directory. Run 'atlas workspace init <name>' to create one.",
          );
        }
        Deno.exit(1);
      }
    }

    // Load workspace configuration
    const originalCwd = Deno.cwd();
    try {
      Deno.chdir(workspacePath);

      // Read workspace.yml
      const configContent = await Deno.readTextFile("workspace.yml");
      const config = yaml.parse(configContent) as WorkspaceConfig;

      // Check if server is running and get health info
      let serverRunning = false;
      let healthData: WorkspaceHealthData | null = null;
      const port = config.runtime?.server?.port || 8080;

      if (workspace!.status === WSStatus.RUNNING && workspace!.port) {
        try {
          const response = await fetch(
            `http://localhost:${workspace!.port}/api/health`,
          );
          if (response.ok) {
            serverRunning = true;
            healthData = await response.json();
          }
        } catch {
          serverRunning = false;
        }
      }

      const statusData = {
        workspace: workspace!, // workspace is guaranteed to be non-null here
        config,
        serverRunning,
        port,
        healthData,
      };

      if (argv.json) {
        // JSON output
        const agentCount = Object.keys(config.agents || {}).length;
        const signalCount = Object.keys(config.signals || {}).length;
        const jobCount = Object.keys(config.jobs || {}).length;

        console.log(
          JSON.stringify(
            {
              id: workspace!.id,
              name: workspace!.name,
              workspaceId: config.workspace?.id,
              description: workspace!.metadata?.description ||
                config.workspace?.description,
              path: workspace!.path,
              configPath: workspace!.configPath,
              status: workspace!.status,
              serverRunning,
              port: workspace!.port || port,
              pid: workspace!.pid,
              detached: healthData?.detached || false,
              sessions: healthData?.sessions || 0,
              uptime: healthData?.uptime,
              memory: healthData?.memory,
              agents: agentCount,
              signals: signalCount,
              jobs: jobCount,
              atlasVersion: workspace!.metadata?.atlasVersion,
              createdAt: workspace!.createdAt,
              lastSeen: workspace!.lastSeen,
              startedAt: workspace!.startedAt,
              stoppedAt: workspace!.stoppedAt,
            },
            null,
            2,
          ),
        );
      } else {
        // Render with Ink
        render(<WorkspaceStatusCommand data={statusData} />);
        // Exit immediately after rendering
        Deno.exit(0);
      }
    } finally {
      Deno.chdir(originalCwd);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};

// Component that displays workspace status
function WorkspaceStatusCommand({
  data,
}: {
  data: {
    workspace: WorkspaceEntry;
    config: WorkspaceConfig;
    serverRunning: boolean;
    port: number;
    healthData: WorkspaceHealthData | null;
  };
}) {
  const { workspace, config, serverRunning, port, healthData } = data;

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Workspace Status</Text>
      </Box>

      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold>Name:</Text>
          <Text>{workspace.name}</Text>
        </Box>

        <Box>
          <Text bold>ID:</Text>
          <Text dimColor>{workspace.id}</Text>
        </Box>

        <Box>
          <Text bold>Path:</Text>
          <Text>{workspace.path}</Text>
        </Box>

        <Box>
          <Text bold>Status:</Text>
          <Text color={workspace.status === WSStatus.RUNNING ? "green" : "yellow"}>
            {workspace.status}
          </Text>
        </Box>

        {serverRunning && (
          <Box>
            <Text bold>Server:</Text>
            <Text color="green">Running on port {port}</Text>
          </Box>
        )}

        {healthData && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Health:</Text>
            <Box paddingLeft={2}>
              <Text>Status: {healthData.status}</Text>
            </Box>
            {healthData.sessions && (
              <Box paddingLeft={2}>
                <Text>Active Sessions: {healthData.sessions}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
