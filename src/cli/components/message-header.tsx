import { Box, Text } from "ink";

function generateTimestamp(date: string) {
  const now = new Date(date);
  return now
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s/g, "");
}

export function MessageHeader({
  author,
  date,
  authorColor,
}: {
  author?: string;
  date?: string;
  authorColor: string;
}) {
  return (
    <>
      <Box height={1}></Box>
      <Box flexDirection="row" gap={1} height={1} flexShrink={0}>
        {author && (
          <Text color={authorColor} bold>
            {author}
          </Text>
        )}
        {date && (
          <Text color={authorColor} dimColor bold>
            [{generateTimestamp(date)}]
          </Text>
        )}
      </Box>
    </>
  );
}
