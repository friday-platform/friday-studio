import { Text } from "ink";
import { useEffect, useState } from "react";
import { AgentCommand } from "./commands/agent.tsx";
import DefineCommand from "./commands/define.tsx";
import HelpCommand from "./commands/help.tsx";
import InteractiveCommand from "./commands/interactive.tsx";
import LibraryCommand from "./commands/library.tsx";
import VersionCommand from "./commands/version.tsx";
import { LogsCommand } from "./commands/logs.tsx";
import { SessionCommand } from "./commands/session.tsx";
import { SignalCommand } from "./commands/signal.tsx";
import { WorkspaceCommand } from "./commands/workspace.tsx";
import { getWorkspaceRegistry } from "../core/workspace-registry.ts";

interface AppProps {
  command: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, unknown>;
}

export default function App({ command, subcommand, args, flags }: AppProps) {
  const [migrationComplete, setMigrationComplete] = useState(false);

  useEffect(() => {
    // Initialize workspace registry on every command execution
    (async () => {
      try {
        const registry = getWorkspaceRegistry();
        await registry.initialize();
        setMigrationComplete(true);
      } catch (error) {
        console.error("Failed to initialize workspace registry:", error);
        setMigrationComplete(true); // Continue anyway
      }
    })();
  }, []);

  // Wait for migration to complete
  if (!migrationComplete) {
    return <Text>Initializing workspace registry...</Text>;
  }

  // Handle no command - show interactive mode
  if (!command) {
    return <InteractiveCommand />;
  }

  // Handle help
  if (command === "help") {
    return <HelpCommand />;
  }

  // Handle version
  if (command === "version") {
    return <VersionCommand flags={flags} />;
  }

  // Route to appropriate command
  switch (command) {
    case "workspace":
      return <WorkspaceCommand subcommand={subcommand} args={args} flags={flags} />;

    case "session":
      return <SessionCommand subcommand={subcommand} args={args} flags={flags} />;

    case "signal":
      return <SignalCommand subcommand={subcommand} args={args} flags={flags} />;

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
      return <DefineCommand args={args} subcommand={subcommand} flags={flags} />;

    // case "tui":
    //   return <TUICommand workspaceSlug={flags.workspace as string} />;

    default:
      return (
        <Text color="red">
          Unknown command: {command}. Run 'atlas help' for usage.
        </Text>
      );
  }
}
