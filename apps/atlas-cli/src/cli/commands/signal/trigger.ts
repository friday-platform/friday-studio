import process from "node:process";
import { define } from "gunshi";
import {
  batchTriggerSignal,
  streamTriggerSignal,
  validateSignalPayload,
} from "../../../modules/signals/trigger.ts";

export const triggerCommand = define({
  name: "trigger",
  description: "Trigger a signal",
  args: {
    name: { type: "string", short: "n", required: true, description: "Signal name to trigger" },
    data: { type: "string", short: "d", description: "JSON payload data for the signal" },
    workspace: { type: "string", short: "w", description: "Workspace ID or name to target" },
    all: {
      type: "boolean",
      short: "a",
      description: "Trigger signal on all running workspaces",
      default: false,
    },
    exclude: {
      type: "string",
      short: "x",
      description: "Workspace IDs or names to exclude (comma-separated)",
    },
    json: { type: "boolean", description: "Output as JSON", default: false },
    stream: {
      type: "boolean",
      short: "s",
      description: "Stream SSE events in real time",
      default: false,
    },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const signalName = ctx.values.name;
    if (!signalName) {
      console.error("Error: --name is required");
      process.exit(1);
    }

    try {
      // Parse payload
      let payload: Record<string, unknown> = {};
      if (ctx.values.data) {
        payload = validateSignalPayload(ctx.values.data);
      }

      // Parse workspace targeting
      const workspaceIds = ctx.values.workspace
        ? ctx.values.workspace.split(",").map((s) => s.trim())
        : undefined;
      const exclude = ctx.values.exclude
        ? ctx.values.exclude.split(",").map((s) => s.trim())
        : undefined;

      if (ctx.values.stream) {
        await streamTriggerSignal({
          signalName,
          payload,
          workspaceIds,
          all: ctx.values.all,
          exclude,
          onEvent: (event) => {
            if (ctx.values.json) {
              console.log(JSON.stringify(event));
            } else {
              const type = String(event.type ?? "event");
              const data = event.data ?? {};
              console.log(`[${type}] ${JSON.stringify(data)}`);
            }
          },
        });
        process.exit(0);
      }

      // Blocking mode
      const batchResult = await batchTriggerSignal({
        signalName,
        payload,
        workspaceIds,
        all: ctx.values.all,
        exclude,
      });

      if (ctx.values.json) {
        console.log(JSON.stringify(batchResult, null, 2));
      } else {
        const { results } = batchResult;
        console.log(`\nSignal '${signalName}' triggered on ${results.length} workspace(s)\n`);

        const successful = results.filter((r) => r.success);
        const failed = results.filter((r) => !r.success);

        if (successful.length > 0) {
          console.log(`Successful (${successful.length}):`);
          for (const result of successful) {
            console.log(`  ${result.workspaceName} (${result.workspaceId})`);
            console.log(`    Status: ${result.result?.status ?? "processing"}`);
          }
        }

        if (failed.length > 0) {
          console.log(`\nFailed (${failed.length}):`);
          for (const result of failed) {
            console.log(`  ${result.workspaceName} (${result.workspaceId})`);
            console.log(`    Error: ${result.error}`);
          }
        }

        if (successful.length > 0) {
          console.log("\nMonitor sessions with: atlas ps");
        }
      }
      process.exit(0);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
});
