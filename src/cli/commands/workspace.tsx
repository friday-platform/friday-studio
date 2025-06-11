import React, { useEffect, useState } from "react";
import { Box, Newline, Text, useApp } from "ink";
import { exists } from "https://deno.land/std@0.208.0/fs/exists.ts";
import { ensureDir } from "https://deno.land/std@0.208.0/fs/ensure_dir.ts";
import * as yaml from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { load } from "https://deno.land/std@0.208.0/dotenv/mod.ts";
import { Column, Table } from "../components/Table.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";

export interface WorkspaceCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function WorkspaceCommand(
  { subcommand, args, flags }: WorkspaceCommandProps,
) {
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
            await handleServe(flags);
            break;
          case "stop":
            await handleStop(flags);
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
    const isExampleDir = cwd.includes("examples/workspaces");
    const exampleName = cwd.split("/").pop();

    // Generate workspace ID
    const workspaceId = crypto.randomUUID();

    // Create workspace.yml
    const workspaceConfig = {
      version: "1.0",
      workspace: {
        id: "${WORKSPACE_ID}",
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
    if (!await exists(".env")) {
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

  async function handleServe(flags: any) {
    setData({ type: "serving", port: flags.port || 8080 });
    setStatus("ready");

    // The actual server starting will be handled by the ServingComponent
  }

  async function handleList() {
    // For now, just list the current workspace
    // In future, this could list all workspaces from ~/.atlas
    const workspaces = [];

    if (await exists("workspace.yml")) {
      const config = yaml.parse(
        await Deno.readTextFile("workspace.yml"),
      ) as any;
      const metadata = await exists(".atlas/workspace.json")
        ? JSON.parse(await Deno.readTextFile(".atlas/workspace.json"))
        : {};

      workspaces.push({
        id: metadata.id || config.workspace.id,
        name: config.workspace.name,
        status: "ready",
        agents: Object.keys(config.agents || {}).length,
        signals: Object.keys(config.signals || {}).length,
        sessions: 0, // TODO: Count actual sessions
      });
    }

    setData({ type: "list", workspaces });
    setStatus("ready");
  }

  async function handleStatus() {
    if (!await exists("workspace.yml")) {
      throw new Error(
        'No workspace.yml found. Run "atlas workspace init" first.',
      );
    }

    const config = yaml.parse(await Deno.readTextFile("workspace.yml")) as any;
    const metadata = await exists(".atlas/workspace.json")
      ? JSON.parse(await Deno.readTextFile(".atlas/workspace.json"))
      : {};

    // Check if server is running
    let serverRunning = false;
    try {
      const response = await fetch(
        `http://localhost:${config.runtime?.server?.port || 8080}/health`,
      );
      serverRunning = response.ok;
    } catch {
      // Server not running
    }

    setData({
      type: "status",
      workspace: {
        ...config.workspace,
        id: metadata.id || config.workspace.id,
        createdAt: metadata.createdAt,
      },
      agents: Object.keys(config.agents || {}),
      signals: Object.keys(config.signals || {}),
      serverRunning,
      port: config.runtime?.server?.port || 8080,
    });
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
      if (data.workspaces.length === 0) {
        return <Text color="gray">No workspaces found</Text>;
      }

      const columns: Column[] = [
        { key: "name", label: "NAME", width: 20 },
        { key: "status", label: "STATUS", width: 12 },
        { key: "agents", label: "AGENTS", width: 8, align: "right" },
        { key: "signals", label: "SIGNALS", width: 8, align: "right" },
        { key: "sessions", label: "SESSIONS", width: 10, align: "right" },
      ];

      const rows = data.workspaces.map((ws: any) => ({
        ...ws,
        status: <StatusBadge status={ws.status} />,
      }));

      return <Table columns={columns} data={rows} />;

    case "status":
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">Workspace Status</Text>
          <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          <Text>
            Name: <Text color="white">{data.workspace.name}</Text>
          </Text>
          <Text>
            ID: <Text color="gray">{data.workspace.id}</Text>
          </Text>
          {data.workspace.createdAt && (
            <Text>
              Created:{" "}
              <Text color="gray">
                {new Date(data.workspace.createdAt).toLocaleString()}
              </Text>
            </Text>
          )}
          <Text>
            Configuration: <Text color="gray">workspace.yml</Text>
          </Text>
          <Newline />
          <Text>
            Agents: <Text color="white">{data.agents.length}</Text>
          </Text>
          <Text>
            Signals: <Text color="white">{data.signals.length}</Text>
          </Text>
          <Text>
            Server: {data.serverRunning
              ? <Text color="green">Running on port {data.port}</Text>
              : <Text color="gray">Not running</Text>}
          </Text>
        </Box>
      );

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

        const workspaceYaml = await Deno.readTextFile("workspace.yml");
        const config = yaml.parse(workspaceYaml) as any;

        const { Workspace } = await import("../../core/workspace.ts");
        const { WorkspaceRuntime } = await import("../../core/workspace-runtime.ts");
        const { WorkspaceServer } = await import("../../core/workspace-server.ts");
        const { WorkspaceMemberRole } = await import("../../types/core.ts");

        const workspace = Workspace.fromConfig(config, {
          id: config.workspace.id,
          name: config.workspace.name,
          role: WorkspaceMemberRole.OWNER,
        });

        const runtime = new WorkspaceRuntime(workspace, config, {
          lazy: flags.lazy || false,
        });

        const server = new WorkspaceServer(runtime, {
          port: port || config.runtime?.server?.port || 8080,
          hostname: config.runtime?.server?.host || "localhost",
        });

        await server.start();
      } catch (err) {
        console.error("Failed to start server:", err instanceof Error ? err.message : String(err));
        Deno.exit(1);
      }
    };

    startServer();
  }, [exit]);

  // Show initial loading state briefly before exiting Ink
  return <Text color="yellow">Starting workspace server...</Text>;
}
