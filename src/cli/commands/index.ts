import * as agentCmd from "./agent.ts";
import * as artifactsCmd from "./artifacts/index.ts";
import * as daemonCmd from "./daemon.ts";
import * as diagnosticsCmd from "./diagnostics.ts";
import * as libraryCmd from "./library/index.ts";
import * as psCmd from "./ps.ts";
import * as resetCmd from "./reset.ts";
import * as serviceCmd from "./service.ts";
import * as sessionCmd from "./session.ts";
import * as signalCmd from "./signal.ts";
import * as updateCmd from "./update.tsx";
import * as versionCmd from "./version.ts";
import * as workspaceCmd from "./workspace.ts";

export const commands = [
  versionCmd,
  updateCmd,
  workspaceCmd,
  sessionCmd,
  psCmd,
  agentCmd,
  signalCmd,
  libraryCmd,
  artifactsCmd,
  daemonCmd,
  serviceCmd,
  diagnosticsCmd,
  resetCmd,
];
