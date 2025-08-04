import { render } from "ink";
import { SignalListComponent } from "../../modules/signals/SignalListComponent.tsx";
import { loadWorkspaceConfig, resolveWorkspaceOnly } from "../../modules/workspaces/resolver.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
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
    const workspace = await resolveWorkspaceOnly(argv.workspace);
    const config = await loadWorkspaceConfig(workspace.path);

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
            signals: config.signals || {},
            count: Object.keys(config.signals || {}).length,
          },
          null,
          2,
        ),
      );
    } else {
      // Render with Ink
      const { unmount } = render(
        <SignalListComponent
          signalEntries={Object.entries(config.signals || {})}
          workspaceName={workspace.name}
        />,
      );

      // Give a moment for render then exit
      setTimeout(() => {
        unmount();
      }, 100);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};
