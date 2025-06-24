import * as list from "./signal/list.tsx";
import * as trigger from "./signal/trigger.ts";
import * as history from "./signal/history.tsx";

export const command = "signal <action>";
export const desc = "Manage workspace signals";
export const aliases = ["sig"];

// deno-lint-ignore no-explicit-any
export function builder(yargs: any) {
  return yargs
    .command([list, trigger, history])
    .demandCommand(1, "You need to specify a signal action")
    .help()
    .strict();
}

// deno-lint-ignore no-explicit-any
export function handler(_argv: any) {
  // This won't be called if a subcommand matches
}
