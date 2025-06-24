import * as list from "./agent/list.tsx";
import * as describe from "./agent/describe.tsx";
import * as test from "./agent/test.ts";

export const command = "agent <action>";
export const desc = "Manage workspace agents";
export const aliases = ["ag"];

// deno-lint-ignore no-explicit-any
export function builder(yargs: any) {
  return yargs
    .command([list, describe, test])
    .demandCommand(1, "You need to specify an agent action")
    .help()
    .strict();
}

// deno-lint-ignore no-explicit-any
export function handler(_argv: any) {
  // This won't be called if a subcommand matches
}
