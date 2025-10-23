import yargs from "yargs";
import { commands } from "./cli/commands/index.ts";
import { customFailHandler } from "./cli/utils/fail-handler.ts";
import { addExamples } from "./cli/utils/help-formatter.ts";
import { checkAndDisplayUpdate } from "./utils/version-checker.ts";

// Check for --version or -v flag before yargs processes commands
if (Deno.args.includes("--version") || Deno.args.includes("-v")) {
  const { displayVersion } = await import("./utils/version.ts");
  const jsonOutput = Deno.args.includes("--json");
  displayVersion(jsonOutput);
  Deno.exit(0);
}

// Browser download moved to daemon initialization to avoid blocking CLI commands

// Build the CLI
const cli = yargs(Deno.args)
  .scriptName("atlas")
  .usage("$0 <command> [options]")
  .command(commands)
  .help()
  .alias("help", "h")
  .version(false) // Disable default version handling since we handle it above
  .demandCommand(1) // Require at least one command
  .recommendCommands()
  .strict()
  .fail(customFailHandler)
  .showHelpOnFail(false); // We'll handle this in our custom fail handler

// Add examples
addExamples(cli);

// Check for updates (non-blocking)
checkAndDisplayUpdate().catch(() => {
  // Silently ignore errors to avoid disrupting CLI usage
});

// Parse the commands
await cli.parseAsync();
