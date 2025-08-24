import { formatResourceHelp } from "../utils/resource-help.ts";
import type { YargsInstance } from "../utils/yargs.ts";
import * as add from "./workspace/add.tsx";
import * as cleanup from "./workspace/cleanup.tsx";
import * as init from "./workspace/init.tsx";
import * as list from "./workspace/list.tsx";
import * as logs from "./workspace/logs.tsx";
import * as remove from "./workspace/remove.tsx";
import * as status from "./workspace/status.tsx";

export const command = "workspace <action>";
export const desc = "Manage Atlas workspaces";
export const aliases = ["work", "w"];

export function builder(y: YargsInstance) {
  return y
    .command([init, list, status, remove, logs, add, cleanup])
    .demandCommand(1)
    .fail((msg: string, _: unknown, yargs: YargsInstance) => {
      if (msg && msg.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        Deno.exit(0);
      }
      yargs.showHelp();
      console.error("\n" + msg);
      Deno.exit(1);
    })
    .example("$0 workspace init", "Initialize a new workspace interactively")
    .example("$0 workspace list", "List all registered workspaces")
    .example("$0 workspace status", "Show workspace status and configuration")
    .example("$0 workspace add ~/my-workspace", "Add existing workspace to registry")
    .example("$0 work remove my-workspace", "Remove workspace using short alias")
    .example("$0 workspace logs my-workspace", "View workspace logs")
    .epilogue(formatResourceHelp("workspace"))
    .help()
    .alias("help", "h")
    .strict();
}
