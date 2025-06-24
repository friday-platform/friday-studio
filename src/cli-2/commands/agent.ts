import * as list from "./agent/list.tsx";
import * as describe from "./agent/describe.tsx";
import * as test from "./agent/test.ts";
import { YargsInstance } from "../utils/yargs.ts";

export const command = "agent <action>";
export const desc = "Manage workspace agents";
export const aliases = ["ag"];

export function builder(y: YargsInstance) {
  return y
    .command([list, describe, test])
    .demandCommand(1, "You need to specify an agent action")
    .help()
    .strict();
}
