import type { CommandModule } from "yargs";
import * as artifactsCmd from "./artifacts/index.ts";
import * as chatCmd from "./chat.ts";
import * as daemonCmd from "./daemon.ts";
import * as inspectCmd from "./inspect.ts";
import * as libraryCmd from "./library/index.ts";
import * as logsCmd from "./logs.ts";
import * as promptCmd from "./prompt.ts";
import * as psCmd from "./ps.ts";
import * as resetCmd from "./reset.ts";
import * as sessionCmd from "./session.ts";
import * as versionCmd from "./version.ts";

// Explicit type annotation to prevent type instantiation depth issues with yargs
// when TypeScript tries to infer the full union of 13+ command module types
export const commands: ReadonlyArray<CommandModule> = [
  versionCmd,
  sessionCmd,
  psCmd,
  libraryCmd,
  artifactsCmd,
  daemonCmd,
  resetCmd,
  logsCmd,
  promptCmd,
  chatCmd,
  inspectCmd,
];
