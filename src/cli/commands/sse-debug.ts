import * as monitor from "./sse-debug/monitor.tsx";
import * as send from "./sse-debug/send.tsx";
import { YargsInstance } from "../utils/yargs.ts";
import { formatResourceHelp } from "../utils/resource-help.ts";

export const command = "sse-debug <action>";
export const desc = "Debug SSE (Server-Sent Events) streams";
export const aliases = ["sse"];

export function builder(y: YargsInstance) {
  return y
    .command([monitor, send])
    .demandCommand(1)
    .fail((msg: string, _: unknown, yargs: YargsInstance) => {
      if (msg && msg.includes("Not enough non-option arguments")) {
        yargs.showHelp();
        Deno.exit(0);
      }
      yargs.showHelp();
      console.error("\n" + msg);
      Deno.exit(1);
    })
    .example("$0 sse-debug monitor", "Monitor SSE events in real-time")
    .example("$0 sse-debug send 'Hello'", "Send a message and monitor response")
    .example("$0 sse monitor -o events.jsonl", "Monitor and log to file")
    .epilogue(formatResourceHelp("sse-debug"))
    .help()
    .alias("help", "h")
    .strict();
}
