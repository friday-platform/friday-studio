import { useEffect, useRef, useState } from "react";
import { Box, Static } from "ink";
import { useAppContext } from "../contexts/app-context.tsx";
import { ChatMessage } from "./chat-message.tsx";
import { OutputEntry } from "../modules/conversation/types.ts";
import { Header } from "./header.tsx";
import { MessageHeader } from "./message-header.tsx";
import { Spinner } from "@inkjs/ui";
import { DAEMON_STATUS } from "../constants/daemon-status.ts";
import { type SSEEvent, SSEEventSchema } from "@atlas/config";

interface TypingState {
  isTyping: boolean;
  elapsedSeconds: number;
  message?: string;
}

export const MessageBuffer = () => {
  const {
    conversationClient,
    conversationSessionId,
    sseAbortControllerRef,
    staticKey,
    setDaemonStatusState,
  } = useAppContext();
  const sseListenerStarted = useRef(false);
  const [sseStream, setSseStream] = useState<AsyncIterable<unknown> | null>(
    null,
  );

  const [sseMessages, setSseMessages] = useState<Map<string, SSEEvent>>(
    new Map(),
  );
  const [output, setOutput] = useState<OutputEntry[]>([]);

  const [typingState, setTypingState] = useState<TypingState>({
    isTyping: false,
    elapsedSeconds: 0,
  });

  // Create SSE stream when conversation session is ready
  useEffect(() => {
    if (
      !conversationClient ||
      !conversationSessionId ||
      !conversationClient.sseUrl
    ) {
      return;
    }

    const connectSSE = () => {
      // Create new abort controller for this connection
      if (!sseAbortControllerRef.current) {
        sseAbortControllerRef.current = new AbortController();
      }

      // Start SSE stream
      const sseIterator = conversationClient.streamEvents(
        conversationSessionId,
        conversationClient.sseUrl,
        sseAbortControllerRef.current?.signal,
      );
      setSseStream(sseIterator);
      sseListenerStarted.current = false; // Reset listener flag for new stream
    };

    connectSSE();

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
            !errorMessage.includes("aborted") &&
            !errorMessage.includes("Bad resource ID")
          ) {
            // Stop the thinking spinner immediately when connection is lost
            setTypingState({
              isTyping: false,
              elapsedSeconds: 0,
            });

            // Handle daemon connection loss with user-friendly message
            if (errorMessage.includes("Connection to Atlas daemon lost")) {
              setDaemonStatusState(DAEMON_STATUS.UNHEALTHY);
            } else if (
              errorMessage.includes("Network connection to Atlas daemon failed")
            ) {
              setDaemonStatusState(DAEMON_STATUS.UNHEALTHY);
            } else {
              // Any other SSE error means connection is lost - always notify and reconnect
              console.error("SSE connection error:", errorMessage);
              setDaemonStatusState(DAEMON_STATUS.UNHEALTHY);
            }
          }
        }
      }
    })();

    // Cleanup function
    return () => {
      sseListenerStarted.current = false;
    };
  }, [sseStream, sseAbortControllerRef]);

  function formatMessage(messages: SSEEvent[]): OutputEntry | undefined {
    const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME") || "You";

    const firstMessage = messages[0];

    if (!firstMessage) {
      return;
    }

    const normalizedType = firstMessage.type;
    return {
      id: firstMessage.id,
      type: normalizedType as OutputEntry["type"],
      timestamp: firstMessage.timestamp,
      author: normalizedType === "text" ? "Atlas" : currentUser,
      content: messages.map((message) => message.data.content).join(""),
    };
  }

  function getGroupedMessages(messageValues: SSEEvent[]) {
    // Group messages by ID
    return messageValues.reduce(
      (groups, message) => {
        const id = message.id;
        if (!groups[id]) {
          groups[id] = [];
        }

        groups[id].push(message);

        return groups;
      },
      {} as Record<string, SSEEvent[]>,
    );
  }

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    if (typingState.isTyping) {
      interval = setInterval(() => {
        setTypingState((prev) => ({
          ...prev,
          elapsedSeconds: prev.elapsedSeconds + 1,
        }));
      }, 1000);
    } else {
      if (interval) {
        clearInterval(interval);
      }
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [typingState, setTypingState]);

  useEffect(() => {
    const messageValues: SSEEvent[] = Array.from(sseMessages.values());

    // Get the latest message to check if it's streaming
    const latestMessage = messageValues[messageValues.length - 1];

    if (latestMessage?.type === "request") {
      setTypingState({
        isTyping: true,
        elapsedSeconds: 0,
      });
    }

    if (latestMessage?.type === "finish" || latestMessage?.type === "error") {
      setTypingState({
        isTyping: false,
        elapsedSeconds: 0,
      });
    }

    if (latestMessage?.type === "text" || latestMessage?.type === "thinking") {
      const staticMessages = getGroupedMessages(
        messageValues.filter((message) => message.id !== latestMessage.id),
      );

      setOutput(
        (Object.values(staticMessages) as SSEEvent[][])
          .map((messages: SSEEvent[]) => formatMessage(messages))
          .filter((message) => message !== undefined),
      );
    } else {
      const groupedMessages = getGroupedMessages(messageValues);

      setOutput(
        (Object.values(groupedMessages) as SSEEvent[][])
          .map((messages: SSEEvent[]) => formatMessage(messages))
          .filter((message) => message !== undefined),
      );
    }
  }, [sseMessages]);

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

      {typingState.isTyping && (
        <Box paddingX={1} paddingTop={1} flexShrink={0}>
          <Spinner label={`Thinking... (${typingState.elapsedSeconds}s)`} />
        </Box>
      )}
    </Box>
  );
};
