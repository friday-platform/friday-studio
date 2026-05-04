import process from "node:process";
import { stringifyError } from "@atlas/utils";

/**
 * CLI entry point — routes between native gunshi commands and legacy yargs commands.
 *
 * Native commands use gunshi with its default rendering (plain text, human-readable).
 * Legacy commands fall through to the old yargs CLI (cli.tsx) with existing behavior.
 * As commands are migrated to native gunshi, they move from LEGACY_COMMANDS to NATIVE_COMMANDS.
 */

const NATIVE_COMMANDS = new Set([
  "skill",
  "sk",
  "signal",
  "sig",
  "workspace",
  "work",
  "w",
  "agent",
  "ag",
]);

const LEGACY_COMMANDS = new Set([
  "prompt",
  "p",
  "chat",
  "ch",
  "ps",
  "logs",
  "log",
  "reset",
  "daemon",
  "d",
  "session",
  "sesh",
  "sess",
  "artifacts",
  "artifact",
  "inspect",
  "insp",
  "migrate",
]);

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd && NATIVE_COMMANDS.has(cmd)) {
  // Native gunshi path — let gunshi handle --help/--version flags naturally
  const { cli, define } = await import("gunshi");
  const { alias } = await import("./utils/alias.ts");
  const { skillCommand } = await import("./cli/commands/skill/index.ts");
  const { signalCommand } = await import("./cli/commands/signal/index.ts");
  const { workspaceCommand } = await import("./cli/commands/workspace/index.ts");
  const { agentCommand } = await import("./cli/commands/agent/index.ts");

  const mainCommand = define({
    name: "atlas",
    description: "Atlas CLI — AI agent orchestration platform",
    run: () => {},
  });

  try {
    await cli(argv, mainCommand, {
      name: "atlas",
      subCommands: {
        skill: skillCommand,
        sk: alias(skillCommand),
        signal: signalCommand,
        sig: alias(signalCommand),
        workspace: workspaceCommand,
        work: alias(workspaceCommand),
        w: alias(workspaceCommand),
        agent: agentCommand,
        ag: alias(agentCommand),
      },
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
