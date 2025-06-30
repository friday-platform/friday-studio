import { defaultTheme, extendTheme, Spinner, ThemeProvider } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { YargsInstance } from "../utils/yargs.ts";
import { TextInput } from "../components/text-input/text-input.tsx";
import { ConversationClient } from "../utils/conversation-client.ts";

// Custom theme
const customTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: "yellow" }),
        label: ({ isFocused, isSelected }) => ({
          color: isSelected ? "yellow" : isFocused ? "yellow" : undefined,
        }),
      },
    },
  },
});

export const command = "cx";
export const desc = "ConversationSupervisor Server-Connected Playground";

export function builder(yargs: YargsInstance) {
  return yargs
    .option("workspace", {
      alias: "w",
      type: "string",
      default: "al-dente_salmon",
      describe: "Workspace ID to connect to",
    })
    .option("daemon-url", {
      alias: "d",
      type: "string",
      default: "http://localhost:8080",
      describe: "Atlas daemon URL",
    })
    .example("$0 cx", "Launch conversation supervisor server playground")
    .epilogue("LLM reasoning playground connected to Atlas daemon");
}

export function handler(argv: { workspace: string; daemonUrl: string }) {
  render(
    <ThemeProvider theme={customTheme}>
      <CxCommand workspaceId={argv.workspace} daemonUrl={argv.daemonUrl} />
    </ThemeProvider>,
  );
}

// Output buffer entry
interface OutputEntry {
  id: string;
  component: React.ReactElement;
}

