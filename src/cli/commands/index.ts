import * as agentCmd from "./agent.ts";
import * as cxCmd from "./cx-client.tsx";
import * as cxDevCmd from "./cx-dev.tsx";
import * as daemonCmd from "./daemon.ts";
import * as interactiveCmd from "./interactive.tsx";
import * as libraryCmd from "./library/index.ts";
import * as mcpCmd from "./mcp.ts";
import * as psCmd from "./ps.ts";
import * as sessionCmd from "./session.ts";
import * as signalCmd from "./signal.ts";
// import * as tuiCmd from "./tui.tsx";
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
  mcpCmd,
  daemonCmd,
  // tuiCmd,
  interactiveCmd,
  cxCmd,
  cxDevCmd,
];
