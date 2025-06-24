import yargs from "yargs";
import * as list from "./signal/list.tsx";
import * as trigger from "./signal/trigger.ts";
import * as history from "./signal/history.tsx";

export const command = "signal <action>";
export const desc = "Manage workspace signals";
export const aliases = ["sig"];

export function builder(y: ReturnType<typeof yargs>) {
  return y
    .command([list, trigger, history])
    .demandCommand(1, "You need to specify a signal action")
    .help()
    .strict();
}