// Main component
function CxCommand({ workspaceId, daemonUrl }: { workspaceId: string; daemonUrl: string }) {
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const { exit } = useApp();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });
  const [client, setClient] = useState<ConversationClient | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Add to output buffer
  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  // Initialize connection
  React.useEffect(() => {
    addOutputEntry({
      id: "welcome",
      component: (
        <Box flexDirection="column">
          <Text bold color="cyan">🧠 ConversationSupervisor Server Playground</Text>
          <Text dimColor>Connected to Atlas daemon with native tool calling</Text>
          <Text dimColor>Type messages to see how CS reasons about them via server</Text>
        </Box>
      ),
    });

    // Initialize connection
    initializeConnection();
  }, []);

  const initializeConnection = async () => {
    try {
      const conversationClient = new ConversationClient(daemonUrl, workspaceId, "cli-user");

      // Health check
      const isHealthy = await conversationClient.healthCheck();
      if (!isHealthy) {
        addOutputEntry({
          id: "connection-error",
          component: <Text color="red">❌ Atlas daemon is not running or not reachable</Text>,
        });
        return;
      }

      // Create session
      const session = await conversationClient.createSession();

      setClient(conversationClient);
      setSessionId(session.sessionId);

      addOutputEntry({
        id: "connection-success",
        component: (
          <Text color="green">
            ✅ Connected to Atlas daemon ({workspaceId}) - Session: {session.sessionId}
          </Text>
        ),
      });
    } catch (error) {
      addOutputEntry({
        id: "connection-error",
        component: (
          <Text color="red">
            ❌ Connection failed: {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    }
  };

  // Handle user input with server-side processing
  const handleUserInput = async (input: string) => {
    if (!client || !sessionId) {
      addOutputEntry({
        id: `error-${Date.now()}`,
        component: <Text color="red">❌ Not connected to server</Text>,
      });
      return;
    }

    // Add user message
    addOutputEntry({
      id: `user-${Date.now()}`,
      component: (
        <Text color="blue">
          👤 <Text bold>User:</Text> {input}
        </Text>
      ),
    });

    // Show processing spinner
    setIsProcessing(true);
    addOutputEntry({
      id: `processing-${Date.now()}`,
      component: (
        <Box>
          <Spinner label="Brain thinking..." />
        </Box>
      ),
    });

    try {
      // Send message to server
      const startTime = Date.now();
      await client.sendMessage(sessionId, input);

      let responseMessage = "";
      let transparency: any = null;
      let orchestration: any = null;
      let toolCalls: any[] = [];

      // Listen for streaming response
      for await (const event of client.streamEvents(sessionId)) {
        switch (event.type) {
          case "tool_call":
            toolCalls.push({
              toolName: event.data.toolName,
              args: event.data.args,
            });
            break;

          case "message_chunk":
            responseMessage = event.data.content;
            break;

          case "transparency":
            transparency = event.data;
            break;

          case "orchestration":
            orchestration = event.data;
            break;

          case "message_complete":
            setIsProcessing(false);
            const duration = Date.now() - startTime;

            // Display tool calls if any were made
            if (toolCalls.length > 0) {
              addOutputEntry({
                id: `tool-calls-${Date.now()}`,
                component: (
                  <Box
                    flexDirection="column"
                    marginLeft={2}
                    borderStyle="round"
                    borderColor="magenta"
                    paddingX={1}
                  >
                    <Text color="magenta">
                      🔧 <Text bold>Server Tool Calls</Text> ({duration}ms):
                    </Text>
                    {toolCalls.map((call, idx) => (
                      <Box key={idx} flexDirection="column" marginLeft={1} marginY={0}>
                        <Text color="yellow">
                          [{idx + 1}] <Text bold>{call.toolName}</Text>
                        </Text>
                        <Text color="gray" dimColor>
                          📋 {JSON.stringify(call.args, null, 0)}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                ),
              });

              // Display the conversational response prominently
              if (responseMessage) {
                addOutputEntry({
                  id: `response-${Date.now()}`,
                  component: (
                    <Box flexDirection="column" marginLeft={2}>
                      <Text color="cyan">
                        🤖 <Text bold>ConversationSupervisor</Text>:
                      </Text>
                      <Text wrap="wrap" color="white">{responseMessage}</Text>
                    </Box>
                  ),
                });
              }

              // Display transparency details
              if (transparency) {
                addOutputEntry({
                  id: `transparency-${Date.now()}`,
                  component: (
                    <Box
                      flexDirection="column"
                      marginLeft={2}
                      borderStyle="round"
                      borderColor="yellow"
                      paddingX={1}
                    >
                      <Text color="yellow">
                        🔍 <Text bold>Reasoning Transparency</Text>:
                      </Text>
                      <Text color="white" marginLeft={1}>
                        📊 Analysis: {transparency.analysis}
                      </Text>
                      <Text color="white" marginLeft={1}>
                        🎯 Confidence: {Math.round(transparency.confidence * 100)}%
                      </Text>
                      <Text color="white" marginLeft={1}>
                        📈 Complexity: {transparency.complexity}
                      </Text>
                      <Text color="white" marginLeft={1}>
                        🤖 Agent Coordination:{" "}
                        {transparency.requiresAgentCoordination ? "Yes" : "No"}
                      </Text>
                      {transparency.coordinationPlan && (
                        <>
                          <Text color="blue" marginLeft={1}>
                            📝 <Text bold>Coordination Plan:</Text>
                          </Text>
                          {transparency.coordinationPlan.agents && (
                            <Text color="white" marginLeft={2}>
                              👥 Agents: {transparency.coordinationPlan.agents.join(", ")}
                            </Text>
                          )}
                          {transparency.coordinationPlan.strategy && (
                            <Text color="white" marginLeft={2}>
                              ⚡ Strategy: {transparency.coordinationPlan.strategy}
                            </Text>
                          )}
                          {transparency.coordinationPlan.recommendedJob && (
                            <Text color="white" marginLeft={2}>
                              🎯 Job: {transparency.coordinationPlan.recommendedJob}
                            </Text>
                          )}
                        </>
                      )}
                    </Box>
                  ),
                });
              }

              // Display orchestration details if coordination was executed
              if (orchestration) {
                addOutputEntry({
                  id: `orchestration-${Date.now()}`,
                  component: (
                    <Box
                      flexDirection="column"
                      marginLeft={2}
                      borderStyle="round"
                      borderColor="magenta"
                      paddingX={1}
                    >
                      <Text color="magenta">
                        ⚡ <Text bold>Atlas Orchestration</Text>:
                      </Text>
                      <Text color="white" marginLeft={1}>
                        Session: {orchestration.sessionId}
                      </Text>
                      {orchestration.plan?.estimatedDuration && (
                        <Text color="white" marginLeft={1}>
                          Duration: {orchestration.plan.estimatedDuration}
                        </Text>
                      )}

                      {/* Execution steps */}
                      {orchestration.executionSteps && (
                        <>
                          <Text color="blue" marginLeft={1}>
                            📝 <Text bold>Execution Steps:</Text>
                          </Text>
                          {orchestration.executionSteps.map((
                            step: string,
                            stepIdx: number,
                          ) => (
                            <Text key={stepIdx} color="white" marginLeft={2}>
                              {step}
                            </Text>
                          ))}
                        </>
                      )}
                    </Box>
                  ),
                });
              }
            } else {
              addOutputEntry({
                id: `no-tools-${Date.now()}`,
                component: (
                  <Box marginLeft={2}>
                    <Text color="gray" dimColor>
                      💭 <Text bold>No tools called</Text> - direct response
                    </Text>
                  </Box>
                ),
              });
            }

            if (event.data.error) {
              addOutputEntry({
                id: `error-${Date.now()}`,
                component: (
                  <Text color="red">
                    ❌ <Text bold>Error:</Text> {event.data.error}
                  </Text>
                ),
              });
            }
            return; // Exit the stream
        }
      }
    } catch (error) {
      setIsProcessing(false);
      addOutputEntry({
        id: `error-${Date.now()}`,
        component: (
          <Text color="red">
            ❌ <Text bold>Error:</Text> {error instanceof Error ? error.message : String(error)}
          </Text>
        ),
      });
    }
  };

  // Handle commands
  const handleCommand = (input: string) => {
    if (input === "/clear") {
      setOutputBuffer([]);
      return true;
    }

    if (input === "/exit") {
      exit();
      return true;
    }

    if (input === "/help") {
      addOutputEntry({
        id: `help-${Date.now()}`,
        component: (
          <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
            <Text color="blue" bold>Commands:</Text>
            <Text color="white">/clear - Clear output</Text>
            <Text color="white">/help - Show this help</Text>
            <Text color="white">/exit - Exit playground</Text>
            <Text dimColor>Or just type messages to see server-side LLM reasoning!</Text>
          </Box>
        ),
      });
      return true;
    }

    return false;
  };

  // Handle keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  return (
    <Box
      flexDirection="column"
      padding={1}
      alignItems="flex-start"
      width={dimensions.paddedWidth}
    >
      {/* Output buffer */}
      {outputBuffer.length > 0 && (
        <Box flexDirection="column" marginBottom={1} width="100%">
          {outputBuffer.map((entry) => <Box key={entry.id} width="100%">{entry.component}</Box>)}
        </Box>
      )}

      {/* Input */}
      <ConversationInput
        onSubmit={(input) => {
          if (!handleCommand(input)) {
            handleUserInput(input);
          }
        }}
        disabled={isProcessing}
      />
    </Box>
  );
}

// Simple input component
interface ConversationInputProps {
  onSubmit: (input: string) => void;
  disabled?: boolean;
}

const ConversationInput = ({ onSubmit, disabled = false }: ConversationInputProps) => {
  const [inputKey, setInputKey] = useState(0);

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (trimmed && !disabled) {
      onSubmit(trimmed);
      setInputKey((prev) => prev + 1); // Reset input
    }
  };

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan">💬</Text>
        <TextInput
          key={inputKey}
          placeholder={disabled ? "Processing..." : "Type your message..."}
          onSubmit={handleSubmit}
          disabled={disabled}
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>Ctrl+C to exit | /help for commands</Text>
      </Box>
    </Box>
  );
};

export default CxCommand;
