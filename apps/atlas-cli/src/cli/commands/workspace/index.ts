import { define } from "gunshi";
import { addCommand } from "./add.ts";
import { cleanupCommand } from "./cleanup.ts";
import { listCommand } from "./list.ts";
import { removeCommand } from "./remove.ts";
import { statusCommand } from "./status.ts";

export const workspaceCommand = define({
  name: "workspace",
  description: "Manage Atlas workspaces",
  rendering: { header: null },
  subCommands: {
    list: listCommand,
    ls: listCommand,
    add: addCommand,
    register: addCommand,
    status: statusCommand,
    remove: removeCommand,
    rm: removeCommand,
    delete: removeCommand,
    cleanup: cleanupCommand,
    clean: cleanupCommand,
  },
  run: () => {
    console.log("Usage: atlas workspace <command>");
    console.log("");
    console.log("Commands:");
    console.log("  list, ls              List all registered workspaces");
    console.log("  add, register         Add workspace(s) to Atlas registry");
    console.log("  status                Show workspace status and details");
    console.log("  remove, rm, delete    Remove a workspace from the registry");
    console.log("  cleanup, clean        Remove workspaces with missing directories");
  },
});
