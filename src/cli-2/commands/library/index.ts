import yargs from "yargs";
import * as list from "./list.tsx";
import * as search from "./search.tsx";
import * as get from "./get.tsx";
import * as templates from "./templates.tsx";
import * as generate from "./generate.tsx";
import * as stats from "./stats.tsx";

export const command = "library <action>";
export const desc = "Manage library items and templates";
export const aliases = ["lib"];

export function builder(y: ReturnType<typeof yargs>) {
  return y
    .command([list, search, get, templates, generate, stats])
    .demandCommand(1, "You need to specify a library action");
}

export function handler(argv: any) {
  // This won't be called if a subcommand matches
}
