import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { define } from "gunshi";

export const removeCommand = define({
  name: "remove",
  description: "Remove a workspace from the registry",
  args: {
    workspace: { type: "string", short: "w", required: true, description: "Workspace ID or name" },
    yes: { type: "boolean", short: "y", description: "Skip confirmation", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const workspaceRef = ctx.values.workspace;
    if (!workspaceRef) {
      console.error(
        "Error: --workspace is required. Use 'atlas workspace list' to see available workspaces.",
      );
      process.exit(1);
    }

    try {
      // Resolve workspace by ID or name
      const listResult = await parseResult(v2Client.workspace.index.$get());
      if (!listResult.ok) {
        console.error(`Error: ${listResult.error}`);
        process.exit(1);
      }

      const workspace = listResult.data.find(
        (w) => w.id === workspaceRef || w.name === workspaceRef,
      );

      if (!workspace) {
        console.error(
          `Error: Workspace '${workspaceRef}' not found. Use 'atlas workspace list' to see available workspaces.`,
        );
        process.exit(1);
      }

      if (!ctx.values.yes) {
        console.error(
          `Error: Removing workspace '${workspace.name}' requires --yes flag for confirmation.`,
        );
        process.exit(1);
      }

      // Delete workspace
      const result = await parseResult(
        v2Client.workspace[":workspaceId"].$delete({ param: { workspaceId: workspace.id } }),
      );

      if (!result.ok) {
        console.error(`Error: Failed to remove workspace: ${result.error}`);
        process.exit(1);
      }

      if (ctx.values.json) {
        console.log(JSON.stringify({ removed: { id: workspace.id, name: workspace.name } }));
        return;
      }

      console.log(`Workspace '${workspace.name}' (${workspace.id}) removed from registry.`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
});
