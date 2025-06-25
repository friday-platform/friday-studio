import { Box, Newline, Text, useInput } from "ink";

export default function HelpCommand({ onExit }: { onExit: () => void }) {
  const commands = [
    {
      command: "/help",
      description: "Show available commands and usage information",
    },
    {
      command: "/list",
      description: "View workspaces, sessions, signals, agents, and library items",
    },
    { command: "/init", description: "Initialize a new workspace" },
    { command: "/sessions", description: "View available workspace sessions" },
    {
      command: "/signals",
      description: "View available workspace signals",
    },
    { command: "/agents", description: "View workspace agents" },
    {
      command: "/library",
      description: "View available workspace artifacts",
    },
    { command: "/config", description: "Atlas configuration settings" },
    { command: "/logs", description: "View workspace logs" },
    { command: "/exit", description: "Exit the Atlas interactive interface" },
  ];
  useInput((_, key) => {
    if (key.return) {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Modes</Text>
      <Text>• Interactive: atlas</Text>
      <Text>• Command Line: atlas {`<command>`}</Text>

      <Newline />

      <Text bold>Commands:</Text>

      <Box flexDirection="row" marginTop={1}>
        <Box flexDirection="column" marginRight={1}>
          {commands.map((suggestion) => <Text key={suggestion.command}>{suggestion.command}</Text>)}
        </Box>
        <Box flexDirection="column" paddingLeft={1}>
          {commands.map((suggestion) => (
            <Text key={`${suggestion.command}-desc`} dimColor>
              {suggestion.description}
            </Text>
          ))}
        </Box>
      </Box>

      <Newline />

      <Text bold>Press enter to continue...</Text>
    </Box>
  );
}
