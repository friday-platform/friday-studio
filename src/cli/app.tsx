import React from "react";
import { Box, Newline, Text } from "ink";
import { WorkspaceCommand } from "./commands/workspace.tsx";
import { SessionCommand } from "./commands/session.tsx";
import { SignalCommand } from "./commands/signal.tsx";
import { AgentCommand } from "./commands/agent.tsx";
import { LogsCommand } from "./commands/logs.tsx";
import LibraryCommand from "./commands/library.tsx";
// import TUICommand from "./commands/tui.tsx";
import HelpCommand from "./commands/help.tsx";
import DefineCommand from "./commands/define.tsx";
import InteractiveCommand from "./commands/interactive.tsx";

interface AppProps {
  command: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, unknown>;
}

export default function App({ command, subcommand, args, flags }: AppProps) {
  // Handle no command - show interactive mode
  if (!command) {
    return <InteractiveCommand />;
  }

  // Handle help
  if (command === "help") {
    return <HelpCommand />;
  }

  // Route to appropriate command
  switch (command) {
    case "workspace":
      return (
        <WorkspaceCommand subcommand={subcommand} args={args} flags={flags} />
      );

    case "session":
      return (
        <SessionCommand subcommand={subcommand} args={args} flags={flags} />
      );

    case "signal":
      return (
        <SignalCommand subcommand={subcommand} args={args} flags={flags} />
      );

    case "agent":
      return <AgentCommand subcommand={subcommand} args={args} flags={flags} />;

    case "library":
      return (
        <LibraryCommand
          args={[subcommand, ...args].filter(Boolean)}
          flags={flags}
        />
      );

    case "logs":
      return <LogsCommand sessionId={subcommand || args[0]} flags={flags} />;

    case "define":
      return (
        <DefineCommand args={args} subcommand={subcommand} flags={flags} />
      );

    default:
      return (
        <Text color="red">
          Unknown command: {command}. Run 'atlas help' for usage.
        </Text>
      );
  }
}
