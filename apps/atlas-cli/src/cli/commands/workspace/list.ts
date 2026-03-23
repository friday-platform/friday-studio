import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { define } from "gunshi";

export const listCommand = define({
  name: "list",
  description: "List all registered workspaces",
  args: { json: { type: "boolean", description: "Output as JSON", default: false } },
  rendering: { header: null },
  run: async (ctx) => {
    try {
      const result = await parseResult(v2Client.workspace.index.$get());

      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const workspaces = result.data;

      if (ctx.values.json) {
        console.log(JSON.stringify({ workspaces, count: workspaces.length }, null, 2));
        return;
      }

      if (workspaces.length === 0) {
        console.log("No workspaces found.");
        console.log("Run 'atlas workspace add <path>' to register a workspace.");
        return;
      }

      console.log(`Registered Workspaces (${workspaces.length} found)\n`);

      for (const ws of workspaces) {
        const status = String(ws.status);
        console.log(`  ${ws.name}`);
        console.log(`    ID:      ${ws.id}`);
        console.log(`    Status:  ${status}`);
        console.log(`    Path:    ${ws.path}`);
        console.log(`    Seen:    ${new Date(ws.lastSeen).toLocaleString()}`);
        console.log("");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
        console.error("Error: Unable to connect to Atlas daemon. Make sure it's running.");
      } else {
        console.error(`Error: ${msg}`);
      }
      process.exit(1);
    }
  },
});
