import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { define } from "gunshi";

export const listCommand = define({
  name: "list",
  description: "List configured signals",
  args: {
    workspace: { type: "string", short: "w", description: "Workspace ID or name" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    try {
      // Resolve workspace
      const workspaceId = ctx.values.workspace;
      if (!workspaceId) {
        console.error(
          "Error: --workspace is required. Use 'atlas workspace list' to see available workspaces.",
        );
        process.exit(1);
      }

      const result = await parseResult(
        v2Client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } }),
      );

      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const { signals } = result.data;

      if (ctx.values.json) {
        console.log(JSON.stringify({ signals }, null, 2));
        return;
      }

      if (signals.length === 0) {
        console.log("No signals configured.");
        return;
      }

      for (const entry of signals) {
        console.log(`  ${entry.name}`);
        if (entry.signal.description) {
          console.log(`    ${entry.signal.description}`);
        }
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
});
