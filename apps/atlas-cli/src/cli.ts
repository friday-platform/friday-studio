import process from "node:process";
import { getVersionInfo, stringifyError } from "@atlas/utils";

/**
 * CLI entry point — routes between native gunshi commands and legacy yargs commands.
 *
 * Native commands use gunshi with its default rendering (plain text, human-readable).
 * Legacy commands fall through to the old yargs CLI (cli.tsx) with existing behavior.
 * As commands are migrated to native gunshi, they move from LEGACY_COMMANDS to NATIVE_COMMANDS.
 */

const NATIVE_COMMANDS = new Set(["version", "v"]);

const LEGACY_COMMANDS = new Set([
  "prompt",
  "p",
  "chat",
  "ch",
  "ps",
  "logs",
  "log",
  "update",
  "reset",
  "daemon",
  "d",
  "session",
  "sesh",
  "sess",
  "workspace",
  "work",
  "w",
  "agent",
  "ag",
  "signal",
  "sig",
  "library",
  "lib",
  "artifacts",
  "artifact",
  "service",
  "svc",
]);

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd && NATIVE_COMMANDS.has(cmd)) {
  // Native gunshi path — let gunshi handle --help/--version flags naturally
  const { cli, define } = await import("gunshi");
  const { versionCommand } = await import("./cli/commands/version.ts");

  const mainCommand = define({
    name: "atlas",
    description: "Atlas CLI — AI agent orchestration platform",
    run: () => {},
  });

  try {
    await cli(argv, mainCommand, {
      name: "atlas",
      version: getVersionInfo().version,
      subCommands: { version: versionCommand, v: versionCommand },
    });
  } catch (error: unknown) {
    console.error(stringifyError(error));
    process.exit(1);
  }
} else if (!cmd || cmd.startsWith("-") || LEGACY_COMMANDS.has(cmd)) {
  // Legacy yargs path — existing behavior (human-readable + --json flag)
  await import("./cli.tsx");
} else {
  // Unknown command
  console.error(`Command not found: ${cmd}`);
  process.exit(1);
}
