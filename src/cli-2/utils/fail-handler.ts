import {
  COMMANDS,
  findClosestCommand,
  formatSuggestions,
  isValidCommand,
  SUBCOMMANDS,
} from "./command-suggestions.ts";

/**
 * Custom fail handler for Yargs to provide better error messages and suggestions
 */
export function customFailHandler(
  msg: string,
  err: Error | null,
): void {
  // First check if this is a "not enough arguments" error
  if (msg.includes("Not enough non-option arguments")) {
    // Extract how many args were expected
    const match = msg.match(/got (\d+), need at least (\d+)/);
    if (match) {
      const got = match[1];
      const need = match[2];

      // Get the command path for context
      const denoArgs = Deno.args.filter((arg) => !arg.startsWith("-"));
      const commandPath = denoArgs.join(" ");

      console.error(`Error: Missing required argument for 'atlas ${commandPath}'`);
      console.error(`\nRun 'atlas ${commandPath} --help' for usage information.`);
      Deno.exit(1);
    }
  }

  // Extract the command from the error message or from arguments
  const unknownCommandMatch = msg.match(/Unknown arguments?: (.+)/);
  const commandNotFoundMatch = msg.match(/Unknown command: (.+)/);

  let unknownCommand: string | null = null;

  if (unknownCommandMatch) {
    unknownCommand = unknownCommandMatch[1].trim().split(/\s+/)[0];
  } else if (commandNotFoundMatch) {
    unknownCommand = commandNotFoundMatch[1].trim();
  }

  // Also try to get the command from Deno.args if not found in message
  if (!unknownCommand && Deno.args.length > 0) {
    // Skip any flags that start with -
    const firstNonFlag = Deno.args.find((arg) => !arg.startsWith("-"));
    if (firstNonFlag) {
      unknownCommand = firstNonFlag;
    }
  }

  // Check if this is a case of unknown subcommand
  // Only check this if it's not a "missing arguments" error
  if (!msg.includes("Not enough non-option arguments")) {
    try {
      // Try to get args from Deno.args for subcommand detection
      const denoArgs = Deno.args.filter((arg) => !arg.startsWith("-"));
      if (denoArgs.length >= 2) {
        const mainCommand = denoArgs[0];
        const subCommand = denoArgs[1];

        if (isValidCommand(mainCommand) && SUBCOMMANDS[mainCommand]) {
          // Check if the subcommand exists
          const validSubcommands = SUBCOMMANDS[mainCommand].map((sc) => sc.command);
          if (!validSubcommands.includes(subCommand)) {
            // This is an unknown subcommand
            const suggestions = findClosestCommand(subCommand, SUBCOMMANDS[mainCommand]);

            console.error(`Error: Unknown ${mainCommand} command: '${subCommand}'`);

            if (suggestions.length > 0) {
              console.error(formatSuggestions(suggestions));
            } else {
              console.error(`\nAvailable ${mainCommand} commands:`);
              for (const sub of SUBCOMMANDS[mainCommand]) {
                console.error(`  ${sub.command} - ${sub.description}`);
              }
              console.error(`\nRun 'atlas ${mainCommand} --help' for more information.`);
            }

            Deno.exit(1);
          }
        }
      }
    } catch {
      // If we can't parse args, fall through to main command handling
    }
  }

  // Handle unknown main command
  if (unknownCommand && !msg.includes("Not enough non-option arguments")) {
    const suggestions = findClosestCommand(unknownCommand, COMMANDS);

    console.error(`Error: Unknown command: '${unknownCommand}'`);
    console.error(formatSuggestions(suggestions));

    Deno.exit(1);
  }

  // For other errors, show the original message with help
  if (err) {
    console.error(`Error: ${err.message}`);
  } else if (msg) {
    // Clean up Yargs error messages
    const cleanMsg = msg
      .replace(/Unknown arguments?:/, "Unknown command:")
      .replace(/Not enough non-option arguments.*/, "You need to specify a command");

    console.error(`Error: ${cleanMsg}`);
  }

  console.error("\nRun 'atlas --help' for usage information.");
  Deno.exit(1);
}
