import { Box, Newline, Text, useInput } from "ink";
import { COMMAND_DEFINITIONS } from "../utils/command-definitions.ts";

export default function HelpCommand({ onExit }: { onExit: () => void }) {
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
          {COMMAND_DEFINITIONS.map((suggestion) => (
            <Text key={suggestion.command}>{suggestion.command}</Text>
          ))}
        </Box>
        <Box flexDirection="column" paddingLeft={1}>
          {COMMAND_DEFINITIONS.map((suggestion) => (
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
