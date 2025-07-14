import { Box, Text } from "ink";
import { MarkdownDisplay } from "./markdown-display.tsx";

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
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={authorColor} bold>
          {author}
        </Text>
        <Text color={authorColor} dimColor bold>
          [{date}]
        </Text>
      </Box>

      <MarkdownDisplay content={message} />
    </Box>
  );
};
