import { define } from "gunshi";
import { alias } from "../../../utils/alias.ts";
import { listCommand } from "./list.ts";
import { triggerCommand } from "./trigger.ts";

export const signalCommand = define({
  name: "signal",
  description: "Manage workspace signals",
  rendering: { header: null },
  subCommands: {
    list: listCommand,
    ls: alias(listCommand),
    trigger: triggerCommand,
    fire: alias(triggerCommand),
    send: alias(triggerCommand),
  },
  run: () => {
    console.log("Usage: atlas signal <command>");
    console.log("");
    console.log("Commands:");
    console.log("  list, ls              List configured signals");
    console.log("  trigger, fire, send   Trigger a signal");
  },
});
