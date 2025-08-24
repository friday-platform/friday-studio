import { formatResourceHelp } from "../../utils/resource-help.ts";
import type { YargsInstance } from "../../utils/yargs.ts";
import * as generate from "./generate.tsx";
import * as get from "./get.tsx";
import * as list from "./list.tsx";
import * as search from "./search.tsx";
import * as stats from "./stats.tsx";
import * as templates from "./templates.tsx";

export const command = "library <action>";
export const desc = "Manage library items and templates";
export const aliases = ["lib"];

export function builder(y: YargsInstance) {
  return y
    .command([list, search, get, templates, generate, stats])
    .demandCommand(1, "You need to specify a library action")
    .example("$0 library list", "List all library items")
    .example("$0 library search 'agent config'", "Search library content")
    .example("$0 lib get item_abc --content", "Get item with content")
    .example("$0 library generate agent-template data.json", "Generate from template")
    .example("$0 lib stats", "View library usage statistics")
    .epilogue(formatResourceHelp("library"))
    .help()
    .alias("help", "h")
    .strict();
}
