import type { SessionUIMessageChunk } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { readUIMessageStream, type UIDataTypes, type UIMessage, type UITools } from "ai";
import { Box, Static } from "ink";
import { useEffect, useRef, useState } from "react";
import { ChatMessage } from "../../components/chat-message.tsx";
import { Header } from "../../components/header.tsx";
import { MessageHeader } from "../../components/message-header.tsx";
import { Progress } from "../../components/progress.tsx";
import { DAEMON_STATUS } from "../../constants/daemon-status.ts";
import { useAppContext } from "../../contexts/app-context.tsx";
import type { OutputEntry } from "../conversation/types.ts";
import { ToolCall } from "./components/tool-call.tsx";
import { formatMessage } from "./utils.ts";

interface TypingState {
  isTyping: boolean;
  elapsedSeconds: number;
}

export const MessageBuffer = () => {
  const {
    conversationClient,
    conversationSessionId,
    sseAbortControllerRef,
    staticKey,
    setDaemonStatusState,
    setAtlasSessionId,
  } = useAppContext();
  const sseListenerStarted = useRef(false);

  const [sseStream, setSseStream] = useState<ReadableStream<SessionUIMessageChunk> | null>(null);
  const [sseMessages, setSseMessages] = useState<UIMessage<unknown, UIDataTypes, UITools>>();
  const [output, setOutput] = useState<OutputEntry[]>([]);

  const [typingState, setTypingState] = useState<TypingState>({
    isTyping: false,
    elapsedSeconds: 0,
  });

  // Create SSE stream when conversation session is ready
  useEffect(() => {
    if (!conversationClient || !conversationSessionId || !conversationClient.sseUrl) {
      return;
    }

    // Create new abort controller for this connection
    if (!sseAbortControllerRef.current) {
      sseAbortControllerRef.current = new AbortController();
    }

    // Use the new ReadableStream method
    const stream = conversationClient.createMessageStream(
      conversationClient.sseUrl,
      conversationSessionId,
      sseAbortControllerRef.current?.signal,
    );
    setSseStream(stream);
    sseListenerStarted.current = false; // Reset listener flag for new stream

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
        for await (const uiMessage of readUIMessageStream({ stream: sseStream })) {
          uiMessage.parts.forEach((part) => {
            if (part.type === "data-session-start") {
              // Capture the Atlas session ID
              if (part.data && typeof part.data === "object" && "sessionId" in part.data) {
                const sessionData = part.data as { sessionId: string };
                setAtlasSessionId(sessionData.sessionId);
              }
              if (!typingState.isTyping) {
                setTypingState((prev) => ({ ...prev, isTyping: true }));
              }
            } else if (part.type === "data-session-finish") {
              setAtlasSessionId(null); // Clear session ID on finish
              setTypingState({ isTyping: false, elapsedSeconds: 0 });
            } else if (part.type === "data-session-cancel") {
              setAtlasSessionId(null); // Clear session ID on cancel
              setTypingState({ isTyping: false, elapsedSeconds: 0 });
            }
          });

          setSseMessages(uiMessage);
        }
      } catch (error) {
        // SSE connection closed or error
        // Only log if it's not an intentional abort
        if (!sseAbortControllerRef.current?.signal.aborted) {
          // Check if the error is due to abort signal
          const errorMessage = stringifyError(error);
          if (
            !errorMessage.includes("signal has been aborted") &&
            !errorMessage.includes("aborted") &&
            !errorMessage.includes("Bad resource ID")
          ) {
            // Stop the thinking spinner immediately when connection is lost
            setTypingState({ isTyping: false, elapsedSeconds: 0 });

            // Handle daemon connection loss with user-friendly message
            if (errorMessage.includes("Connection to Atlas daemon lost")) {
              setDaemonStatusState(DAEMON_STATUS.UNHEALTHY);
            } else if (errorMessage.includes("Network connection to Atlas daemon failed")) {
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

  useEffect(() => {
    if (!sseMessages) return;

    const output: OutputEntry[] = [];

    sseMessages.parts.forEach((part) => {
      const formattedMessage = formatMessage(part);

      if (formattedMessage) {
        output.push(formattedMessage);
      }
    });

    setOutput(output);
  }, [sseMessages]);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Static
        key={staticKey}
        items={[
          { type: "header", id: "atlas-header", content: "" } as unknown as OutputEntry,
          ...output,
        ].map((entry) => {
          if (entry.type === "header") {
            return <Header key="header" />;
          }

          if (entry.type === "request") {
            return (
              <Box key={entry.id} flexShrink={0} paddingX={2} flexDirection="column">
                <Box height={1} />
                <MessageHeader author={entry.author} date={entry.timestamp} authorColor="green" />

                <ChatMessage
                  message={entry.content?.replace("## Current Request\n", "")}
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
              <Box key={entry.id} flexShrink={0} paddingX={2} flexDirection="column">
                <Box height={1} />
                <MessageHeader author="Atlas" date={entry.timestamp} authorColor="blue" />

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

          // if (entry.type === "thinking") {
          //   return (
          //     <Box key={entry.id} flexShrink={0} paddingX={2} flexDirection="column">
          //       <Box height={1} />
          //       <ChatMessage
          //         message={entry.content}
          //         hideHeader
          //         dimColor
          //         fixedHeight
          //         showCollapsible
          //       />
          //     </Box>
          //   );
          // }

          // if (entry.type === "tool_call" || entry.type === "tool_result") {
          //   return (
          //     <Box key={entry.id} flexShrink={0} paddingX={2} flexDirection="column">
          //       <Box height={1} />
          //       <ToolCall metadata={entry.metadata} />
          //     </Box>
          //   );
          // }

          if (entry.type === "error") {
            return (
              <Box key={entry.id} flexShrink={0} paddingX={2} flexDirection="column">
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
          <Progress
            actions={(() => {
              if (!sseMessages) return [];

              const lastUserIndex = sseMessages.parts.findLastIndex(
                (msg) => msg.type === "data-user-message",
              );

              // If no user message found, return empty
              if (lastUserIndex === -1) return [];

              // Return everything after the last user message
              return sseMessages.parts.slice(lastUserIndex + 1);
            })()}
          />
        </Box>
      )}
    </Box>
  );
};
