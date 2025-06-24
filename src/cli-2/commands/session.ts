import * as list from "./session/list.tsx";
import * as get from "./session/get.tsx";
import * as cancel from "./session/cancel.ts";

export const command = "session <action>";
export const desc = "Manage Atlas sessions";
export const aliases = ["sesh", "sess"];

// deno-lint-ignore no-explicit-any
export function builder(yargs: any) {
  return yargs
    .command([list, get, cancel])
    .demandCommand(1, "You need to specify a session action")
    .help()
    .strict();
}

// deno-lint-ignore no-explicit-any
export function handler(_argv: any) {
  // This won't be called if a subcommand matches
}
