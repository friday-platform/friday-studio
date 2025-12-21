import process from "node:process";
import type { YargsInstance } from "../utils/yargs.ts";
import * as send from "./diagnostics/send.tsx";

export const command = "diagnostics <action>";
export const desc = "Diagnostic tools for Atlas";
export const aliases = ["diag"];

export function builder(y: YargsInstance) {
  return y
    .command([send])
    .demandCommand(1)
    .fail((msg: string, _: unknown, yargs: YargsInstance) => {
      if (msg?.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        process.exit(0);
      }
      yargs.showHelp();
      console.error(`\n${msg}`);
      process.exit(1);
    })
    .example("$0 diagnostics send", "Send diagnostic information to Atlas developers")
    .example("$0 diag send", "Send diagnostics using short alias")
    .help()
    .alias("help", "h")
    .strict();
}
