import yargs from "yargs";
import { commands } from "./commands/index.ts";
import { customFailHandler } from "./utils/fail-handler.ts";
import { addExamples } from "./utils/help-formatter.ts";

// Build the CLI
const cli = yargs(Deno.args)
  .scriptName("atlas")
  .usage("$0 <command> [options]")
  .command(commands)
  .help()
  .alias("help", "h")
  .version(false) // No version output — version surface intentionally removed
  .demandCommand(1) // Require at least one command
  .recommendCommands()
  .strict()
  .fail(customFailHandler)
  .showHelpOnFail(false); // We'll handle this in our custom fail handler

// Add examples
addExamples(cli);

// Parse the commands
await cli.parseAsync();
