import yargs from "yargs";
import { commands } from "./cli/commands/index.ts";
import { customFailHandler } from "./cli/utils/fail-handler.ts";
import { addExamples, customHelp } from "./cli/utils/help-formatter.ts";

// Check for --version or -v flag before yargs processes commands
if (Deno.args.includes("--version") || Deno.args.includes("-v")) {
  const { displayVersion } = await import("./utils/version.ts");
  const jsonOutput = Deno.args.includes("--json");
  displayVersion(jsonOutput);
  Deno.exit(0);
}

// Build the CLI
const cli = yargs(Deno.args)
  .scriptName("atlas")
  .usage("$0 <command> [options]")
  .command(commands)
  .help()
  .alias("help", "h")
  .version(false) // Disable default version handling since we handle it above
  .demandCommand(0) // Allow no command to trigger the interactive mode
  .recommendCommands()
  .strict()
  .fail(customFailHandler)
  .showHelpOnFail(false); // We'll handle this in our custom fail handler

// Add examples
addExamples(cli);

// Parse the commands
const argv = await cli.parseAsync();
