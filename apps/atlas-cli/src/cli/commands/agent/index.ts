import { define } from "gunshi";
import { alias } from "../../../utils/alias.ts";
import { describeCommand } from "./describe.ts";
import { execCommand } from "./exec.ts";
import { listCommand } from "./list.tsx";
import { registerCommand } from "./register.ts";

export const agentCommand = define({
  name: "agent",
  description: "Manage agents",
  rendering: { header: null },
  subCommands: {
    list: listCommand,
    ls: alias(listCommand),
    describe: describeCommand,
    show: alias(describeCommand),
    get: alias(describeCommand),
    register: registerCommand,
    r: alias(registerCommand),
    exec: execCommand,
    x: alias(execCommand),
  },
  run: () => {
    console.log("Usage: atlas agent <command>");
    console.log("");
    console.log("Commands:");
    console.log("  list, ls              List agents");
    console.log("  describe, show, get   View agent details");
    console.log("  register, r           Register an SDK agent");
    console.log("  exec, x              Execute an agent via playground");
  },
});
