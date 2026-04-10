import { define } from "gunshi";
import { alias } from "../../../utils/alias.ts";
import { buildCommand } from "./build.ts";
import { describeCommand } from "./describe.ts";
import { execCommand } from "./exec.ts";
import { listCommand } from "./list.tsx";

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
    build: buildCommand,
    b: alias(buildCommand),
    exec: execCommand,
    x: alias(execCommand),
  },
  run: () => {
    console.log("Usage: atlas agent <command>");
    console.log("");
    console.log("Commands:");
    console.log("  list, ls              List agents");
    console.log("  describe, show, get   View agent details");
    console.log("  build, b              Build a Python WASM agent");
    console.log("  exec, x              Execute an agent via playground");
  },
});
