import process from "node:process";
import { formatResourceHelp } from "../utils/resource-help.ts";
import type { YargsInstance } from "../utils/yargs.ts";
import * as list from "./signal/list.tsx";
import * as trigger from "./signal/trigger.tsx";

export const command = "signal <action>";
export const desc = "Manage workspace signals";
export const aliases = ["sig"];

export function builder(y: YargsInstance) {
  return y
    .command([list, trigger])
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
    .example("$0 signal list", "List all configured signals")
    .example("$0 signal trigger webhook", "Trigger a signal interactively")
    .example('$0 sig trigger manual --data \'{"message":"hello"}\'', "Trigger with data")
    .example("$0 signal history --since 1h", "View recent signal history")
    .epilogue(formatResourceHelp("signal"))
    .help()
    .alias("help", "h")
    .strict();
}
