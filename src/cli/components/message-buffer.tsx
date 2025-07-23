import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { z } from "zod/v4";
import { useAppContext } from "../contexts/app-context.tsx";
import { ChatMessage } from "./chat-message.tsx";
import { GitDiff } from "./git-diff.tsx";
import { MultiSelect } from "./multi-select.tsx";
import { MarkdownDisplay } from "./markdown-display.tsx";
import { DirectoryTree } from "./directory-tree.tsx";

const MessageEventSchema = z.object({
  type: z.literal("text"),
  data: z.object({
    content: z.string(),
  }),
});

const FinishEventSchema = z.object({
  type: z.literal("finish"),
  data: z.object({
    content: z.string(),
  }),
});

const ErrorEventSchema = z.object({
  type: z.literal("error"),
  data: z.string().optional(),
});

const SelectionListEventSchema = z.object({
  type: z.literal("selection_list"),
  data: z.object({
    label: z.string(),
    options: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
      }),
    ),
  }),
});

const FileDiffEventSchema = z.object({
  type: z.literal("file_diff"),
  data: z.object({
    diffContent: z.string(),
    startingLine: z.number(),
    endingLine: z.number(),
    message: z.string(),
  }),
});

type DirectoryNode = {
  name: string;
  type: "file" | "directory";
  active?: boolean;
  children?: Array<DirectoryNode>;
};

// Define the recursive directory node schema
const DirectoryNodeSchema: z.ZodType<DirectoryNode> = z.object({
  name: z.string(),
  type: z.enum(["file", "directory"]),
  active: z.boolean().optional(),
  children: z.array(z.lazy(() => DirectoryNodeSchema)).optional(),
});

const DirectoryListingEventSchema = z.object({
  type: z.literal("directory_listing"),
  data: z.object({
    tree: z.lazy(() => DirectoryNodeSchema),
  }),
});

const RespondingEventSchema = z.object({
  type: z.literal("responding"),
  data: z.object({
    message: z.string(),
  }),
});

const RespondingStopEventSchema = z.object({
  type: z.literal("responding_stop"),
});

const ToolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  data: z.object({
    content: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    toolCallId: z.string().optional(),
  }),
});

const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  data: z.object({
    content: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    toolCallId: z.string().optional(),
  }),
});

const ThinkingEventSchema = z.object({
  type: z.literal("thinking"),
  data: z.object({
    content: z.string(),
  }),
});

const SSEEventSchema = z.union([
  FinishEventSchema,
  MessageEventSchema,
  ErrorEventSchema,
  SelectionListEventSchema,
  FileDiffEventSchema,
  DirectoryListingEventSchema,
  RespondingEventSchema,
  RespondingStopEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ThinkingEventSchema,
]);

