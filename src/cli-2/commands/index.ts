import * as versionCmd from "./version.ts";
import * as workspaceCmd from "./workspace.ts";
import * as sessionCmd from "./session.ts";
import * as psCmd from "./ps.ts";
import * as agentCmd from "./agent.ts";
import * as signalCmd from "./signal.ts";
import * as libraryCmd from "./library/index.ts";
import * as logsCmd from "./logs.tsx";
import * as tuiCmd from "./tui.tsx";
import * as interactiveCmd from "./interactive.tsx";

export const commands = [
  versionCmd,
  workspaceCmd,
  sessionCmd,
  psCmd,
  agentCmd,
  signalCmd,
  libraryCmd,
  logsCmd,
  tuiCmd,
  interactiveCmd,
];
