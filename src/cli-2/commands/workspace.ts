import * as init from "./workspace/init.ts";
import * as list from "./workspace/list.tsx";
import * as status from "./workspace/status.tsx";
import * as serve from "./workspace/serve.ts";
import * as stop from "./workspace/stop.ts";
import * as restart from "./workspace/restart.ts";
import * as remove from "./workspace/remove.ts";
import { YargsInstance } from "../utils/yargs.ts";
import { formatResourceHelp } from "../utils/resource-help.ts";

export const command = "workspace <action>";
export const desc = "Manage Atlas workspaces";
export const aliases = ["work", "w"];

export function builder(y: YargsInstance) {
  return y
    .command([init, list, status, serve, stop, restart, remove])
    .demandCommand(1, "You need to specify a workspace action")
    .example("$0 workspace init", "Initialize a new workspace interactively")
    .example("$0 workspace list", "List all workspaces")
    .example("$0 workspace serve", "Start the workspace server")
    .example("$0 work status my-workspace", "Check status using short alias")
    .epilogue(formatResourceHelp("workspace"))
    .help()
    .alias("help", "h")
    .strict();
}
