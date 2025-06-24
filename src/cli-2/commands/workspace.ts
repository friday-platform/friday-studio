import * as init from "./workspace/init.ts";
import * as list from "./workspace/list.tsx";
import * as status from "./workspace/status.tsx";
import * as serve from "./workspace/serve.ts";
import * as stop from "./workspace/stop.ts";
import * as restart from "./workspace/restart.ts";
import * as remove from "./workspace/remove.ts";

export const command = "workspace <action>";
export const desc = "Manage Atlas workspaces";
export const aliases = ["work", "w"];

// deno-lint-ignore no-explicit-any
export function builder(yargs: any) {
  return yargs
    .command([init, list, status, serve, stop, restart, remove])
    .demandCommand(1, "You need to specify a workspace action")
    .help()
    .strict();
}

// deno-lint-ignore no-explicit-any
export function handler(_argv: any) {
  // This won't be called if a subcommand matches
}
