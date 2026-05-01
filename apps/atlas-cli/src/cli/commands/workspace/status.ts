import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { define } from "gunshi";

export const statusCommand = define({
  name: "status",
  description: "Show workspace status and details",
  args: {
    workspace: { type: "string", short: "w", required: true, description: "Workspace ID or name" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const workspaceId = ctx.values.workspace;
    if (!workspaceId) {
      console.error(
        "Error: --workspace is required. Use 'atlas workspace list' to see available workspaces.",
      );
      process.exit(1);
    }

    try {
      const result = await parseResult(
        v2Client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
      );

      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      const workspace = result.data;

      if (ctx.values.json) {
        console.log(
          JSON.stringify(
            {
              id: workspace.id,
              name: workspace.name,
              path: workspace.path,
              status: workspace.status,
              createdAt: workspace.createdAt,
              lastSeen: workspace.lastSeen,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log("Workspace Status\n");
      console.log(`  Name:      ${workspace.name}`);
      console.log(`  ID:        ${workspace.id}`);
      console.log(`  Path:      ${workspace.path}`);
      console.log(`  Status:    ${workspace.status}`);
      console.log(`  Created:   ${new Date(workspace.createdAt).toLocaleString()}`);
      console.log(`  Last Seen: ${new Date(workspace.lastSeen).toLocaleString()}`);
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
