import { formatResourceHelp } from "../../utils/resource-help.ts";
import type { YargsInstance } from "../../utils/yargs.ts";
import * as get from "./get.tsx";
import * as list from "./list.tsx";

export const command = "library <action>";
export const desc = "Manage library items and templates";
export const aliases = ["lib"];

export function builder(y: YargsInstance) {
  return y
    .command([list, get])
    .demandCommand(1, "You need to specify a library action")
    .example("$0 library list", "List all library items")
    .example("$0 lib get item_abc --content", "Get item with content")
    .epilogue(formatResourceHelp("library"))
    .help()
    .alias("help", "h")
    .strict();
}
