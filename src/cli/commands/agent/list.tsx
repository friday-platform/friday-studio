import { render } from "ink";
import { AgentListComponent } from "../../modules/agents/agent-list-component.tsx";
import { processAgentsFromConfig } from "../../modules/agents/processor.ts";
import { loadWorkspaceConfig, resolveWorkspaceOnly } from "../../modules/workspaces/resolver.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
}

export const command = "list";
export const desc = "List workspace agents";
export const aliases = ["ls"];

export const builder = {
  json: {
    type: "boolean" as const,
    describe: "Output agent list as JSON",
    default: false,
  },
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID or name",
  },
};

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    const workspace = await resolveWorkspaceOnly(argv.workspace);
    const config = await loadWorkspaceConfig(workspace.path);
    const agents = processAgentsFromConfig(config);

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
            agents: agents,
            count: agents.length,
          },
          null,
          2,
        ),
      );
    } else {
      // Render with Ink
      render(
        <AgentListComponent agents={agents} workspaceName={workspace.name} />,
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
