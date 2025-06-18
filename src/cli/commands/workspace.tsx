import React, { useEffect, useState } from "react";
import { Box, Newline, Text, useApp } from "ink";
import { exists } from "@std/fs";
import { ensureDir } from "@std/fs";
import * as yaml from "@std/yaml";
import { load } from "@std/dotenv";
import { ConfigLoader } from "../../core/config-loader.ts";

// Function to scan for available workspaces
export async function scanAvailableWorkspaces() {
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

    const workspaces = [];

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
              runtime?: { server?: { port?: number } };
            };

            if (config.workspace?.name) {
              const port = config.runtime?.server?.port || 8080;
              const workspaceId = config.workspace.id || dirEntry.name;
              let isRunning = false;

              // Check if workspace is currently running
              try {
                const response = await fetch(`http://localhost:${port}/health`);
                if (response.ok) {
                  const healthData = await response.json();
                  isRunning = healthData.workspace === workspaceId;
                }
              } catch {
                // Server not running or unreachable
              }

              workspaces.push({
                name: config.workspace.name,
                id: workspaceId,
                path: workspacePath,
                slug: dirEntry.name, // Folder name as slug
                port: port,
                isRunning: isRunning,
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
}

export interface WorkspaceCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function WorkspaceCommand({
  subcommand,
  args,
  flags,
}: WorkspaceCommandProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const execute = async () => {
      try {
        switch (subcommand) {
          case "init":
            await handleInit(args[0] || flags.name);
            break;
          case "serve":
            handleServe(flags);
            break;
          case "list":
            await handleList();
            break;
          case "status":
            await handleStatus();
            break;
          default:
            setError(`Unknown workspace command: ${subcommand}`);
            setStatus("error");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    execute();
  }, []);

  async function handleInit(name?: string) {
    // Check if workspace.yml already exists
    if (await exists("workspace.yml")) {
      const config = yaml.parse(
        await Deno.readTextFile("workspace.yml"),
      ) as any;
      setData({
        type: "exists",
        workspace: config.workspace,
        message: "workspace.yml already exists",
      });
      setStatus("ready");
      return;
    }

    // Check if we're in a known example directory
    const cwd = Deno.cwd();
    const _isExampleDir = cwd.includes("examples/workspaces");
    const exampleName = cwd.split("/").pop();

    // Generate workspace ID
    const workspaceId = crypto.randomUUID();

    // Create workspace.yml
    const workspaceConfig = {
      version: "1.0",
      workspace: {
        id: workspaceId,
        name: name || exampleName || "My Workspace",
        description: "An Atlas AI agent workspace",
      },
      supervisor: {
        model: "claude-4-sonnet-20250514",
        prompts: {
          system: "You are the WorkspaceSupervisor for this Atlas workspace.",
          intent: "",
          evaluation: "",
          session: "",
        },
      },
      agents: {},
      signals: {},
      runtime: {
        server: {
          port: 8080,
          host: "localhost",
        },
        logging: {
          level: "info",
          format: "pretty",
        },
        persistence: {
          type: "local",
          path: "./.atlas",
        },
      },
    };

    // Write workspace.yml
    await Deno.writeTextFile("workspace.yml", yaml.stringify(workspaceConfig));

    // Create .atlas directory
    await ensureDir(".atlas");
    await ensureDir(".atlas/sessions");
    await ensureDir(".atlas/logs");

    // Save workspace metadata
    await Deno.writeTextFile(
      ".atlas/workspace.json",
      JSON.stringify(
        {
          id: workspaceId,
          name: workspaceConfig.workspace.name,
          createdAt: new Date().toISOString(),
          version: "1.0.0",
        },
        null,
        2,
      ),
    );

    // Create .env if it doesn't exist
    if (!(await exists(".env"))) {
      await Deno.writeTextFile(
        ".env",
        `# Atlas Environment Variables

# Anthropic Claude API Key
# Get from: https://console.anthropic.com/
ANTHROPIC_API_KEY=your_api_key_here

# OpenAI API Key (optional)
# Get from: https://platform.openai.com/api-keys
OPENAI_API_KEY=your_api_key_here
`,
      );
    }

    // Update .gitignore
    if (await exists(".gitignore")) {
      const gitignore = await Deno.readTextFile(".gitignore");
      if (!gitignore.includes(".env")) {
        await Deno.writeTextFile(
          ".gitignore",
          gitignore + "\n.env\n.atlas/\n*.log\n",
        );
      }
    } else {
      await Deno.writeTextFile(".gitignore", ".env\n.atlas/\n*.log\n");
    }

    setData({
      type: "created",
      workspace: workspaceConfig.workspace,
      workspaceId,
    });
    setStatus("ready");
  }

  function handleServe(flags: any) {
    setData({ type: "serving", port: flags.port || 8080 });
    setStatus("ready");

    // The actual server starting will be handled by the ServingComponent
  }

  async function handleList() {
    // Scan for available workspaces in the git repository
    const workspaces = await scanAvailableWorkspaces();
    setData({ type: "list", workspaces });
    setStatus("ready");
  }

  async function handleStatus() {
    const statusData = await getWorkspaceStatus(args[0]);
    setData({ type: "status", ...statusData });
    setStatus("ready");
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  return <WorkspaceOutput data={data} flags={flags} />;
}

function WorkspaceOutput({ data, flags }: { data: any; flags: any }) {
  if (!data) return null;

  switch (data.type) {
    case "created":
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Workspace initialized successfully!</Text>
          <Text>Workspace ID: {data.workspaceId}</Text>
          <Text>Configuration: workspace.yml</Text>
          <Newline />
          <Text>Next steps:</Text>
          <Text color="cyan">1. Update .env with your Anthropic API key</Text>
          <Text color="cyan">2. Review and customize workspace.yml</Text>
          <Text color="cyan">
            3. Run 'atlas workspace serve' to start the workspace
          </Text>
        </Box>
      );

    case "exists":
      return (
        <Box flexDirection="column">
          <Text color="yellow">Workspace already initialized</Text>
          <Text>Name: {data.workspace.name}</Text>
          <Text>Config: workspace.yml</Text>
          <Newline />
          <Text color="gray">
            To reinitialize, delete workspace.yml and .atlas/ directory
          </Text>
        </Box>
      );

    case "list":
      return <WorkspaceList workspaces={data.workspaces} />;

    case "status":
      return <WorkspaceStatus statusData={data} />;

    case "serving":
      return <ServingComponent port={data.port} flags={flags} />;

    default:
      return <Text>Unknown output type: {data.type}</Text>;
  }
}

function ServingComponent({ port, flags }: { port: number; flags: any }) {
  const { exit } = useApp();

  useEffect(() => {
    const startServer = async () => {
      try {
        console.log("Starting workspace server...");
        exit();

        await new Promise((resolve) => setTimeout(resolve, 100));
        await load({ export: true });

        const configLoader = new ConfigLoader();
        const mergedConfig = await configLoader.load();

        const { Workspace } = await import("../../core/workspace.ts");
        const { WorkspaceRuntime } = await import(
          "../../core/workspace-runtime.ts"
        );
        const { WorkspaceServer } = await import(
          "../../core/workspace-server.ts"
        );
        const { WorkspaceMemberRole } = await import("../../types/core.ts");

        const workspace = Workspace.fromConfig(mergedConfig.workspace, {
          id: mergedConfig.workspace.workspace.id,
          name: mergedConfig.workspace.workspace.name,
          role: WorkspaceMemberRole.OWNER,
        });

        const runtime = new WorkspaceRuntime(workspace, mergedConfig, {
          lazy: flags.lazy || false,
        });

        const server = new WorkspaceServer(runtime, {
          port: port || mergedConfig.atlas.runtime?.server?.port || 8080,
          hostname: mergedConfig.atlas.runtime?.server?.host || "localhost",
        });

        await server.start();
      } catch (err) {
        console.error(
          "Failed to start server:",
          err instanceof Error ? err.message : String(err),
        );
        Deno.exit(1);
      }
    };

    startServer();
  }, [exit]);

  // Show initial loading state briefly before exiting Ink
  return <Text color="yellow">Starting workspace server...</Text>;
}

// Shared component for workspace status
export async function getWorkspaceStatus(workspaceId?: string) {
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
        'No workspace.yml found. Run "atlas workspace init" first or specify a workspace-id.',
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
    const metadata = (await exists(".atlas/workspace.json"))
      ? JSON.parse(await Deno.readTextFile(".atlas/workspace.json"))
      : {};

    // Check if server is running
    let serverRunning = false;
    try {
      const response = await fetch(
        `http://localhost:${mergedConfig.atlas.runtime?.server?.port || 8080}/health`,
      );
      if (response.ok) {
        const healthData = await response.json();
        // Verify that the running server is serving the correct workspace
        const expectedWorkspaceId = metadata.id || config.workspace.id;
        serverRunning = healthData.workspace === expectedWorkspaceId;
      }
    } catch (error) {
      throw new Error(`Server health check failed: ${error}`);
    }

    return {
      workspace: {
        ...config.workspace,
        id: metadata.id || config.workspace.id,
        createdAt: metadata.createdAt,
        path: workspaceId ? workspacePath : undefined,
      },
      agents: Object.keys(config.agents || {}),
      signals: Object.keys(config.signals || {}),
      serverRunning,
      port: mergedConfig.atlas.runtime?.server?.port || 8080,
    };
  } finally {
    Deno.chdir(originalCwd);
  }
}

// Shared component for rendering workspace status
export function WorkspaceStatus({ statusData }: { statusData: any }) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Workspace Status
      </Text>
      <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      <Text>
        Name: <Text color="white">{statusData.workspace.name}</Text>
      </Text>
      <Text>
        ID: <Text color="gray">{statusData.workspace.id}</Text>
      </Text>
      {statusData.workspace.path && (
        <Text>
          Path: <Text color="gray">{statusData.workspace.path}</Text>
        </Text>
      )}
      {statusData.workspace.createdAt && (
        <Text>
          Created:{" "}
          <Text color="gray">
            {new Date(statusData.workspace.createdAt).toLocaleString()}
          </Text>
        </Text>
      )}
      <Text>
        Configuration: <Text color="gray">workspace.yml</Text>
      </Text>
      <Newline />
      <Text>
        Agents: <Text color="white">{statusData.agents.length}</Text>
      </Text>
      <Text>
        Signals: <Text color="white">{statusData.signals.length}</Text>
      </Text>
      <Text>
        Server: {statusData.serverRunning
          ? <Text color="green">Running on port {statusData.port}</Text>
          : <Text color="gray">Not running</Text>}
      </Text>
    </Box>
  );
}

