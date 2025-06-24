import yargs from "yargs";
import { render } from "ink";
import TUICommand from "../../cli/commands/tui.tsx";

export const command = "tui";
export const desc = "Launch Terminal User Interface";
export const aliases = ["ui"];

export function builder(yargs: yargs.Argv) {
  return yargs
    .option("workspace", {
      alias: "w",
      type: "string",
      description: "Load specific workspace from examples directory",
    })
    .example("$0 tui", "Launch TUI in current directory")
    .example("$0 tui --workspace telephone-game", "Launch TUI with specific workspace")
    .epilogue(`
The Terminal User Interface (TUI) provides:
  • Real-time workspace monitoring
  • Interactive command execution
  • Log viewing and analysis
  • Signal triggering
  • Session management

Navigation:
  • Tab: Switch between tabs
  • j/k or arrows: Navigate logs
  • Enter: Execute commands
  • Ctrl+C: Exit
`);
}

export async function handler(argv: yargs.Arguments) {
  const flags = {
    workspace: argv.workspace as string | undefined,
  };

  render(<TUICommand flags={flags} />);
}
