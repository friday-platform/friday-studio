import { Box, Text } from "ink";
import { MessageHeader } from "./message-header.tsx";

export function Header() {
  return (
    <Box flexDirection="column" flexShrink={0} height={8}>
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

      <Box paddingLeft={2} flexDirection="column">
        <MessageHeader author="Atlas" date={new Date().toISOString()} authorColor="blue" />
        <Text>Welcome to Atlas! What can I help you build?</Text>
        <Text dimColor>Hint: You can drag and drop files to attach them to your message.</Text>
      </Box>
    </Box>
  );
}
