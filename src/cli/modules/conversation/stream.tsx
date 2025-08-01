import { Box } from "ink";
// import { useEffect, useRef } from "react";
import { useResponsiveDimensions } from "../../utils/useResponsiveDimensions.ts";
import { ChatMessage } from "../../components/chat-message.tsx";
// import { useMarkdown } from "./use-markdown.ts";
import { OutputEntry } from "./types.ts";
import { MessageHeader } from "../../components/message-header.tsx";

interface StreamProps {
  value?: OutputEntry;
}

export function Stream({ value }: StreamProps) {
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });
  // const { height, markdown } = useMarkdown(value?.content || "");

  // const previousLinesCount = useRef(0);

  // Track when lines grow by 5 and call onChunk
  // useEffect(() => {
  //   if (!inProgressEntry) {
  //     previousLinesCount.current = 0;
  //     return;
  //   }

  //   // Check if content has grown by 5 lines since last chunk
  //   if (height > previousLinesCount.current + 5) {
  //     onChunk(inProgressEntry.type === "thinking" ? "thinking" : "text");
  //     previousLinesCount.current = height;
  //   }
  // }, [height, inProgressEntry, onChunk]);

  // Only show content if there's an entry in progress
  if (!value) {
    return null;
  }

  // Get only the latest 5 lines of the markdown output
  // const lines = markdown.split("\n");
  // const latestLines = lines.slice(-5).join("\n");

  return (
    <Box
      flexDirection="column"
      width={dimensions.width}
      flexShrink={0}
      paddingX={1}
    >
      <Box flexShrink={0} flexDirection="column" paddingTop={1}>
        {value.type === "thinking"
          ? (
            <ChatMessage
              message={value.content}
              hideHeader
              dimColor
              showCollapsible
            />
          )
          : (
            <>
              <MessageHeader
                author="Atlas"
                date={value.timestamp}
                authorColor="blue"
              />
              <ChatMessage
                author="Atlas"
                authorColor="blue"
                date={value.timestamp}
                message={value.content}
              />
            </>
          )}
      </Box>
    </Box>
  );
}
