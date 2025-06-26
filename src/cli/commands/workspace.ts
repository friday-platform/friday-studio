import * as init from "./workspace/init.tsx";
import * as list from "./workspace/list.tsx";
import * as status from "./workspace/status.tsx";
import * as remove from "./workspace/remove.tsx";
import * as logs from "./workspace/logs.tsx";
import { YargsInstance } from "../utils/yargs.ts";
import { formatResourceHelp } from "../utils/resource-help.ts";

export const command = "workspace <action>";
export const desc = "Manage Atlas workspaces";
export const aliases = ["work", "w"];

export function builder(y: YargsInstance) {
  return y
    .command([init, list, status, remove, logs])
    .demandCommand(1, "You need to specify a workspace action")
    .example("$0 workspace init", "Initialize a new workspace interactively")
    .example("$0 workspace list", "List all registered workspaces")
    .example("$0 workspace status", "Show workspace status and configuration")
    .example("$0 work remove my-workspace", "Remove workspace using short alias")
    .example("$0 workspace logs my-workspace", "View workspace logs")
    .epilogue(formatResourceHelp("workspace"))
    .help()
    .alias("help", "h")
    .strict();
}
