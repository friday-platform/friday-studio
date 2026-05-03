import type { CommandModule } from "yargs";
import * as artifactsCmd from "./artifacts/index.ts";
import * as chatCmd from "./chat.ts";
import * as daemonCmd from "./daemon.ts";
import * as inspectCmd from "./inspect.ts";
import * as logsCmd from "./logs.ts";
import * as migrateCmd from "./migrate.ts";
import * as promptCmd from "./prompt.ts";
import * as psCmd from "./ps.ts";
import * as resetCmd from "./reset.ts";
import * as sessionCmd from "./session.ts";

// Explicit type annotation to prevent type instantiation depth issues with yargs
// when TypeScript tries to infer the full union of 13+ command module types
export const commands: ReadonlyArray<CommandModule> = [
  sessionCmd,
  psCmd,
  artifactsCmd,
  daemonCmd,
  resetCmd,
  logsCmd,
  migrateCmd,
  promptCmd,
  chatCmd,
  inspectCmd,
];
