import process from "node:process";
import { formatResourceHelp } from "../../utils/resource-help.ts";
import type { YargsInstance } from "../../utils/yargs.ts";
import * as get from "./get.ts";
import * as list from "./list.ts";

export const command = "artifacts <action>";
export const desc = "Retrieve and manage artifacts";
export const aliases = ["artifact"];

export function builder(y: YargsInstance) {
  return y
    .command([list, get])
    .demandCommand(1, "You need to specify an artifacts action")
    .fail((msg: string, _: unknown, yargs: YargsInstance) => {
      if (msg?.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        process.exit(0);
      }
      yargs.showHelp();
      console.error(`\n${msg}`);
      process.exit(1);
    })
    .example("$0 artifacts get art_123", "Get an artifact by ID")
    .example("$0 artifacts list --workspace ws_123", "List artifacts for a workspace")
    .example("$0 artifacts list --chat chat_123", "List artifacts for a chat")
    .epilogue(formatResourceHelp("artifacts"))
    .help()
    .alias("help", "h")
    .strict();
}
