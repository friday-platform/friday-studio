import { formatResourceHelp } from "../utils/resource-help.ts";
import type { YargsInstance } from "../utils/yargs.ts";
import * as describe from "./agent/describe.tsx";
import * as list from "./agent/list.tsx";

export const command = "agent <action>";
export const desc = "Manage workspace agents";
export const aliases = ["ag"];

export function builder(y: YargsInstance) {
  return y
    .command([list, describe])
    .demandCommand(1)
    .fail((msg: string, _: unknown, yargs: YargsInstance) => {
      if (msg?.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        Deno.exit(0);
      }
      yargs.showHelp();
      console.error(`\n${msg}`);
      Deno.exit(1);
    })
    .example("$0 agent list", "List all configured agents")
    .example("$0 agent describe llm-agent", "View agent configuration details")
    .example("$0 ag test tempest-agent", "Test an agent with sample input")
    .example("$0 agent list --json", "Export agent list as JSON")
    .epilogue(formatResourceHelp("agent"))
    .help()
    .alias("help", "h")
    .strict();
}
