import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useStdout } from "ink";
import { z } from "zod/v4";
import { useAppContext } from "../contexts/app-context.tsx";
import { ChatMessage } from "./chat-message.tsx";
// import { GitDiff } from "./git-diff.tsx";
// import { MultiSelect } from "./multi-select.tsx";
// import { DirectoryTree } from "./directory-tree.tsx";
import { Stream } from "../modules/conversation/stream.tsx";
import { OutputEntry } from "../modules/conversation/types.ts";
import { Header } from "./header.tsx";
import { MessageHeader } from "./message-header.tsx";
import ansiEscapes from "ansi-escapes";
import { Spinner } from "@inkjs/ui";

const RequestEventSchema = z.object({
  id: z.string(),
  type: z.literal("request"),
  data: z.object({
    content: z.string(),
  }),
  timestamp: z.string(),
});

const MessageEventSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  data: z.object({
    content: z.string(),
  }),
  timestamp: z.string(),
});

const FinishEventSchema = z.object({
  id: z.string(),
  type: z.literal("finish"),
  data: z.object({
    content: z.string(),
  }),
  timestamp: z.string(),
});

const ErrorEventSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  data: z.object({
    content: z.string(),
  }),
  timestamp: z.string(),
});

// const SelectionListEventSchema = z.object({
//   type: z.literal("selection_list"),
//   data: z.object({
//     label: z.string(),
//     options: z.array(
//       z.object({
//         label: z.string(),
//         value: z.string(),
//       })
//     ),
//   }),
//   timestamp: z.string(),
// });

// const FileDiffEventSchema = z.object({
//   type: z.literal("file_diff"),
//   data: z.object({
//     diffContent: z.string(),
//     startingLine: z.number(),
//     endingLine: z.number(),
//     message: z.string(),
//   }),
//   timestamp: z.string(),
// });

// type DirectoryNode = {
//   name: string;
//   type: "file" | "directory";
//   active?: boolean;
//   children?: Array<DirectoryNode>;
// };

// // Define the recursive directory node schema
// const DirectoryNodeSchema: z.ZodType<DirectoryNode> = z.object({
//   name: z.string(),
//   type: z.enum(["file", "directory"]),
//   active: z.boolean().optional(),
//   children: z.array(z.lazy(() => DirectoryNodeSchema)).optional(),
// });

// const DirectoryListingEventSchema = z.object({
//   type: z.literal("directory_listing"),
//   data: z.object({
//     tree: z.lazy(() => DirectoryNodeSchema),
//   }),
//   timestamp: z.string(),
// });

const ToolCallEventSchema = z.object({
  id: z.string(),
  type: z.literal("tool_call"),
  data: z.object({
    content: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    toolCallId: z.string().optional(),
  }),
  timestamp: z.string(),
});

const ToolResultEventSchema = z.object({
  id: z.string(),
  type: z.literal("tool_result"),
  data: z.object({
    content: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    toolCallId: z.string().optional(),
  }),
  timestamp: z.string(),
});

const ThinkingEventSchema = z.object({
  id: z.string(),
  type: z.literal("thinking"),
  data: z.object({
    content: z.string(),
  }),
  timestamp: z.string(),
});

const SSEEventSchema = z.union([
  RequestEventSchema,
  FinishEventSchema,
  MessageEventSchema,
  ErrorEventSchema,
  // SelectionListEventSchema,
  // FileDiffEventSchema,
  // DirectoryListingEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ThinkingEventSchema,
]);

