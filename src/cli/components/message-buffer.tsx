import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { z } from "zod/v4";
import { useAppContext } from "../contexts/app-context.tsx";
import { ChatMessage } from "./chat-message.tsx";

// Define SSE event schemas
const MessageChunkEventSchema = z.object({
  type: z.literal("message_chunk"),
  data: z.object({
    content: z.string(),
    partial: z.boolean().optional(),
  }),
});

const MessageCompleteEventSchema = z.object({
  type: z.literal("message_complete"),
});

const ErrorEventSchema = z.object({
  type: z.literal("error"),
  data: z.string().optional(),
});

const SSEEventSchema = z.union([
  MessageChunkEventSchema,
  MessageCompleteEventSchema,
  ErrorEventSchema,
]);

// type SSEEvent = z.infer<typeof SSEEventSchema>;

export const MessageBuffer = () => {
  const {
    config,
    conversationClient,
    conversationSessionId,
    outputBuffer,
    setOutputBuffer,
    typingState,
    setTypingState,
    sseAbortControllerRef,
  } = useAppContext();
  const sseListenerStarted = useRef(false);
  const [sseStream, setSseStream] = useState<AsyncIterable<unknown> | null>(
    null,
  );

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

          const sseEvent = parseResult.data;

          switch (sseEvent.type) {
            case "message_chunk": {
              const { content: responseMessage, partial: isPartial } = sseEvent.data;

              // If streaming is enabled, show all chunks
              // If streaming is disabled, only show when partial is false (complete message)
              if (responseMessage && (config.streamMessages || !isPartial)) {
                setTypingState((prev) => ({ ...prev, isTyping: true }));
                const now = new Date();
                const responseTimestamp = now
                  .toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })
                  .toLowerCase()
                  .replace(/\s/g, "");

                const streamingMessageId = `llm-response-current`;

                setOutputBuffer((prev) => {
                  const filtered = prev.filter(
                    (entry) => entry.id !== streamingMessageId,
                  );
                  return [
                    ...filtered,
                    {
                      id: streamingMessageId,
                      component: (
                        <ChatMessage
                          author="Atlas"
                          date={responseTimestamp}
                          message={responseMessage}
                        />
                      ),
                    },
                  ];
                });
              }
              break;
            }

            case "message_complete": {
              setTypingState((prev) => ({ ...prev, isTyping: false }));
              // Finalize the current streaming message
              const streamingMessageId = `llm-response-current`;
              const finalMessageId = `message-received-${Date.now()}`;

              setOutputBuffer((prev) => {
                return prev.map((entry) =>
                  entry.id === streamingMessageId ? { ...entry, id: finalMessageId } : entry
                );
              });
              break;
            }

            case "error": {
              setTypingState((prev) => ({ ...prev, isTyping: false }));
              const errorTimestamp = new Date()
                .toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })
                .toLowerCase()
                .replace(/\s/g, "");

              setOutputBuffer((prev) => [
                ...prev,
                {
                  id: `error-${Date.now()}`,
                  component: (
                    <Box flexDirection="column">
                      <Box flexDirection="row" gap={1}>
                        <Text color="red" bold>
                          Error
                        </Text>
                        <Text color="red" dimColor bold>
                          [{errorTimestamp}]
                        </Text>
                      </Box>
                      <Text color="red">
                        {sseEvent.data || "An error occurred"}
                      </Text>
                    </Box>
                  ),
                },
              ]);
              break;
            }
          }
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
  }, [
    sseStream,
    setOutputBuffer,
    setTypingState,
    sseAbortControllerRef,
    config.streamMessages,
  ]);

  return outputBuffer.length > 0
    ? (
      <Box flexDirection="column" gap={1}>
        {outputBuffer.map((entry) => (
          <React.Fragment key={entry.id}>{entry.component}</React.Fragment>
        ))}

        {/* Typing indicator */}
        {typingState.isTyping && (
          <Box>
            {config.streamMessages
              ? <Spinner label="Typing..." />
              : <Spinner label={`Typing... (${typingState.elapsedSeconds}s)`} />}
          </Box>
        )}
      </Box>
    )
    : null;
};
