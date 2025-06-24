import * as versionCmd from "./version.ts";
import * as workspaceCmd from "./workspace.ts";
import * as sessionCmd from "./session.ts";
import * as psCmd from "./ps.ts";
import * as agentCmd from "./agent.ts";
import * as signalCmd from "./signal.ts";

// Export all commands as an array
export const commands = [
  versionCmd,
  workspaceCmd,
  sessionCmd,
  psCmd,
  agentCmd,
  signalCmd,
];
