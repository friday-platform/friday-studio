import yargs from "yargs";
import { render } from "ink";
import InteractiveCommand from "../../cli/commands/interactive.tsx";

export const command = "$0";
export const desc = "Launch interactive Atlas interface";

export function builder(yargs: yargs.Argv) {
  return yargs
    .example("$0", "Launch interactive Atlas interface")
    .epilogue("The interactive interface provides a user-friendly way to manage workspaces");
}

export async function handler() {
  render(<InteractiveCommand />);
}
