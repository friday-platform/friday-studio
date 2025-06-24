import yargs from "yargs";
import { commands } from "./cli-2/commands/index.ts";

// Check for --version or -v flag before yargs processes commands
if (Deno.args.includes("--version") || Deno.args.includes("-v")) {
  const { displayVersion } = await import("./utils/version.ts");
  const jsonOutput = Deno.args.includes("--json");
  displayVersion(jsonOutput);
  Deno.exit(0);
}

// Build the CLI
const argv = await yargs(Deno.args)
  .scriptName("atlas")
  .usage("$0 <command> [options]")
  .command(commands)
  .help()
  .alias("help", "h")
  .version(false) // Disable default version handling since we handle it above
  .demandCommand(1, "You need to specify a command")
  .recommendCommands()
  .strict()
  .parseAsync();
