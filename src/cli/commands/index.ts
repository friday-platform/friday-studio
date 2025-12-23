import type { CommandModule } from "yargs";
import * as agentCmd from "./agent.ts";
import * as artifactsCmd from "./artifacts/index.ts";
import * as chatCmd from "./chat.ts";
import * as daemonCmd from "./daemon.ts";
import * as diagnosticsCmd from "./diagnostics.ts";
import * as libraryCmd from "./library/index.ts";
import * as logsCmd from "./logs.ts";
import * as promptCmd from "./prompt.ts";
import * as psCmd from "./ps.ts";
import * as resetCmd from "./reset.ts";
import * as serviceCmd from "./service.ts";
import * as sessionCmd from "./session.ts";
import * as signalCmd from "./signal.ts";
import * as updateCmd from "./update.tsx";
import * as versionCmd from "./version.ts";
import * as workspaceCmd from "./workspace.ts";

// Explicit type annotation to prevent type instantiation depth issues with yargs
// when TypeScript tries to infer the full union of 13+ command module types
export const commands: ReadonlyArray<CommandModule> = [
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
  logsCmd,
  promptCmd,
  chatCmd,
];
