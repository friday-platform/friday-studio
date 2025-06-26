import { confirm, isCancel, spinner, text } from "../../utils/prompts.tsx";
import { getCurrentWorkspaceName } from "../../utils/workspace-name.ts";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";
import { errorOutput, infoOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface TriggerArgs {
  name: string;
  data?: string;
  port?: number;
  workspace?: string | string[];
  all?: boolean;
  exclude?: string | string[];
  json?: boolean;
}

interface TargetWorkspace {
  id: string;
  name: string;
  port: number;
  path: string;
}

interface TriggerResult {
  workspace: TargetWorkspace;
  success: boolean;
  sessionId?: string;
  error?: string;
  duration: number;
}

export const command = "trigger <name>";
export const desc = "Trigger a signal manually";
export const aliases = ["fire", "send"];

export function builder(y: YargsInstance) {
  return y
    .positional("name", {
      type: "string",
      describe: "Signal name to trigger",
      demandOption: true,
    })
    .option("data", {
      type: "string",
      alias: "d",
      describe: "JSON payload data for the signal",
    })
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port of the workspace server",
      default: 8080,
    })
    .option("workspace", {
      type: "string",
      alias: "w",
      describe: "Workspace ID(s) or name(s) to target (comma-separated for multiple)",
      coerce: (value: string) => value.split(",").map((v) => v.trim()),
    })
    .option("all", {
      type: "boolean",
      alias: "a",
      describe: "Trigger signal on all running workspaces",
      default: false,
    })
    .option("exclude", {
      type: "string",
      alias: "x",
      describe: "Workspace ID(s) or name(s) to exclude (comma-separated)",
      coerce: (value: string) => value ? value.split(",").map((v) => v.trim()) : [],
    })
    .option("json", {
      type: "boolean",
      describe: "Output trigger result as JSON",
      default: false,
    })
    .example("$0 signal trigger manual", "Trigger 'manual' signal interactively")
    .example('$0 signal trigger webhook --data \'{"user":"john"}\'', "Trigger with JSON data")
    .example("$0 sig fire deploy --workspace prod", "Trigger in specific workspace")
    .example("$0 signal trigger deploy --all", "Trigger on all running workspaces")
    .example("$0 signal trigger test --all --exclude dev", "Trigger on all except dev workspace")
    .example("$0 signal trigger refresh --workspace prod,staging", "Trigger on multiple workspaces")
    .example("$0 signal trigger test --json", "Trigger and output result as JSON")
    .help()
    .alias("help", "h");
}

async function getSignalPayload(args: TriggerArgs): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {};

  if (args.data) {
    try {
      payload = JSON.parse(args.data);
    } catch (err) {
      throw new Error(`Invalid JSON data: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!args.json) {
    // Interactive mode - prompt for data
    const wantsData = await confirm({
      message: "Do you want to provide data for this signal?",
      defaultValue: false,
    });

    if (isCancel(wantsData)) {
      throw new Error("Signal trigger cancelled");
    }

    if (wantsData) {
      const dataStr = await text({
        message: "Enter JSON data:",
        placeholder: '{"message": "Hello"}',
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return "Data cannot be empty";
          }
          try {
            JSON.parse(value);
          } catch {
            return "Invalid JSON format";
          }
        },
      }) as string;

      if (isCancel(dataStr)) {
        throw new Error("Signal trigger cancelled");
      }

      payload = JSON.parse(dataStr);
    }
  }

  return payload;
}

export const handler = async (argv: TriggerArgs): Promise<void> => {
  try {
    // Check if daemon is running
    if (!(await checkDaemonRunning())) {
      throw createDaemonNotRunningError();
    }

    // Get payload data
    const payload = await getSignalPayload(argv);

    const client = getDaemonClient();

    // Determine target workspace(s)
    let targetWorkspaces: Array<{ id: string; name: string }> = [];

    if (argv.workspace) {
      // Use specific workspace(s)
      const workspaceIds = Array.isArray(argv.workspace) ? argv.workspace : [argv.workspace];

      for (const workspaceId of workspaceIds) {
        try {
          const workspace = await client.getWorkspace(workspaceId);
          targetWorkspaces.push({ id: workspace.id, name: workspace.name });
        } catch (error) {
          // Try to find by name if ID lookup failed
          const allWorkspaces = await client.listWorkspaces();
          const foundWorkspace = allWorkspaces.find((w) => w.name === workspaceId);
          if (foundWorkspace) {
            targetWorkspaces.push({ id: foundWorkspace.id, name: foundWorkspace.name });
          } else {
            console.warn(`Workspace '${workspaceId}' not found`);
          }
        }
      }
    } else {
      // Use current workspace or error if no workspace specified
      const currentWorkspaceName = await getCurrentWorkspaceName();

      if (!currentWorkspaceName) {
        errorOutput(
          "No workspace.yml found in current directory. Use --workspace to specify target workspace.",
        );
        Deno.exit(1);
      }

      // Find workspace by name in daemon
      const allWorkspaces = await client.listWorkspaces();
      const currentWorkspace = allWorkspaces.find((w) => w.name === currentWorkspaceName);

      if (currentWorkspace) {
        targetWorkspaces.push({ id: currentWorkspace.id, name: currentWorkspace.name });
      } else {
        errorOutput(
          `Current workspace '${currentWorkspaceName}' not found in daemon. Use --workspace to specify target.`,
        );
        Deno.exit(1);
      }
    }

    if (targetWorkspaces.length === 0) {
      errorOutput("No target workspaces found.");
      Deno.exit(1);
    }

    // Trigger signal on each workspace
    const results = [];

    for (const workspace of targetWorkspaces) {
      try {
        const result = await client.triggerSignal(workspace.id, argv.name, payload);
        results.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          success: true,
          result,
        });
      } catch (error) {
        results.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Output results
    if (argv.json) {
      console.log(JSON.stringify(
        {
          signal: argv.name,
          timestamp: new Date().toISOString(),
          results,
        },
        null,
        2,
      ));
    } else {
      console.log(`\n✨ Signal '${argv.name}' triggered on ${results.length} workspace(s)\n`);

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      if (successful.length > 0) {
        console.log(`✅ Successful (${successful.length}):`);
        for (const result of successful) {
          console.log(`   • ${result.workspaceName} (${result.workspaceId})`);
          console.log(`     Status: ${result.result?.status || "processing"}`);
        }
      }

      if (failed.length > 0) {
        console.log(`\n❌ Failed (${failed.length}):`);
        for (const result of failed) {
          console.log(`   • ${result.workspaceName} (${result.workspaceId})`);
          console.log(`     Error: ${result.error}`);
        }
      }

      if (successful.length > 0) {
        console.log("\n📊 Monitor sessions with: atlas ps");
      }
    }
    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