// Shared component for rendering workspace list
export function WorkspaceList({ workspaces }: { workspaces: any[] }) {
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
  const idWidth = Math.max(2, ...workspaces.map((w: any) => w.id.length)) + 2;
  const nameWidth = Math.max(4, ...workspaces.map((w: any) => w.name.length)) + 2;
  const slugWidth = Math.max(4, ...workspaces.map((w: any) => w.slug.length)) + 2;
  const portWidth = 8; // Fixed width for port (e.g., "8080")
  const statusWidth = 10; // Fixed width for status (e.g., "Running")

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
          {padRight("SLUG", slugWidth)}
          {padRight("PORT", portWidth)}STATUS
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(idWidth)}
          {"─".repeat(nameWidth)}
          {"─".repeat(slugWidth)}
          {"─".repeat(portWidth)}
          {"─".repeat(statusWidth)}
        </Text>
      </Box>

      {/* Table Rows */}
      {workspaces.map((workspace: any, index: number) => (
        <Box key={index}>
          <Text>
            <Text color="blue">{padRight(workspace.id, idWidth)}</Text>
            <Text color="yellow">{padRight(workspace.name, nameWidth)}</Text>
            <Text color="cyan">{padRight(workspace.slug, slugWidth)}</Text>
            <Text color="white">
              {padRight(workspace.port.toString(), portWidth)}
            </Text>
            <Text color={workspace.isRunning ? "green" : "gray"}>
              {workspace.isRunning ? "Running" : "Stopped"}
            </Text>
          </Text>
        </Box>
      ))}

      <Box>
        <Text></Text>
      </Box>
    </Box>
  );
}
