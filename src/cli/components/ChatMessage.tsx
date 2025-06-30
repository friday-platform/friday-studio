import { Box, Text } from "ink";

// Chat Message Component
interface ChatMessageProps {
  author: string;
  date: string;
  message: string;
  authorColor?: string;
}

export const ChatMessage = ({
  author,
  date,
  message,
  authorColor = "blue",
}: ChatMessageProps) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={authorColor} bold>
          {author}
        </Text>
        <Text color={authorColor} dimColor bold>
          [{date}]
        </Text>
      </Box>
      <Box>
        <Text wrap="wrap" color="white">
          {message}
        </Text>
      </Box>
    </Box>
  );
};
