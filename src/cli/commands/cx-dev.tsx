import { defaultTheme, extendTheme, ThemeProvider } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { YargsInstance } from "../utils/yargs.ts";
import { TextInput } from "../components/text-input/text-input.tsx";
import { LLMService } from "../../core/llm-service.ts";
import { LLMProviderManager } from "../../core/agents/llm-provider-manager.ts";
import { jsonSchema, Tool } from "ai";

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

export const command = "cx-dev";
export const desc = "ConversationSupervisor LLM playground";

export function builder(yargs: YargsInstance) {
  return yargs
    .example("$0 cx-dev", "Launch conversation supervisor LLM playground")
    .epilogue("Simple LLM reasoning playground for ConversationSupervisor development");
}

export function handler() {
  render(
    <ThemeProvider theme={customTheme}>
      <CxDevCommand />
    </ThemeProvider>,
  );
}

// Output buffer entry
interface OutputEntry {
  id: string;
  component: React.ReactElement;
}

// Tool call simulation
interface ToolCall {
  id: string;
  type: "job_execution" | "agent_invocation" | "session_management" | "monitoring";
  name: string;
  parameters: Record<string, any>;
  result: string;
  duration: number;
}

// Atlas orchestration proxy tools with message envelope pattern for transparency
const atlasOrchestrationTools: Record<string, Tool> = {
  atlas_reply: {
    description:
      "Reply to user with structured transparency envelope containing reasoning and potential agent coordination",
    parameters: jsonSchema({
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Natural conversational response to the user",
        },
        transparency: {
          type: "object",
          properties: {
            analysis: {
              type: "string",
              description: "Your detailed reasoning about this interaction",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Confidence level in your understanding and response",
            },
            complexity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Task complexity assessment",
            },
            requiresAgentCoordination: {
              type: "boolean",
              description: "Whether this request needs Atlas agent coordination",
            },
            coordinationPlan: {
              type: "object",
              properties: {
                agents: {
                  type: "array",
                  items: { type: "string" },
                  description: "Atlas agents to coordinate if coordination is needed",
                },
                strategy: {
                  type: "string",
                  enum: ["sequential", "parallel", "staged"],
                  description: "Execution strategy for agent coordination",
                },
                recommendedJob: {
                  type: "string",
                  description:
                    "Existing Atlas job to use (security-audit, code-review, architecture-review) or custom",
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          required: ["analysis", "confidence", "complexity", "requiresAgentCoordination"],
          additionalProperties: false,
        },
      },
      required: ["message", "transparency"],
      additionalProperties: false,
    }),
    execute: async ({ message, transparency }) => {
      const result: any = {
        message,
        transparency,
      };

      // If agent coordination is required, create orchestration plan
      if (transparency.requiresAgentCoordination && transparency.coordinationPlan) {
        const sessionId = `sess_${Math.random().toString(36).substring(2, 8)}`;

        result.orchestration = {
          sessionId,
          plan: {
            agents: transparency.coordinationPlan.agents || [],
            strategy: transparency.coordinationPlan.strategy,
            estimatedDuration: transparency.complexity === "high"
              ? "10-15min"
              : transparency.complexity === "medium"
              ? "5-10min"
              : "2-5min",
          },
          executionSteps: [
            `✅ Created WorkspaceSession ${sessionId}`,
            `🤖 Initialized ${(transparency.coordinationPlan.agents || []).length} agents: ${
              (transparency.coordinationPlan.agents || []).join(", ")
            }`,
            `⚡ Configured ${transparency.coordinationPlan.strategy} execution strategy`,
            `📊 Enabled real-time monitoring and supervision`,
            `🎯 ${
              transparency.coordinationPlan.recommendedJob
                ? `Triggered Atlas job: ${transparency.coordinationPlan.recommendedJob}`
                : "Started custom agent coordination"
            }`,
          ],
        };
      }

      return result;
    },
  },
};

// ConversationSupervisor with native tool calling
class ConversationSupervisorReasoning {
  async processRequest(message: string): Promise<{
    text: string;
    toolCalls: any[];
    toolResults: any[];
    duration: number;
  }> {
    const startTime = Date.now();

    const systemPrompt =
      `You are an Atlas ConversationSupervisor that responds to ALL messages using the atlas_reply tool.

AVAILABLE ATLAS AGENTS:
- security-agent: Security vulnerability analysis, penetration testing, code security review
- code-reviewer: Static code analysis, best practices, maintainability assessment  
- architect: System architecture analysis, design patterns, scalability assessment
- performance-analyzer: Performance bottleneck detection, optimization recommendations

AVAILABLE ATLAS JOBS:
- security-audit: Parallel security and code quality review
- code-review: Sequential code quality and architecture analysis
- architecture-review: Staged architecture, performance, and security evaluation

RESPONSE GUIDELINES:
- ALWAYS use the atlas_reply tool for every response - never respond without using it
- Provide natural, conversational responses in the message field
- Include detailed reasoning and transparency data for every interaction
- Assess whether requests need agent coordination and provide coordination plans when needed
- Be transparent about your confidence level and complexity assessment
- For simple greetings or informational queries, set requiresAgentCoordination to false
- For code review, security analysis, or technical requests, set requiresAgentCoordination to true with appropriate agents

The atlas_reply tool provides structured transparency while maintaining conversational flow.`;

    try {
      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools: atlasOrchestrationTools,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.3,
        maxSteps: 1,
        toolChoice: "required",
        operationContext: { operation: "conversation_supervision" },
      });

      return {
        text: result.text,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        text: `I'm having trouble processing your request right now. Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        toolCalls: [],
        toolResults: [],
        duration: Date.now() - startTime,
      };
    }
  }
}

// Main component
function CxDevCommand() {
  const [outputBuffer, setOutputBuffer] = useState<OutputEntry[]>([]);
  const cs = new ConversationSupervisorReasoning();
  const { exit } = useApp();
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  // Add to output buffer
  const addOutputEntry = (entry: OutputEntry) => {
    setOutputBuffer((prev) => [...prev, entry]);
  };

  // Initialize
  React.useEffect(() => {
    addOutputEntry({
      id: "welcome",
      component: (
        <Box flexDirection="column">
          <Text bold color="cyan">🧠 ConversationSupervisor LLM Playground</Text>
          <Text dimColor>Simple LLM reasoning test for agent coordination</Text>
          <Text dimColor>Type messages to see how CS would reason about them</Text>
        </Box>
      ),
    });
  }, []);

  // Handle user input with native tool calling
  const handleUserInput = async (input: string) => {
    // Add user message
    addOutputEntry({
      id: `user-${Date.now()}`,
      component: (
        <Text color="blue">
          👤 <Text bold>User:</Text> {input}
        </Text>
      ),
    });

    // Show processing
    addOutputEntry({
      id: `processing-${Date.now()}`,
      component: (
        <Text color="cyan">
          🤔 <Text bold>[ConversationSupervisor]</Text> Processing with native tool calling...
        </Text>
      ),
    });

    try {
      // Native tool calling with Atlas orchestration proxy
      const result = await cs.processRequest(input);

      // Display tool calls if any were made
      if (result.toolCalls.length > 0) {
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
                🔧 <Text bold>Native Tool Calls</Text> ({result.duration}ms):
              </Text>
              {result.toolCalls.map((call, idx) => (
                <Box key={call.toolCallId} flexDirection="column" marginLeft={1} marginY={0}>
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

        // Display the conversational response prominently first
        const firstToolResult = result.toolResults[0]?.result as any;
        if (firstToolResult?.message) {
          addOutputEntry({
            id: `response-${Date.now()}`,
            component: (
              <Box flexDirection="column" marginLeft={2}>
                <Text color="cyan">
                  🤖 <Text bold>ConversationSupervisor</Text>:
                </Text>
                <Text wrap="wrap" color="white">{firstToolResult.message}</Text>
              </Box>
            ),
          });
        }

        // Display transparency details
        addOutputEntry({
          id: `tool-results-${Date.now()}`,
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
              {result.toolResults.map((toolResult, idx) => {
                const parsedResult = toolResult.result as any;
                return (
                  <Box
                    key={toolResult.toolCallId}
                    flexDirection="column"
                    marginLeft={1}
                    marginY={0}
                  >
                    {/* Show transparency envelope */}
                    {parsedResult.transparency && (
                      <>
                        {/* Analysis */}
                        <Text color="white" marginLeft={1}>
                          <Text color="gray">Analysis:</Text> {parsedResult.transparency.analysis}
                        </Text>

                        {/* Confidence & Complexity */}
                        <Text color="white" marginLeft={1}>
                          <Text color="gray">Confidence:</Text>{" "}
                          {(parsedResult.transparency.confidence * 100).toFixed(0)}% |{" "}
                          <Text color="gray">Complexity:</Text>{" "}
                          {parsedResult.transparency.complexity}
                        </Text>

                        {/* Agent coordination status */}
                        <Text color="white" marginLeft={1}>
                          <Text color="gray">Requires Coordination:</Text>{" "}
                          {parsedResult.transparency.requiresAgentCoordination ? "Yes" : "No"}
                        </Text>

                        {/* Show coordination plan if present */}
                        {parsedResult.transparency.requiresAgentCoordination &&
                          parsedResult.transparency.coordinationPlan && (
                          <>
                            <Text color="blue" marginLeft={1}>
                              📋 <Text bold>Coordination Plan:</Text>
                            </Text>
                            <Text color="white" marginLeft={2}>
                              Agents:{" "}
                              {parsedResult.transparency.coordinationPlan.agents?.join(", ") ||
                                "None specified"}
                            </Text>
                            <Text color="white" marginLeft={2}>
                              Strategy: {parsedResult.transparency.coordinationPlan.strategy ||
                                "Not specified"}
                            </Text>
                            <Text color="white" marginLeft={2}>
                              Job: {parsedResult.transparency.coordinationPlan.recommendedJob ||
                                "Custom coordination"}
                            </Text>
                          </>
                        )}
                      </>
                    )}
                  </Box>
                );
              })}
            </Box>
          ),
        });

        // Display orchestration details in a separate section if coordination was executed
        if (firstToolResult?.orchestration) {
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
                  Session: {firstToolResult.orchestration.sessionId}
                </Text>
                <Text color="white" marginLeft={1}>
                  Duration: {firstToolResult.orchestration.plan.estimatedDuration}
                </Text>

                {/* Execution steps */}
                {firstToolResult.orchestration.executionSteps && (
                  <>
                    <Text color="blue" marginLeft={1}>
                      📝 <Text bold>Execution Steps:</Text>
                    </Text>
                    {firstToolResult.orchestration.executionSteps.map((
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

      // Display LLM response if there's additional text (shouldn't be any with reply tool)
      if (result.text && result.text.trim()) {
        addOutputEntry({
          id: `additional-response-${Date.now()}`,
          component: (
            <Box flexDirection="column" marginLeft={2}>
              <Text color="red">
                ⚠️ <Text bold>Unexpected Additional Response</Text>:
              </Text>
              <Text wrap="wrap" color="white">{result.text}</Text>
            </Box>
          ),
        });
      }
    } catch (error) {
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
            <Text dimColor>Or just type messages to see LLM reasoning!</Text>
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
      />
    </Box>
  );
}

// Simple input component
interface ConversationInputProps {
  onSubmit: (input: string) => void;
}

const ConversationInput = ({ onSubmit }: ConversationInputProps) => {
  const [inputKey, setInputKey] = useState(0);

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (trimmed) {
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
          placeholder="Type your message..."
          onSubmit={handleSubmit}
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>Ctrl+C to exit | /help for commands</Text>
      </Box>
    </Box>
  );
};

export default CxDevCommand;
