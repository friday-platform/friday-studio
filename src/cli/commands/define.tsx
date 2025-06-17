import React, { useEffect, useState } from "react";
import { Box, Newline, Text } from "ink";
import { exists } from "https://deno.land/std@0.208.0/fs/exists.ts";
import { ConfigLoader } from "../../core/config-loader.ts";

interface WorkspaceDetails {
  name: string;
  id: string;
  description?: string;
  version?: string;
}

interface AgentSummary {
  id: string;
  type: string;
  purpose?: string;
  model?: string;
  endpoint?: string;
  protocol?: string;
}

interface SignalSummary {
  id: string;
  provider: string;
  description?: string;
  path?: string;
  method?: string;
  command?: string;
}

interface RuntimeSummary {
  serverPort?: number;
  serverHost?: string;
  loggingLevel?: string;
  persistenceType?: string;
  persistencePath?: string;
}

interface DefineCommandProps {
  flags?: Record<string, unknown> & {
    workspace?: string;
  };
}

export default function DefineCommand({ flags = {} }: DefineCommandProps) {
  const [workspaceDetails, setWorkspaceDetails] = useState<WorkspaceDetails | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [signals, setSignals] = useState<SignalSummary[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const workspaceName = flags.workspace as string;

  useEffect(() => {
    const loadWorkspaceDefinition = async () => {
      try {
        setLoading(true);

        if (!workspaceName) {
          throw new Error("Workspace name is required. Use --workspace=<name>");
        }

        // Find git repository root
        const gitRoot = new Deno.Command("git", {
          args: ["rev-parse", "--show-toplevel"],
        }).outputSync();

        if (!gitRoot.success) {
          throw new Error("Not in a git repository");
        }

        const rootPath = new TextDecoder().decode(gitRoot.stdout).trim();
        const workspacePath = `${rootPath}/examples/workspaces/${workspaceName}`;
        const workspaceYmlPath = `${workspacePath}/workspace.yml`;

        // Check if workspace exists
        if (!(await exists(workspaceYmlPath))) {
          throw new Error(
            `Workspace '${workspaceName}' not found in examples/workspaces/`,
          );
        }

        // Load configuration using ConfigLoader
        const configLoader = new ConfigLoader(workspacePath);
        const mergedConfig = await configLoader.load();
        const config = mergedConfig.workspace;

        if (!config.workspace) {
          throw new Error("Invalid workspace.yml: missing workspace section");
        }

        // Extract workspace details
        setWorkspaceDetails({
          name: config.workspace.name || workspaceName,
          id: config.workspace.id || "unknown",
          description: config.workspace.description,
          version: config.version,
        });

        // Extract agent summaries
        const agentSummaries: AgentSummary[] = [];
        if (config.agents) {
          for (const [agentId, agentConfig] of Object.entries(config.agents)) {
            agentSummaries.push({
              id: agentId,
              type: agentConfig.type || "unknown",
              purpose: agentConfig.purpose,
              model: agentConfig.model,
              endpoint: agentConfig.endpoint,
              protocol: agentConfig.protocol,
            });
          }
        }
        setAgents(agentSummaries);

        // Extract signal summaries
        const signalSummaries: SignalSummary[] = [];
        if (config.signals) {
          for (const [signalId, signalConfig] of Object.entries(config.signals)) {
            signalSummaries.push({
              id: signalId,
              provider: signalConfig.provider || "unknown",
              description: signalConfig.description,
              path: signalConfig.path,
              method: signalConfig.method,
              command: signalConfig.command,
            });
          }
        }
        setSignals(signalSummaries);

        // Extract runtime summary from atlas config
        if (mergedConfig.atlas.runtime) {
          setRuntime({
            serverPort: mergedConfig.atlas.runtime.server?.port,
            serverHost: mergedConfig.atlas.runtime.server?.host,
            loggingLevel: mergedConfig.atlas.runtime.logging?.level,
            persistenceType: mergedConfig.atlas.runtime.persistence?.type,
            persistencePath: mergedConfig.atlas.runtime.persistence?.path,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    loadWorkspaceDefinition();
  }, [workspaceName]);

  if (loading) {
    return (
      <Box>
        <Text color="cyan">Loading workspace definition...</Text>
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

  if (!workspaceDetails) {
    return (
      <Box>
        <Text color="red">No workspace details found</Text>
      </Box>
    );
  }

  // Calculate column widths for details section
  const detailLabelWidth =
    Math.max("Name:".length, "ID:".length, "Version:".length, "Description:".length) + 2;

  // Calculate column widths for agents table
  const agentIdWidth = Math.max(2, ...agents.map((a) => a.id.length)) + 2;
  const agentTypeWidth = Math.max(4, ...agents.map((a) => a.type.length)) + 2;
  const modelWidth = Math.max(5, ...agents.map((a) => a.model?.length || 0)) + 2;
  const endpointWidth = Math.max(8, ...agents.map((a) => a.endpoint?.length || 0)) + 2;

  // Calculate column widths for signals table
  const signalIdWidth = Math.max(2, ...signals.map((s) => s.id.length)) + 2;
  const providerWidth = Math.max(8, ...signals.map((s) => s.provider.length)) + 2;
  const pathWidth = Math.max(4, ...signals.map((s) => s.path?.length || 0)) + 2;
  const methodWidth = Math.max(6, ...signals.map((s) => s.method?.length || 0)) + 2;

  // Calculate column widths for runtime section
  const runtimeLabelWidth = Math.max(
    "Server Port:".length,
    "Server Host:".length,
    "Logging Level:".length,
    "Persistence Type:".length,
    "Persistence Path:".length,
  ) + 2;

  const padRight = (str: string, width: number) => {
    return str.length >= width
      ? str.substring(0, width - 1) + "…"
      : str + " ".repeat(width - str.length);
  };

  return (
    <Box flexDirection="column">
      {/* Header */}

      <Text bold color="cyan">
        Workspace Definition: {workspaceDetails.name}
      </Text>

      <Box height={1}></Box>

      {/* Details Section */}

      <Text bold color="white">
        ═══ DETAILS ═══
      </Text>

      <Box height={1}></Box>

      <Box>
        <Text color="yellow">{padRight("Name:", detailLabelWidth)}</Text>
        <Text>{workspaceDetails.name}</Text>
      </Box>
      <Box>
        <Text color="yellow">{padRight("ID:", detailLabelWidth)}</Text>
        <Text>{workspaceDetails.id}</Text>
      </Box>
      {workspaceDetails.version && (
        <Box>
          <Text color="yellow">{padRight("Version:", detailLabelWidth)}</Text>
          <Text>{workspaceDetails.version}</Text>
        </Box>
      )}
      {workspaceDetails.description && (
        <Box>
          <Text color="yellow">{padRight("Description:", detailLabelWidth)}</Text>
          <Text>{workspaceDetails.description}</Text>
        </Box>
      )}

      <Newline />

      {/* Agents Section */}
      <Box>
        <Text bold color="white">
          ═══ AGENTS ({agents.length}) ═══
        </Text>
      </Box>

      {agents.length === 0
        ? (
          <Box>
            <Text color="gray">No agents defined</Text>
          </Box>
        )
        : (
          <>
            {/* Agents Table Header */}
            <Box>
              <Text bold color="white">
                {padRight("ID", agentIdWidth)}
                {padRight("TYPE", agentTypeWidth)}
                {padRight("MODEL", modelWidth)}
                {padRight("ENDPOINT", endpointWidth)}PURPOSE
              </Text>
            </Box>
            <Box>
              <Text color="gray">
                {"─".repeat(agentIdWidth)}
                {"─".repeat(agentTypeWidth)}
                {"─".repeat(modelWidth)}
                {"─".repeat(endpointWidth)}
                {"─".repeat(40)}
              </Text>
            </Box>

            {/* Agents Table Rows */}
            {agents.map((agent, index) => (
              <Box key={index}>
                <Text>
                  <Text color="cyan">{padRight(agent.id, agentIdWidth)}</Text>
                  <Text color="yellow">{padRight(agent.type, agentTypeWidth)}</Text>
                  <Text color="blue">
                    {padRight(agent.model || "-", modelWidth)}
                  </Text>
                  <Text color="magenta">
                    {padRight(agent.endpoint || "-", endpointWidth)}
                  </Text>
                  <Text color="gray">
                    {agent.purpose || "No purpose specified"}
                  </Text>
                </Text>
              </Box>
            ))}
          </>
        )}

      <Newline />

      {/* Signals Section */}
      <Box>
        <Text bold color="white">
          ═══ SIGNALS ({signals.length}) ═══
        </Text>
      </Box>

      {signals.length === 0
        ? (
          <Box>
            <Text color="gray">No signals defined</Text>
          </Box>
        )
        : (
          <>
            {/* Signals Table Header */}
            <Box>
              <Text bold color="white">
                {padRight("ID", signalIdWidth)}
                {padRight("PROVIDER", providerWidth)}
                {padRight("PATH", pathWidth)}
                {padRight("METHOD", methodWidth)}DESCRIPTION
              </Text>
            </Box>
            <Box>
              <Text color="gray">
                {"─".repeat(signalIdWidth)}
                {"─".repeat(providerWidth)}
                {"─".repeat(pathWidth)}
                {"─".repeat(methodWidth)}
                {"─".repeat(40)}
              </Text>
            </Box>

            {/* Signals Table Rows */}
            {signals.map((signal, index) => (
              <Box key={index}>
                <Text>
                  <Text color="cyan">{padRight(signal.id, signalIdWidth)}</Text>
                  <Text color="yellow">{padRight(signal.provider, providerWidth)}</Text>
                  <Text color="blue">
                    {padRight(
                      signal.path || (signal.command ? `cmd:${signal.command}` : "-"),
                      pathWidth,
                    )}
                  </Text>
                  <Text color="magenta">
                    {padRight(signal.method || "-", methodWidth)}
                  </Text>
                  <Text color="gray">
                    {signal.description || "No description"}
                  </Text>
                </Text>
              </Box>
            ))}
          </>
        )}

      {runtime && (
        <>
          <Newline />

          {/* Runtime Section */}
          <Box>
            <Text bold color="white">
              ═══ RUNTIME ═══
            </Text>
          </Box>

          {runtime.serverPort && (
            <Box>
              <Text color="yellow">{padRight("Server Port:", runtimeLabelWidth)}</Text>
              <Text>{runtime.serverPort}</Text>
            </Box>
          )}
          {runtime.serverHost && (
            <Box>
              <Text color="yellow">{padRight("Server Host:", runtimeLabelWidth)}</Text>
              <Text>{runtime.serverHost}</Text>
            </Box>
          )}
          {runtime.loggingLevel && (
            <Box>
              <Text color="yellow">{padRight("Logging Level:", runtimeLabelWidth)}</Text>
              <Text>{runtime.loggingLevel}</Text>
            </Box>
          )}
          {runtime.persistenceType && (
            <Box>
              <Text color="yellow">{padRight("Persistence Type:", runtimeLabelWidth)}</Text>
              <Text>{runtime.persistenceType}</Text>
            </Box>
          )}
          {runtime.persistencePath && (
            <Box>
              <Text color="yellow">{padRight("Persistence Path:", runtimeLabelWidth)}</Text>
              <Text>{runtime.persistencePath}</Text>
            </Box>
          )}
        </>
      )}

      <Newline />
      <Box>
        <Text color="gray">
          Use 'atlas tui --workspace {workspaceName}' to interactively explore this workspace
        </Text>
      </Box>
    </Box>
  );
}
