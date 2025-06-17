import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import * as yaml from "@std/yaml";
import { exists } from "@std/fs";

interface AvailableWorkspace {
  name: string;
  id: string;
  path: string;
  slug: string;
  description?: string;
}

export default function WorkspacesCommand() {
  const [workspaces, setWorkspaces] = useState<AvailableWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Function to scan for available workspaces
  const scanAvailableWorkspaces = async (): Promise<AvailableWorkspace[]> => {
    try {
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
      }).outputSync();

      if (!gitRoot.success) {
        throw new Error("Not in a git repository");
      }

      const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
      const workspacesPath = `${rootPath}/examples/workspaces`;

      // Check if workspaces directory exists
      if (!(await exists(workspacesPath))) {
        return [];
      }

      const workspaces: AvailableWorkspace[] = [];

      // Read workspaces directory
      for await (const dirEntry of Deno.readDir(workspacesPath)) {
        if (dirEntry.isDirectory) {
          const workspacePath = `${workspacesPath}/${dirEntry.name}`;
          const workspaceYmlPath = `${workspacePath}/workspace.yml`;

          if (await exists(workspaceYmlPath)) {
            try {
              const workspaceYaml = await Deno.readTextFile(workspaceYmlPath);
              const config = yaml.parse(workspaceYaml) as {
                workspace?: { id?: string; name?: string; description?: string };
              };

              if (config.workspace?.name) {
                workspaces.push({
                  name: config.workspace.name,
                  id: config.workspace.id || dirEntry.name, // Use directory name as fallback ID
                  path: workspacePath,
                  slug: dirEntry.name, // Folder name as slug
                  description: config.workspace.description,
                });
              }
            } catch (error) {
              // Skip workspaces with invalid YAML
              console.warn(
                `Failed to parse workspace.yml in ${dirEntry.name}:`,
                error,
              );
            }
          }
        }
      }

      return workspaces.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Failed to scan workspaces: ${error}`);
    }
  };

  useEffect(() => {
    const loadWorkspaces = async () => {
      try {
        setLoading(true);
        const availableWorkspaces = await scanAvailableWorkspaces();
        setWorkspaces(availableWorkspaces);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    loadWorkspaces();
  }, []);

  if (loading) {
    return (
      <Box>
        <Text color="cyan">Scanning for available workspaces...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (workspaces.length === 0) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow">No workspaces found</Text>
        </Box>
        <Box>
          <Text color="gray">
            No workspace.yml files found in examples/workspaces/ directory
          </Text>
        </Box>
      </Box>
    );
  }

  // Calculate column widths
  const idWidth = Math.max(2, ...workspaces.map((w: AvailableWorkspace) => w.id.length)) + 2;
  const nameWidth = Math.max(4, ...workspaces.map((w: AvailableWorkspace) => w.name.length)) + 2;
  const slugWidth = Math.max(4, ...workspaces.map((w: AvailableWorkspace) => w.slug.length)) + 2;
  const descWidth = 60; // Fixed width for description

  const padRight = (str: string, width: number) => {
    return str.length >= width
      ? str.substring(0, width - 1) + "…"
      : str + " ".repeat(width - str.length);
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Available Workspaces ({workspaces.length} found)
        </Text>
      </Box>
      <Box>
        <Text></Text>
      </Box>

      {/* Table Header */}
      <Box>
        <Text bold color="white">
          {padRight("ID", idWidth)}
          {padRight("NAME", nameWidth)}
          {padRight("SLUG", slugWidth)}DESCRIPTION
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(idWidth)}
          {"─".repeat(nameWidth)}
          {"─".repeat(slugWidth)}
          {"─".repeat(descWidth)}
        </Text>
      </Box>

      {/* Table Rows */}
      {workspaces.map((workspace: AvailableWorkspace, index: number) => (
        <Box key={index}>
          <Text>
            <Text color="blue">{padRight(workspace.id, idWidth)}</Text>
            <Text color="yellow">{padRight(workspace.name, nameWidth)}</Text>
            <Text color="cyan">{padRight(workspace.slug, slugWidth)}</Text>
            <Text color="gray">{workspace.description || "No description"}</Text>
          </Text>
        </Box>
      ))}

      <Box>
        <Text></Text>
      </Box>
      <Box>
        <Text color="gray">
          Use 'atlas tui' to interactively select and load a workspace
        </Text>
      </Box>
    </Box>
  );
}
