import { getAliasesHelp } from "./command-suggestions.ts";
import type { YargsInstance } from "./yargs.ts";

/**
 * Custom help formatter to add alias information and power user tips
 */
function customHelp(y: YargsInstance): string {
  // Get the default help
  let help = y.getHelp();

  // Add aliases section after the commands section
  const aliasesHelp = getAliasesHelp();

  // Find the Options section and insert aliases before it
  const optionsIndex = help.indexOf("Options:");
  if (optionsIndex !== -1) {
    help = help.slice(0, optionsIndex) + aliasesHelp + "\n\n" + help.slice(optionsIndex);
  } else {
    // If no Options section, append at the end
    help += "\n" + aliasesHelp;
  }

  return help;
}

/**
 * Add examples to the help output
 */
export function addExamples(y: YargsInstance): YargsInstance {
  return y
    .example("$0 work", "Start workspace server (using alias)")
    .example("$0 ps", "List active sessions (shortcut for 'session list')")
    .example("$0 sig trigger my-signal", "Trigger a signal")
    .example("$0 agent list --json", "List agents in JSON format")
    .example('$0 lib search "error handling"', "Search library content")
    .example("$0 workspace init my-project", "Initialize a new workspace")
    .example("$0 session get sess_abc123", "Get details for a specific session")
    .example("$0 logs sess_abc123 -f", "Follow session logs in real-time");
}
