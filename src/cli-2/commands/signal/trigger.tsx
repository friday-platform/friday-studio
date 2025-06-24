import { confirm, isCancel, spinner, text } from "../../utils/prompts.tsx";
import { ConfigLoader } from "../../../core/config-loader.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceEntry } from "../../../core/workspace-registry-types.ts";
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

// Core multi-workspace functions

async function resolveTargetWorkspaces(args: TriggerArgs): Promise<TargetWorkspace[]> {
  const registry = getWorkspaceRegistry();
  await registry.initialize();

  let targetWorkspaces: WorkspaceEntry[] = [];

  if (args.all) {
    // Get all running workspaces
    targetWorkspaces = await registry.getRunning();
  } else if (args.workspace && args.workspace.length > 0) {
    // Get specific workspaces by ID or name
    const workspaceIds = Array.isArray(args.workspace) ? args.workspace : [args.workspace];

    for (const identifier of workspaceIds) {
      const workspace = await registry.findById(identifier) ||
        await registry.findByName(identifier);

      if (workspace && workspace.status === "running") {
        targetWorkspaces.push(workspace);
      } else if (workspace) {
        console.warn(`Workspace '${identifier}' is not running (status: ${workspace.status})`);
      } else {
        console.warn(`Workspace '${identifier}' not found in registry`);
      }
    }
  } else {
    // Default: current workspace or all running
    const currentWorkspace = await registry.getCurrentWorkspace();
    if (currentWorkspace && currentWorkspace.status === "running") {
      targetWorkspaces = [currentWorkspace];
    } else {
      // No current workspace or it's not running - trigger on all
      targetWorkspaces = await registry.getRunning();
    }
  }

  // Apply exclusions
  if (args.exclude && args.exclude.length > 0) {
    const excludeList = Array.isArray(args.exclude) ? args.exclude : [args.exclude];
    const excludeSet = new Set(excludeList);
    targetWorkspaces = targetWorkspaces.filter((w) =>
      !excludeSet.has(w.id) && !excludeSet.has(w.name)
    );
  }

  // Validate and map to target format
  return targetWorkspaces
    .filter((w) => w.port) // Must have a port
    .map((w) => ({
      id: w.id,
      name: w.name,
      port: w.port!,
      path: w.path,
    }));
}

async function validateSignalInWorkspaces(
  signalName: string,
  workspaces: TargetWorkspace[],
): Promise<Map<string, boolean>> {
  const validationResults = new Map<string, boolean>();

  for (const workspace of workspaces) {
    try {
      const originalCwd = Deno.cwd();
      Deno.chdir(workspace.path);

      const configLoader = new ConfigLoader();
      const config = await configLoader.load();
      const signals = config.workspace.signals as Record<string, unknown>;

      validationResults.set(workspace.id, !!(signals && signals[signalName]));

      Deno.chdir(originalCwd);
    } catch {
      validationResults.set(workspace.id, false);
    }
  }

  return validationResults;
}

async function triggerSignalOnWorkspace(
  workspace: TargetWorkspace,
  signalName: string,
  payload: Record<string, unknown>,
): Promise<TriggerResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(
      `http://localhost:${workspace.port}/signals/${signalName}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000), // 5 second timeout per workspace
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${errorText}`);
    }

    const result = await response.json();

    return {
      workspace,
      success: true,
      sessionId: result.sessionId,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      workspace,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
  }
}

async function triggerSignalOnMultipleWorkspaces(
  workspaces: TargetWorkspace[],
  signalName: string,
  payload: Record<string, unknown>,
): Promise<TriggerResult[]> {
  // Always trigger all workspaces in parallel for performance
  return await Promise.all(
    workspaces.map((w) => triggerSignalOnWorkspace(w, signalName, payload)),
  );
}

function formatTriggerResults(
  results: TriggerResult[],
  signalName: string,
  json: boolean,
): void {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (json) {
    const output = {
      signal: signalName,
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
      },
      results: results.map((r) => ({
        workspaceId: r.workspace.id,
        workspaceName: r.workspace.name,
        port: r.workspace.port,
        success: r.success,
        sessionId: r.sessionId,
        error: r.error,
        durationMs: r.duration,
      })),
    };

    console.log(JSON.stringify(output, null, 2));
  } else {
    // Human-readable output
    console.log(`\n✨ Signal '${signalName}' triggered on ${results.length} workspace(s)\n`);

    if (successful.length > 0) {
      console.log(`✅ Successful (${successful.length}):`);
      for (const result of successful) {
        console.log(`   • ${result.workspace.name} (${result.workspace.id})`);
        console.log(`     Port: ${result.workspace.port}, Session: ${result.sessionId}`);
        console.log(`     Duration: ${result.duration}ms`);
      }
    }

    if (failed.length > 0) {
      console.log(`\n❌ Failed (${failed.length}):`);
      for (const result of failed) {
        console.log(`   • ${result.workspace.name} (${result.workspace.id})`);
        console.log(`     Port: ${result.workspace.port}`);
        console.log(`     Error: ${result.error}`);
      }
    }

    // Monitoring hints
    if (successful.length > 0) {
      console.log("\n📊 Monitor sessions:");
      console.log("   • All workspaces: atlas ps");
      for (const result of successful.slice(0, 3)) { // Show first 3
        console.log(`   • ${result.workspace.name}: atlas logs ${result.sessionId}`);
      }
      if (successful.length > 3) {
        console.log(`   • ... and ${successful.length - 3} more`);
      }
    }
  }
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
    // Resolve target workspaces
    const targetWorkspaces = await resolveTargetWorkspaces(argv);

    if (targetWorkspaces.length === 0) {
      errorOutput("No running workspaces found to trigger signal on.");
      if (!argv.all && argv.workspace) {
        infoOutput(
          "Specified workspaces may not be running. Use 'atlas workspace list' to check status.",
        );
      }
      Deno.exit(1);
    }

    // Validate signal exists in workspaces
    const validationResults = await validateSignalInWorkspaces(argv.name, targetWorkspaces);
    const validWorkspaces = targetWorkspaces.filter((w) => validationResults.get(w.id));
    const invalidWorkspaces = targetWorkspaces.filter((w) => !validationResults.get(w.id));

    if (invalidWorkspaces.length > 0) {
      // Just warn about invalid workspaces, don't fail
      console.warn(
        `Signal '${argv.name}' not found in ${invalidWorkspaces.length} workspace(s):\n` +
          invalidWorkspaces.map((w) => `  - ${w.name} (${w.id})`).join("\n"),
      );
    }

    if (validWorkspaces.length === 0) {
      errorOutput(`Signal '${argv.name}' not found in any target workspace.`);
      Deno.exit(1);
    }

    // Get payload data
    const payload = await getSignalPayload(argv);

    // Show what we're about to do
    if (!argv.json) {
      const s = spinner();
      s.start(
        `Triggering signal '${argv.name}' on ${validWorkspaces.length} workspace(s)...`,
      );

      // Trigger signals
      const results = await triggerSignalOnMultipleWorkspaces(
        validWorkspaces,
        argv.name,
        payload,
      );

      s.stop();

      // Format and display results
      formatTriggerResults(results, argv.name, false);
    } else {
      // JSON mode - no spinner
      const results = await triggerSignalOnMultipleWorkspaces(
        validWorkspaces,
        argv.name,
        payload,
      );

      formatTriggerResults(results, argv.name, true);
    }

    // Exit with appropriate code (always exit 0 - partial success is still success)
    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