export const MessageBuffer = () => {
  const {
    config,
    conversationClient,
    conversationSessionId,
    // outputBuffer,
    // setOutputBuffer,
    typingState,
    setTypingState,
    sseAbortControllerRef,
    isCollapsed,
  } = useAppContext();
  const sseListenerStarted = useRef(false);
  const [sseStream, setSseStream] = useState<AsyncIterable<unknown> | null>(
    null,
  );

  const [sseMessages, setSseMessages] = useState<
    Map<string, ReturnType<typeof SSEEventSchema.parse>>
  >(new Map());
  // const [streamIsPaused, setStreamIsPaused] = useState(false);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [stream, setStream] = useState<OutputEntry | undefined>();
  const [interval, setIntervalValue] = useState<
    ReturnType<
      typeof setInterval
    > | null
  >(null);
  const [staticKey, setStaticKey] = useState(0);
  const { stdout } = useStdout();

  const refreshStatic = useCallback(() => {
    stdout.write(ansiEscapes.clearTerminal);
    setStaticKey((prev) => prev + 1);
  }, [setStaticKey, stdout]);

  useEffect(() => {
    refreshStatic();
  }, [isCollapsed]);

  // Create SSE stream when conversation session is ready
  useEffect(() => {
    if (
      !conversationClient ||
      !conversationSessionId ||
      !conversationClient.sseUrl
    ) {
      return;
    }

    // Start SSE stream
    const sseIterator = conversationClient.streamEvents(
      conversationSessionId,
      conversationClient.sseUrl,
      sseAbortControllerRef.current?.signal,
    );
    setSseStream(sseIterator);

    return () => {
      // Clean up SSE connection
      if (sseAbortControllerRef.current) {
        sseAbortControllerRef.current.abort();
        sseAbortControllerRef.current = null;
      }

      setSseStream(null);
    };
  }, [conversationClient, conversationSessionId, sseAbortControllerRef]);

  useEffect(() => {
    if (!sseStream || sseListenerStarted.current) return;

    sseListenerStarted.current = true;

    (async () => {
      try {
        for await (const event of sseStream) {
          if (sseAbortControllerRef.current?.signal.aborted) break;

          // Parse and validate SSE events with Zod
          const parseResult = SSEEventSchema.safeParse(event);

          if (!parseResult.success) {
            continue; // Skip invalid events
          }

          setSseMessages((prev) => {
            const newMap = new Map(prev);
            newMap.set(parseResult.data.timestamp, parseResult.data);
            return newMap;
          });
        }
      } catch (error) {
        // SSE connection closed or error
        // Only log if it's not an intentional abort
        if (!sseAbortControllerRef.current?.signal.aborted) {
          // Check if the error is due to abort signal
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            !errorMessage.includes("signal has been aborted") &&
            !errorMessage.includes("aborted")
          ) {
            console.error("SSE error:", error);
          }
        }
      }
    })();

    // Cleanup function
    return () => {
      sseListenerStarted.current = false;
    };
  }, [sseStream, sseAbortControllerRef]);

  function formatMessage(
    messages: ReturnType<typeof SSEEventSchema.parse>[],
  ): OutputEntry | undefined {
    const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME") || "You";

    const firstMessage = messages[0];

    if (!firstMessage) {
      return;
    }

    return {
      id: firstMessage.id,
      type: firstMessage.type,
      timestamp: firstMessage.timestamp,
      author: firstMessage.type === "text" ? "Atlas" : currentUser,
      content: messages.map((message) => message.data.content).join(""),
    };
  }

  function getGroupedMessages(
    messageValues: ReturnType<typeof SSEEventSchema.parse>[],
  ) {
    // Group messages by ID
    return messageValues.reduce((groups, message) => {
      const id = message.id;
      if (!groups[id]) {
        groups[id] = [];
      }

      groups[id].push(message);

      return groups;
    }, {} as Record<string, typeof messageValues>);
  }

  useEffect(() => {
    if (typingState.isTyping && !interval) {
      setIntervalValue(
        setInterval(() => {
          setTypingState((prev) => ({
            ...prev,
            elapsedSeconds: prev.elapsedSeconds + 1,
          }));
        }, 1000),
      );
    }

    return () => {
      if (interval) {
        clearInterval(interval);
        setIntervalValue(null);
      }
    };
  }, [typingState.isTyping]);

  useEffect(() => {
    const messageValues = Array.from(sseMessages.values());

    // Get the latest message to check if it's streaming
    const latestMessage = messageValues[messageValues.length - 1];

    if (
      latestMessage &&
      latestMessage.type === "text" &&
      typingState.isTyping
    ) {
      setTypingState((prev) => ({ ...prev, isTyping: false }));
      setIntervalValue(null);
    }

    if (
      latestMessage &&
      (latestMessage.type === "text" || latestMessage.type === "thinking")
    ) {
      const streamingMessages = getGroupedMessages(
        messageValues.filter((message) => message.id === latestMessage.id),
      );

      const staticMessages = getGroupedMessages(
        messageValues.filter((message) => message.id !== latestMessage.id),
      );

      setStream(
        Object.values(streamingMessages)
          .map(formatMessage)
          .filter((message) => message !== undefined)[0],
      );

      setOutput(
        Object.values(staticMessages)
          .map(formatMessage)
          .filter((message) => message !== undefined),
      );
    } else {
      const groupedMessages = getGroupedMessages(messageValues);

      setOutput(
        Object.values(groupedMessages)
          .map(formatMessage)
          .filter((message) => message !== undefined),
      );

      setStream(undefined);
    }

    if (latestMessage && latestMessage.type === "finish") {
      setTypingState((prev) => ({ ...prev, isTyping: false }));
      setIntervalValue(null);
    }
  }, [
    sseMessages,
    typingState.isTyping,
    interval,
    setTypingState,
    setIntervalValue,
  ]);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Static
        key={staticKey}
        items={[
          {
            type: "header",
            id: "atlas-header",
            content: "",
          } as unknown as OutputEntry,
          ...output,
        ].map((entry) => {
          if (entry.type === "header") {
            return <Header key="header" />;
          }

          if (entry.type === "request") {
            return (
              <Box
                key={entry.id}
                flexShrink={0}
                paddingX={2}
                flexDirection="column"
              >
                <Box height={1} />
                <MessageHeader
                  author={entry.author}
                  date={entry.timestamp}
                  authorColor="green"
                />

                <ChatMessage
                  message={entry.content}
                  author={entry.author}
                  authorColor="green"
                  date={entry.timestamp}
                  fixedHeight
                />
              </Box>
            );
          }

          // response
          if (entry.type === "text") {
            return (
              <Box
                key={entry.id}
                flexShrink={0}
                paddingX={2}
                flexDirection="column"
              >
                <Box height={1} />
                <MessageHeader
                  author="Atlas"
                  date={entry.timestamp}
                  authorColor="blue"
                />

                <ChatMessage
                  message={entry.content}
                  author={entry.author}
                  authorColor="blue"
                  date={entry.timestamp}
                  fixedHeight
                />
              </Box>
            );
          }

          if (entry.type === "thinking") {
            return (
              <Box
                key={entry.id}
                flexShrink={0}
                paddingX={2}
                flexDirection="column"
              >
                <Box height={1} />
                <ChatMessage
                  message={entry.content}
                  hideHeader
                  dimColor
                  fixedHeight
                  showCollapsible
                />
              </Box>
            );
          }

          if (entry.type === "tool_call" || entry.type === "tool_result") {
            return (
              <Box
                key={entry.id}
                flexShrink={0}
                paddingX={2}
                flexDirection="column"
              >
                <Box height={1} />
                <ChatMessage
                  message={entry.content}
                  dimColor
                  showCollapsible
                  hideHeader
                  fixedHeight
                />
              </Box>
            );
          }

          if (entry.type === "error") {
            return (
              <Box
                key={entry.id}
                flexShrink={0}
                paddingX={2}
                flexDirection="column"
              >
                <Box height={1} />
                <ChatMessage
                  message={entry.content}
                  hideHeader
                  author="Error"
                  authorColor="red"
                  date={entry.timestamp}
                  fixedHeight
                  showCollapsible
                />
              </Box>
            );
          }

          return null;
        })}
      >
        {(item) => item}
      </Static>

      <Stream value={stream} />

      {/* Typing indicator */}
      {typingState.isTyping && (
        <Box paddingX={1} paddingTop={1}>
          <Spinner
            label={`${typingState.message || "Thinking..."} (${typingState.elapsedSeconds}s)`}
          />
        </Box>
      )}
    </Box>
  );
};
