import * as start from "./daemon/start.tsx";
import * as stop from "./daemon/stop.tsx";
import * as status from "./daemon/status.tsx";
import * as restart from "./daemon/restart.tsx";
import { YargsInstance } from "../utils/yargs.ts";
import { formatResourceHelp } from "../utils/resource-help.ts";

export const command = "daemon <action>";
export const desc = "Manage Atlas daemon";
export const aliases = ["d"];

export function builder(y: YargsInstance) {
  return y
    .command([start, stop, status, restart])
    .demandCommand(1, "You need to specify a daemon action")
    .example("$0 daemon start", "Start the Atlas daemon")
    .example("$0 daemon status", "Check daemon status")
    .example("$0 daemon stop", "Stop the Atlas daemon")
    .example("$0 d start --port 3000", "Start daemon on specific port")
    .epilogue(formatResourceHelp("daemon"))
    .help()
    .alias("help", "h")
    .strict();
}
