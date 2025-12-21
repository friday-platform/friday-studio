import process from "node:process";
import { batchTriggerSignal, validateSignalPayload } from "../../modules/signals/trigger.ts";
import { errorOutput } from "../../utils/output.ts";
import { confirm, isCancel, text } from "../../utils/prompts.tsx";
import type { YargsInstance } from "../../utils/yargs.ts";

interface TriggerArgs {
  name: string;
  data?: string;
  port?: number;
  workspace?: string | string[];
  all?: boolean;
  exclude?: string | string[];
  json?: boolean;
}

export const command = "trigger <name>";
export const desc = "Trigger a signal manually";
export const aliases = ["fire", "send"];

export function builder(y: YargsInstance) {
  return y
    .positional("name", { type: "string", describe: "Signal name to trigger", demandOption: true })
    .option("data", { type: "string", alias: "d", describe: "JSON payload data for the signal" })
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
      coerce: (value: string) => (value ? value.split(",").map((v) => v.trim()) : []),
    })
    .option("json", { type: "boolean", describe: "Output trigger result as JSON", default: false })
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
    payload = validateSignalPayload(args.data);
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
      });

      if (isCancel(dataStr)) {
        throw new Error("Signal trigger cancelled");
      }

      payload = validateSignalPayload(dataStr);
    }
  }

  return payload;
}

export const handler = async (argv: TriggerArgs): Promise<void> => {
  try {
    // Get payload data
    const payload = await getSignalPayload(argv);

    // Prepare workspace targeting options
    const workspaceIds = argv.workspace
      ? Array.isArray(argv.workspace)
        ? argv.workspace
        : [argv.workspace]
      : undefined;

    const exclude = argv.exclude
      ? Array.isArray(argv.exclude)
        ? argv.exclude
        : [argv.exclude]
      : undefined;

    // Trigger signal using abstracted function
    const batchResult = await batchTriggerSignal({
      signalName: argv.name,
      payload,
      workspaceIds,
      all: argv.all,
      exclude,
    });

    // Output results
    if (argv.json) {
      console.log(JSON.stringify(batchResult, null, 2));
    } else {
      const { results } = batchResult;
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
          console.log(`     Error: ${JSON.stringify(result, null, 2)}`);
        }
      }

      if (successful.length > 0) {
        console.log("\n📊 Monitor sessions with: atlas ps");
      }
    }
    process.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
