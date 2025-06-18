import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { Column, Table } from "../components/Table.tsx";
import { scanAvailableWorkspaces } from "./workspace.tsx";
import { ConfigLoader } from "../../core/config-loader.ts";

export interface SignalCommandProps {
  subcommand?: string;
  args: string[];
  flags: any;
}

export function SignalCommand({ subcommand, args, flags }: SignalCommandProps) {
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
          case "trigger":
            await handleTrigger(args[0], flags);
            break;
          case "history":
            await handleHistory();
            break;
          default:
            setError(
              `Unknown signal command: ${subcommand}. Available: list, trigger, history`,
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
      const targetWorkspace = availableWorkspaces.find((w) =>
        w.id === workspaceId || w.slug === workspaceId
      );

      if (!targetWorkspace) {
        throw new Error(
          `Workspace '${workspaceId}' not found. Use 'atlas workspace list' to see available workspaces.`,
        );
      }

      workspacePath = targetWorkspace.path;
    } else {
      // Check current directory for workspace.yml
      if (!await exists("workspace.yml")) {
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

      const signals = Object.entries(config.signals || {}).map((
        [id, signal]: [string, any],
      ) => ({
        id,
        provider: signal.provider || "cli",
        agents: signal.mappings?.[0]?.agents?.join(", ") || "",
        strategy: signal.mappings?.[0]?.strategy || "sequential",
        description: signal.description || "",
      }));

      setData({
        type: "list",
        signals,
        workspaceName: config.workspace?.name,
        workspaceId: workspaceId || "current",
      });
      setStatus("ready");
    } finally {
      Deno.chdir(originalCwd);
    }
  }

  async function handleTrigger(signalName: string | undefined, flags: any) {
    if (!signalName) {
      throw new Error(
        'Signal name required. Usage: atlas signal trigger <name> --data \'{"key": "value"}\'',
      );
    }

    const data = flags.data || flags.d;
    if (!data) {
      throw new Error(
        'Data required. Usage: atlas signal trigger <name> --data \'{"key": "value"}\'',
      );
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch (err) {
      throw new Error(
        `Invalid JSON data: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const port = flags.port || flags.p || 8080;

    try {
      const response = await fetch(
        `http://localhost:${port}/signals/${signalName}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to trigger signal: ${response.status} ${response.statusText}. ${errorText}`,
        );
      }

      const result = await response.json();
      setData({
        type: "triggered",
        signal: signalName,
        sessionId: result.sessionId,
        status: result.status,
      });
      setStatus("ready");
    } catch (err) {
      if (err instanceof Error && err.message.includes("Connection refused")) {
        throw new Error(
          `Cannot connect to workspace server on port ${port}. Is it running? Use 'atlas workspace serve' to start it.`,
        );
      }
      throw err;
    }
  }

  async function handleHistory() {
    // TODO: Implement signal history
    setData({ type: "history", history: [] });
    setStatus("ready");
  }

  if (status === "loading") {
    return <Text>Loading...</Text>;
  }

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  return <SignalOutput data={data} />;
}

function SignalOutput({ data }: { data: any }) {
  if (!data) return null;

  switch (data.type) {
    case "list":
      return (
        <Box flexDirection="column">
          {data.workspaceName && (
            <>
              <Text bold color="cyan">
                Signals in workspace: {data.workspaceName}
              </Text>
              <Text color="gray">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
            </>
          )}
          {data.signals.length === 0 ? <Text color="gray">No signals configured</Text> : (
            (() => {
              const columns: Column[] = [
                { key: "id", label: "SIGNAL", width: 20 },
                { key: "provider", label: "PROVIDER", width: 10 },
                { key: "agents", label: "AGENTS", width: 40 },
                { key: "strategy", label: "STRATEGY", width: 12 },
              ];
              return <Table columns={columns} data={data.signals} />;
            })()
          )}
        </Box>
      );

    case "triggered":
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Signal triggered successfully</Text>
          <Text>Signal: {data.signal}</Text>
          <Text>Session ID: {data.sessionId}</Text>
          <Text>Status: {data.status}</Text>
          <Text></Text>
          <Text color="gray">
            Monitor the session with: atlas logs {data.sessionId}
          </Text>
        </Box>
      );

    case "history":
      return <Text color="gray">Signal history not yet implemented</Text>;

    default:
      return <Text>Unknown output type: {data.type}</Text>;
  }
}
