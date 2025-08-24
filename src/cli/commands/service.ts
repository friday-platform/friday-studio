import type { YargsInstance } from "../utils/yargs.ts";
import * as install from "./service/install.tsx";
import * as start from "./service/start.tsx";
import * as status from "./service/status.tsx";
import * as stop from "./service/stop.tsx";
import * as uninstall from "./service/uninstall.tsx";

export const command = "service <action>";
export const desc = "Manage Atlas service installation and lifecycle";
export const aliases = ["svc"];

export function builder(y: YargsInstance) {
  return y
    .command([install, uninstall, status, start, stop])
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
    .example("$0 service install", "Install Atlas as a system service")
    .example("$0 service status", "Check service status")
    .example("$0 service start", "Start the service")
    .example("$0 service stop", "Stop the service")
    .example("$0 service uninstall", "Remove the service")
    .help()
    .alias("help", "h")
    .strict();
}