function generateTimestamp() {
  const now = new Date();
  return now
    .toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })
    .toLowerCase()
    .replace(/\s/g, "");
}

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

  // Ends currently streaming messages and sets a newline
  function carriageReturnBuffer() {
    setTypingState((prev) => ({ ...prev, isTyping: false }));

    // Finalize the current streaming message
    const thinkingId = `thinking-response`;
    const finalThinkingId = `response-complete-${Date.now()}`;

    const messageId = `message-response`;
    const finalMessageId = `message-received-${Date.now()}`;

    setOutputBuffer((prev) => {
      return prev.map((entry) => {
        // Only finalize thinking if it was actually displayed
        if (
          entry.id === thinkingId &&
          config.conversationDisplay.showReasoningSteps
        ) {
          return { ...entry, id: finalThinkingId };
        }
        if (entry.id === messageId) {
          return { ...entry, id: finalMessageId };
        }
        return entry;
      });
    });
  }

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
            case "text": {
              setTypingState((prev) => ({ ...prev, isTyping: true }));
              const { content } = sseEvent.data;
              const streamingId = "message-response";

              setOutputBuffer((prev) => {
                const [filtered, previousOutput] = [
                  prev.filter((entry) => entry.id !== streamingId),
                  prev.find((entry) => entry.id === streamingId),
                ];
                const previousContent = previousOutput?.content ?? "";
                const newContent = previousContent + content; //combineTextChunks(previousContent, content);
                return [
                  ...filtered,
                  {
                    id: streamingId,
                    content: newContent,
                    component: (
                      <ChatMessage
                        author="Atlas"
                        authorColor="blue"
                        date={generateTimestamp()}
                      >
                        <MarkdownDisplay content={newContent} />
                      </ChatMessage>
                    ),
                  },
                ];
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

            case "selection_list": {
              const { label, options } = sseEvent.data;

              setOutputBuffer((prev) => [
                ...prev,
                {
                  id: `selection-list-${Date.now()}`,
                  component: (
                    <ChatMessage author={label} authorColor="yellow">
                      <MultiSelect options={options} isDisabled={false} />
                    </ChatMessage>
                  ),
                },
              ]);
              break;
            }

            case "file_diff": {
              const { diffContent, startingLine, endingLine, message } = sseEvent.data;

              const timestamp = generateTimestamp();

              setOutputBuffer((prev) => [
                ...prev,
                {
                  id: `file-diff-${Date.now()}`,
                  component: (
                    <ChatMessage
                      author="Atlas"
                      date={timestamp}
                      message={message}
                    >
                      <GitDiff
                        diffContent={diffContent}
                        startingLine={startingLine}
                        endingLine={endingLine}
                      />
                    </ChatMessage>
                  ),
                },
              ]);
              break;
            }

            case "directory_listing": {
              const { tree } = sseEvent.data;

              setOutputBuffer((prev) => [
                ...prev,
                {
                  id: `directory-listing-${Date.now()}`,
                  component: (
                    <Box paddingLeft={1}>
                      <DirectoryTree tree={tree} />
                    </Box>
                  ),
                },
              ]);
              break;
            }

            case "responding": {
              const { message } = sseEvent.data;
              setTypingState((prev) => ({
                ...prev,
                isTyping: true,
                message,
              }));
              break;
            }

            case "responding_stop": {
              setTypingState((prev) => ({
                ...prev,
                isTyping: false,
                message: undefined,
              }));
              break;
            }

            case "tool_call": {
              carriageReturnBuffer();

              const { toolName, args, toolCallId } = sseEvent.data;

              // Skip if tool calls are disabled in user preferences
              if (!config.conversationDisplay.showToolCalls) {
                break;
              }

              // Simple JSON display for now
              const argsDisplay = args ? JSON.stringify(args, null, 2) : "No arguments";
              const fullContent = `Calling: ${toolName}\n${argsDisplay}`;

              setOutputBuffer((prev) => [
                ...prev,
                {
                  id: `tool-call-${toolCallId || Date.now()}`,
                  component: (
                    <MarkdownDisplay
                      content={fullContent}
                      dimColor
                      showCollapsible
                    />
                  ),
                },
              ]);
              break;
            }

            case "tool_result": {
              carriageReturnBuffer();

              const { toolName, result, toolCallId } = sseEvent.data;

              // Skip if tool results are disabled in user preferences
              if (!config.conversationDisplay.showToolResults) {
                break;
              }

              // Simple JSON display for now
              const resultDisplay = JSON.stringify(result, null, 2);
              const fullContent = `${toolName} returned:\n${resultDisplay}`;

              setOutputBuffer((prev) => [
                ...prev,
                {
                  id: `tool-result-${toolCallId || Date.now()}`,
                  component: (
                    <MarkdownDisplay
                      content={fullContent}
                      dimColor
                      showCollapsible
                    />
                  ),
                },
              ]);
              break;
            }

            case "thinking": {
              setTypingState((prev) => ({ ...prev, isTyping: true }));
              const { content } = sseEvent.data;

              // Skip if reasoning steps are disabled in user preferences
              if (!config.conversationDisplay.showReasoningSteps) {
                break;
              }

              const streamingMessageId = `thinking-response`;

              setOutputBuffer((prev) => {
                const [filtered, previousOutput] = [
                  prev.filter((entry) => entry.id !== streamingMessageId),
                  prev.find((entry) => entry.id === streamingMessageId),
                ];
                const previousContent = previousOutput?.content ?? "";
                const newContent = previousContent + content; // combineTextChunks(previousContent, content);
                return [
                  ...filtered,
                  {
                    id: streamingMessageId,
                    content: newContent,
                    component: (
                      <MarkdownDisplay
                        showCollapsible
                        content={newContent}
                        dimColor
                      />
                    ),
                  },
                ];
              });

              break;
            }

            case "finish": {
              carriageReturnBuffer();

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

  {
    /* {config.streamMessages
              ? <Spinner label={typingState.message || "Typing..."} />
              : (
                <Spinner
                  label={`${typingState.message || "Typing..."} (${typingState.elapsedSeconds}s)`}
                />
              )} */
  }

  return outputBuffer.length > 0
    ? (
      <Box flexDirection="column" gap={1}>
        {outputBuffer.map((entry) => (
          <React.Fragment key={entry.id}>{entry.component}</React.Fragment>
        ))}

        {/* Typing indicator */}
        {typingState.isTyping && (
          <Box>
            <Text>Thinking...</Text>
          </Box>
        )}
      </Box>
    )
    : null;
};
