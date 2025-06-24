import yargs from "yargs";
import * as list from "./session/list.tsx";
import * as get from "./session/get.tsx";
import * as cancel from "./session/cancel.ts";
import { YargsInstance } from "../utils/yargs.ts";

export const command = "session <action>";
export const desc = "Manage Atlas sessions";
export const aliases = ["sesh", "sess"];

export function builder(y: YargsInstance) {
  return y
    .command([list, get, cancel])
    .demandCommand(1, "You need to specify a session action")
    .help()
    .strict();
}
