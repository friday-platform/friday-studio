import { exists } from "@std/fs";
import { Box, render, Text } from "ink";
import { ConfigLoader } from "../../../core/config-loader.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
}

interface Signal {
  id: string;
  provider: string;
  agents: string;
  strategy: string;
  description: string;
}

export const command = "list";
export const desc = "List configured signals";
export const aliases = ["ls"];

export function builder(y: YargsInstance) {
  return y
    .option("json", {
      type: "boolean",
      describe: "Output signal list as JSON",
      default: false,
    })
    .option("workspace", {
      type: "string",
      alias: "w",
      describe: "Workspace ID or name",
    })
    .example("$0 signal list", "List all configured signals")
    .example("$0 signal list --json", "Export signal configuration as JSON");
}

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    const { workspace, config } = await resolveWorkspaceAndConfig(
      argv.workspace,
    );

    const signals: Signal[] = Object.entries(
      (config.signals as Record<string, any>) || {},
    ).map(([id, signal]) => ({
      id,
      provider: signal.provider || "cli",
      agents: signal.mappings?.[0]?.agents?.join(", ") || "",
      strategy: signal.mappings?.[0]?.strategy || "sequential",
      description: signal.description || "",
    }));

    if (argv.json) {
      // JSON output for scripting
      console.log(
        JSON.stringify(
          {
            workspace: {
              id: workspace.id,
              name: workspace.name,
              path: workspace.path,
            },
            signals: signals,
            count: signals.length,
          },
          null,
          2,
        ),
      );
    } else {
      // Render with Ink
      render(
        <SignalListCommand signals={signals} workspaceName={workspace.name} />,
      );
      // Exit immediately after rendering
      Deno.exit(0);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};

// Helper function to resolve workspace and load config
async function resolveWorkspaceAndConfig(workspaceId?: string): Promise<{
  workspace: { path: string; id: string; name: string };
  config: Record<string, unknown>;
}> {
  const registry = getWorkspaceRegistry();
  await registry.initialize();

  let workspacePath = Deno.cwd();
  let workspace;

  if (workspaceId) {
    // Find workspace by ID or name in the registry
    const targetWorkspace = (await registry.findById(workspaceId)) ||
      (await registry.findByName(workspaceId));

    if (!targetWorkspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found in registry. Use 'atlas workspace list' to see registered workspaces.`,
      );
    }

    workspacePath = targetWorkspace.path;
    workspace = {
      path: targetWorkspace.path,
      id: targetWorkspace.id,
      name: targetWorkspace.name,
    };
  } else {
    // Check current directory for workspace.yml
    if (!(await exists("workspace.yml"))) {
      throw new Error(
        "No workspace specified and not in a workspace directory. " +
          "Use --workspace flag or run from a workspace directory.",
      );
    }

    // Try to find in registry or register
    const currentWorkspace = (await registry.getCurrentWorkspace()) ||
      (await registry.findOrRegister(Deno.cwd()));

    workspace = {
      path: currentWorkspace.path,
      id: currentWorkspace.id,
      name: currentWorkspace.name,
    };
  }

  // Load configuration from the determined workspace path
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    return { workspace, config: mergedConfig.workspace };
  } finally {
    Deno.chdir(originalCwd);
  }
}

// Component that renders the signal list
function SignalListCommand({
  signals,
  workspaceName,
}: {
  signals: Signal[];
  workspaceName: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Signals in workspace: {workspaceName}
      </Text>
      <Text color="gray">
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      </Text>
      {signals.length === 0 ? <Text color="gray">No signals configured</Text> : (
        <>
          <Box>
            <Box width={20}>
              <Text bold color="cyan">
                SIGNAL
              </Text>
            </Box>
            <Box width={10}>
              <Text bold color="cyan">
                PROVIDER
              </Text>
            </Box>
            <Box width={40}>
              <Text bold color="cyan">
                AGENTS
              </Text>
            </Box>
            <Box width={12}>
              <Text bold color="cyan">
                STRATEGY
              </Text>
            </Box>
            <Box width={30}>
              <Text bold color="cyan">
                DESCRIPTION
              </Text>
            </Box>
          </Box>
          <Text>
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          </Text>
          {signals.map((signal) => (
            <Box key={signal.id}>
              <Box width={20}>
                <Text>{signal.id}</Text>
              </Box>
              <Box width={10}>
                <Text>{signal.provider}</Text>
              </Box>
              <Box width={40}>
                <Text>{signal.agents || "-"}</Text>
              </Box>
              <Box width={12}>
                <Text>{signal.strategy}</Text>
              </Box>
              <Box width={30}>
                <Text>{signal.description || "-"}</Text>
              </Box>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
