import process from "node:process";
import { formatResourceHelp } from "../utils/resource-help.ts";
import type { YargsInstance } from "../utils/yargs.ts";
import * as cancel from "./session/cancel.tsx";
import * as get from "./session/get.tsx";
import * as list from "./session/list.tsx";

export const command = "session <action>";
export const desc = "Manage Atlas sessions";
export const aliases = ["sesh", "sess"];

export function builder(y: YargsInstance) {
  return y
    .command([list, get, cancel])
    .demandCommand(1)
    .fail((msg: string, _: unknown, yargs: YargsInstance) => {
      if (msg?.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        process.exit(0);
      }
      yargs.showHelp();
      console.error(`\n${msg}`);
      process.exit(1);
    })
    .example("$0 session list", "List all active sessions")
    .example("$0 session get sess_abc123", "Get details of a specific session")
    .example("$0 sesh cancel sess_xyz789", "Cancel a running session")
    .example("$0 ps", "Quick alias to list sessions")
    .epilogue(formatResourceHelp("session"))
    .help()
    .alias("help", "h")
    .strict();
}
