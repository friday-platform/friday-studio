import { define } from "gunshi";
import { alias } from "../../../utils/alias.ts";
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
    ls: alias(listCommand),
    add: addCommand,
    register: alias(addCommand),
    status: statusCommand,
    remove: removeCommand,
    rm: alias(removeCommand),
    delete: alias(removeCommand),
    cleanup: cleanupCommand,
    clean: alias(cleanupCommand),
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
