import React from "react";
import { Box, Newline, Text } from "ink";
import { WorkspaceCommand } from "./commands/workspace.tsx";
import { SessionCommand } from "./commands/session.tsx";
import { SignalCommand } from "./commands/signal.tsx";
import { AgentCommand } from "./commands/agent.tsx";
import { LogsCommand } from "./commands/logs.tsx";

interface AppProps {
  command: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, any>;
}

export default function App({ command, subcommand, args, flags }: AppProps) {
  // Handle help
  if (!command || command === "help") {
    return <HelpComponent />;
  }

  // Route to appropriate command
  switch (command) {
    case "workspace":
    case "work": // Support both
      return <WorkspaceCommand subcommand={subcommand} args={args} flags={flags} />;

    case "session":
    case "sesh": // Support both
    case "sess": // Support both
      return <SessionCommand subcommand={subcommand} args={args} flags={flags} />;

    case "ps": // Alias for session list
      return <SessionCommand subcommand="list" args={args} flags={flags} />;

    case "signal":
    case "sig": // Support both
      return (
        <SignalCommand
          subcommand={subcommand}
          args={args}
          flags={flags}
        />
      );

    case "agent":
      return <AgentCommand subcommand={subcommand} args={args} flags={flags} />;

    case "logs":
    case "log": // Support both
      return <LogsCommand sessionId={subcommand || args[0]} flags={flags} />;

    default:
      return (
        <Text color="red">
          Unknown command: {command}. Run 'atlas help' for usage.
        </Text>
      );
  }
}

function HelpComponent() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Atlas - AI Agent Orchestration Platform</Text>
      <Newline />
      <Text bold>Usage:</Text>
      <Text>atlas &lt;command&gt; [subcommand] [options]</Text>
      <Newline />
      <Text bold>Quick Commands:</Text>
      <Text>work Start workspace server (default)</Text>
      <Text>work init Initialize new workspace</Text>
      <Text>work status Show workspace status</Text>
      <Newline />
      <Text>sig &lt;name&gt; -d '{`{}`}' Trigger a signal</Text>
      <Text>sig list List all signals</Text>
      <Newline />
      <Text>sesh List active sessions</Text>
      <Text>sesh get &lt;id&gt; Show session details</Text>
      <Text>ps List active sessions</Text>
      <Newline />
      <Text>agent List all agents</Text>
      <Text>logs &lt;id&gt; Stream session logs</Text>
      <Newline />
      <Text bold>Full Commands:</Text>
      <Text color="gray">workspace init [name] Initialize a new workspace</Text>
      <Text color="gray">workspace serve Start workspace server</Text>
      <Text color="gray">workspace list List all workspaces</Text>
      <Text color="gray">workspace status Show workspace status</Text>
      <Newline />
      <Text color="gray">session list List all active sessions</Text>
      <Text color="gray">session get &lt;id&gt; Show session details</Text>
      <Text color="gray">
        session cancel &lt;id&gt; Cancel a running session
      </Text>
      <Newline />
      <Text color="gray">signal list List all signals</Text>
      <Text color="gray">
        signal trigger &lt;name&gt; -d Trigger a signal with data
      </Text>
      <Text color="gray">signal history Show signal history</Text>
      <Newline />
      <Text color="gray">agent list List all agents</Text>
      <Text color="gray">agent describe &lt;name&gt; Show agent details</Text>
      <Text color="gray">agent test &lt;name&gt; -m Test an agent</Text>
      <Newline />
      <Text dimColor italic>
        Pro tip: Use w, s, x, a, l for even faster access
      </Text>
      <Newline />
      <Text bold>Examples:</Text>
      <Text color="gray">atlas workspace init my-project</Text>
      <Text color="gray">atlas workspace serve</Text>
      <Text color="gray">
        atlas signal trigger telephone-message --data '{`{"message": "Hello"}`}'
      </Text>
      <Text color="gray">atlas ps</Text>
      <Text color="gray">atlas logs sess_abc123</Text>
    </Box>
  );
}
