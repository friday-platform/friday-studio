import * as list from "./agent/list.tsx";
import * as describe from "./agent/describe.tsx";
import * as test from "./agent/test.tsx";
import { YargsInstance } from "../utils/yargs.ts";
import { formatResourceHelp } from "../utils/resource-help.ts";

export const command = "agent <action>";
export const desc = "Manage workspace agents";
export const aliases = ["ag"];

export function builder(y: YargsInstance) {
  return y
    .command([list, describe, test])
    .demandCommand(1, "You need to specify an agent action")
    .example("$0 agent list", "List all configured agents")
    .example("$0 agent describe llm-agent", "View agent configuration details")
    .example("$0 ag test tempest-agent", "Test an agent with sample input")
    .example("$0 agent list --json", "Export agent list as JSON")
    .epilogue(formatResourceHelp("agent"))
    .help()
    .alias("help", "h")
    .strict();
}
