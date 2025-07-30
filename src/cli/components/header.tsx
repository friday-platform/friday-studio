import { Box, Text } from "ink";

export function Header() {
  return (
    <Box flexDirection="column" flexShrink={0} height={6}>
      <Box flexDirection="row" alignItems="center">
        <Box flexDirection="column">
          <Text>╭───╮</Text>
          <Text>│&nbsp;∆&nbsp;│</Text>
          <Text>╰───╯</Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>&nbsp;Atlas.&nbsp;</Text>
        </Box>

        <Box flexDirection="column">
          <Text dimColor>Made by Tempest.</Text>
        </Box>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>⊕ /help for help</Text>
        <Text dimColor>∶ {Deno.cwd()}</Text>
      </Box>
    </Box>
  );
}
