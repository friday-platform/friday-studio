import type { YargsInstance } from "./yargs.ts";

/**
 * Add examples to the help output
 */
export function addExamples(y: YargsInstance): YargsInstance {
  return y
    .example("$0 work", "Start workspace server (using alias)")
    .example("$0 ps", "List active sessions (shortcut for 'session list')")
    .example("$0 sig trigger my-signal", "Trigger a signal")
    .example("$0 agent list --json", "List agents in JSON format")
    .example("$0 workspace init my-project", "Initialize a new workspace")
    .example("$0 session get sess_abc123", "Get details for a specific session")
    .example("$0 logs sess_abc123 -f", "Follow session logs in real-time");
}
