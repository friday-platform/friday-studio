import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { exists } from "@atlas/utils/fs.server";
import { define } from "gunshi";

export const cleanupCommand = define({
  name: "cleanup",
  description: "Remove workspaces with missing directories from the registry",
  args: {
    yes: { type: "boolean", short: "y", description: "Skip confirmation", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    try {
      // Get all workspaces
      const listResult = await parseResult(v2Client.workspace.index.$get());
      if (!listResult.ok) {
        console.error(`Error: ${listResult.error}`);
        process.exit(1);
      }

      const workspaces = listResult.data;
      if (workspaces.length === 0) {
        console.log("No workspaces found in registry.");
        return;
      }

      // Check which workspaces have missing directories
      interface InvalidWorkspace {
        id: string;
        name: string;
        path: string;
      }

      const invalid: InvalidWorkspace[] = [];
      for (const ws of workspaces) {
        try {
          if (!(await exists(ws.path))) {
            invalid.push({ id: ws.id, name: ws.name, path: ws.path });
          }
        } catch {
          invalid.push({ id: ws.id, name: ws.name, path: ws.path });
        }
      }

      if (invalid.length === 0) {
        if (ctx.values.json) {
          console.log(JSON.stringify({ removed: 0, errors: 0 }));
        } else {
          console.log("All workspaces have valid directories. No cleanup needed.");
        }
        return;
      }

      if (!ctx.values.yes) {
        console.log(`Found ${invalid.length} workspace(s) with missing directories:`);
        for (const ws of invalid) {
          console.log(`  - ${ws.name} (${ws.id}) — ${ws.path}`);
        }
        console.error("\nUse --yes to confirm removal.");
        process.exit(1);
      }

      // Remove invalid workspaces
      let removed = 0;
      const errors: string[] = [];

      for (const ws of invalid) {
        const result = await parseResult(
          v2Client.workspace[":workspaceId"].$delete({ param: { workspaceId: ws.id } }),
        );
        if (result.ok) {
          removed++;
        } else {
          errors.push(`Failed to remove ${ws.name}: ${result.error}`);
        }
      }

      if (ctx.values.json) {
        console.log(JSON.stringify({ removed, errors: errors.length, details: errors }));
        return;
      }

      if (removed > 0) {
        console.log(`Removed ${removed} workspace(s) with missing directories.`);
      }
      if (errors.length > 0) {
        console.log("\nErrors:");
        for (const err of errors) {
          console.log(`  - ${err}`);
        }
      }
      if (removed === 0 && errors.length > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
});
