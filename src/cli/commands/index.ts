import * as agentCmd from "./agent.ts";
import * as daemonCmd from "./daemon.ts";
import * as interactiveCmd from "./interactive.tsx";
import * as libraryCmd from "./library/index.ts";
import * as psCmd from "./ps.ts";
import * as serviceCmd from "./service.ts";
import * as sessionCmd from "./session.ts";
import * as signalCmd from "./signal.ts";
import * as versionCmd from "./version.ts";
import * as workspaceCmd from "./workspace.ts";

export const commands = [
  versionCmd,
  workspaceCmd,
  sessionCmd,
  psCmd,
  agentCmd,
  signalCmd,
  libraryCmd,
  daemonCmd,
  serviceCmd,
  interactiveCmd,
];
