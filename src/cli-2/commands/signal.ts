import yargs from "yargs";
import * as list from "./signal/list.tsx";
import * as trigger from "./signal/trigger.ts";
import * as history from "./signal/history.tsx";
import { YargsInstance } from "../utils/yargs.ts";

export const command = "signal <action>";
export const desc = "Manage workspace signals";
export const aliases = ["sig"];

export function builder(y: YargsInstance) {
  return y
    .command([list, trigger, history])
    .demandCommand(1, "You need to specify a signal action")
    .help()
    .strict();
}
