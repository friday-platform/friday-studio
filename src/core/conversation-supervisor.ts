import { WorkspaceConfigSchema } from "@atlas/config";
import { stringify } from "@std/yaml";
import { jsonSchema, Tool } from "ai";
import { z } from "zod";
import { AtlasLogger } from "../utils/logger.ts";
import { LLMProviderManager } from "./agents/llm-provider-manager.ts";
import {
  generateUpdateMessage,
  getPatternSuggestions,
  suggestNextSteps,
} from "./services/workspace-conversation-helpers.ts";
import { createKVStorage, StorageConfigs, WorkspaceDraftStorageAdapter } from "./storage/index.ts";

// MCP tool name validation - dots are illegal in MCP tool names
const MCPToolNameSchema = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_-]*$/,
  "MCP tool names must start with a letter and contain only letters, numbers, underscores, and hyphens (no dots)",
);

// Create a singleton draft storage adapter
let draftStorageAdapter: WorkspaceDraftStorageAdapter | null = null;

async function getDraftStorageAdapter(): Promise<WorkspaceDraftStorageAdapter> {
  if (!draftStorageAdapter) {
    const kvStorage = await createKVStorage(StorageConfigs.defaultKV());
    draftStorageAdapter = new WorkspaceDraftStorageAdapter(kvStorage);
    await draftStorageAdapter.initialize();
  }
  return draftStorageAdapter;
}

export interface ConversationSession {
  id: string;
  workspaceId: string;
  mode: "private" | "shared";
  participants: Array<{
    userId: string;
    clientType: string;
    joinedAt: string;
    lastSeen: string;
  }>;
  createdAt: string;
  lastActivity: string;
  messageHistory: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  fromUser: string;
  content: string;
  timestamp: string;
  type: "user" | "assistant" | "system";
}

export interface ConversationEvent {
  type:
    | "thinking"
    | "tool_call"
    | "message_chunk"
    | "transparency"
    | "orchestration"
    | "message_complete"
    | "user_message"
    | "user_joined"
    | "user_left";
  data: any;
  timestamp: string;
  messageId?: string;
  sessionId: string;
}

// Function to create tools with session context
const createCxTools = (sessionId: string): Record<string, Tool> => ({
  cx_reply: {
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
                  description: "Atlas job to recommend or trigger",
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
      // Simple reply tool - just return the message and transparency
      // No fake orchestration or session creation
      const logger = AtlasLogger.getInstance();
      logger.info("cx_reply tool executed", {
        message: message.substring(0, 500), // Show more of the message
        messageLength: message.length,
        fullMessage: message, // Log the entire message
        transparency,
      });
      return await Promise.resolve({
        message,
        transparency,
      });
    },
  },
  // Add workspace_create tool for actual workspace creation
  workspace_create: {
    description: "Create a new workspace with the specified configuration",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Workspace name (lowercase with hyphens)",
        },
        description: {
          type: "string",
          description: "Workspace description",
        },
        path: {
          type: "string",
          description: "Optional path where workspace should be created",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    }),
    execute: async ({ name, description, path }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_create tool called", {
        name,
        description,
        path,
      });

      try {
        // Call the daemon API to actually create the workspace
        const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
        const response = await fetch(`${daemonUrl}/api/workspaces`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description,
            path,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error("Failed to create workspace", { error, status: response.status });
          return {
            success: false,
            error: `Failed to create workspace: ${error}`,
          };
        }

        const workspace = await response.json();
        logger.info("Workspace created successfully", { workspace });

        return {
          success: true,
          workspace,
          message: `Workspace '${name}' created successfully with ID: ${workspace.id}`,
        };
      } catch (error) {
        logger.error("Error creating workspace", { error });
        return {
          success: false,
          error: `Error creating workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },
  // New draft-based workspace creation tools
  workspace_draft_create: {
    description: "Create a new workspace draft that can be iteratively refined",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$",
          description: "Workspace name (lowercase with hyphens, no dots)",
        },
        description: {
          type: "string",
          description: "Clear description of the workspace's purpose",
        },
        pattern: {
          type: "string",
          enum: ["pipeline", "ensemble", "hierarchy", "custom"],
          description: "Workspace pattern to use as starting template",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    }),
    execute: async ({ name, description, pattern }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_draft_create called", {
        name,
        description,
        pattern,
      });

      try {
        // Validate the name using the schema
        const nameValidation = MCPToolNameSchema.safeParse(name);
        if (!nameValidation.success) {
          return {
            success: false,
            error: nameValidation.error.issues[0].message,
          };
        }

        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.createDraft({
          name,
          description,
          pattern,
          sessionId,
          userId: "system",
        });

        const suggestions = getPatternSuggestions(pattern);
        return {
          success: true,
          draftId: draft.id,
          message: `Created draft workspace '${name}'. Now let's design the agents and workflow.`,
          suggestions,
          suggestionsText: suggestions.length > 0
            ? `\n\nTo help design your workspace:\n${
              suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")
            }`
            : "",
        };
      } catch (error) {
        logger.error("Error creating workspace draft", { error });
        return {
          success: false,
          error: `Error creating draft: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  update_workspace_config: {
    description: "Update the draft workspace configuration by adding or modifying components",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID",
        },
        operation: {
          type: "string",
          enum: [
            "add_agent",
            "update_agent",
            "remove_agent",
            "add_job",
            "update_job",
            "remove_job",
            "set_trigger",
            "add_tool",
            "remove_tool",
          ],
          description: "Type of update operation",
        },
        config: {
          type: "object",
          description: "Configuration for the operation",
        },
      },
      required: ["draftId", "operation", "config"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, operation, config }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: update_workspace_config called", {
        draftId,
        operation,
        config,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.updateDraft(draftId, operation, config);

        return {
          success: true,
          draftId: draft.id,
          operation,
          message: generateUpdateMessage(operation, config),
          currentAgents: Object.keys(draft.config.agents || {}),
          currentJobs: Object.keys(draft.config.jobs || {}),
          nextSteps: suggestNextSteps(draft),
        };
      } catch (error) {
        logger.error("Error updating workspace draft", { error });
        return {
          success: false,
          error: `Error updating draft: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  publish_workspace: {
    description: "Publish a draft workspace to the filesystem, making it available for use",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID to publish",
        },
        path: {
          type: "string",
          description: "Optional path where workspace should be created",
        },
      },
      required: ["draftId"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, path }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: publish_workspace called", {
        draftId,
        path,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.getDraft(draftId);

        if (!draft) {
          return {
            success: false,
            error: `Draft ${draftId} not found`,
          };
        }

        // Validate the config before publishing
        const validationResult = WorkspaceConfigSchema.safeParse(draft.config);
        if (!validationResult.success) {
          return {
            success: false,
            error: `Configuration validation failed: ${validationResult.error.message}`,
            issues: validationResult.error.issues,
          };
        }

        // Generate YAML from validated config
        const yaml = stringify(validationResult.data);

        // Get current working directory if no path specified
        const cwd = path || Deno.cwd();

        // Call daemon API to create workspace
        const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
        const response = await fetch(`${daemonUrl}/api/workspaces/create-from-config`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: draft.name,
            description: draft.description,
            config: yaml,
            path,
            cwd, // Add CWD to request
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error("Failed to publish workspace", { error, status: response.status });
          return {
            success: false,
            error: `Failed to publish workspace: ${error}`,
          };
        }

        const workspace = await response.json();

        // Mark draft as published
        await adapter.publishDraft(draftId);

        return {
          success: true,
          workspaceId: workspace.id,
          path: workspace.path,
          message: `Successfully published workspace '${draft.name}'`,
          summary: {
            agents: Object.keys(draft.config.agents || {}).length,
            jobs: Object.keys(draft.config.jobs || {}).length,
            iterations: draft.iterations.length,
          },
        };
      } catch (error) {
        logger.error("Error publishing workspace", { error });
        return {
          success: false,
          error: `Error publishing workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },

  show_draft_config: {
    description: "Display the current draft workspace configuration in YAML format",
    parameters: jsonSchema({
      type: "object",
      properties: {
        draftId: {
          type: "string",
          format: "uuid",
          description: "Draft workspace ID",
        },
        format: {
          type: "string",
          enum: ["yaml", "summary"],
          default: "summary",
          description: "Output format",
        },
      },
      required: ["draftId"],
      additionalProperties: false,
    }),
    execute: async ({ draftId, format = "summary" }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: show_draft_config called", {
        draftId,
        format,
      });

      try {
        const adapter = await getDraftStorageAdapter();
        const draft = await adapter.getDraft(draftId);

        if (!draft) {
          return {
            success: false,
            error: `Draft ${draftId} not found`,
          };
        }

        if (format === "yaml") {
          return {
            success: true,
            config: stringify(draft.config),
            iterations: draft.iterations.length,
          };
        } else {
          return {
            success: true,
            summary: {
              name: draft.name,
              description: draft.description,
              agents: Object.entries(draft.config.agents || {}).map((
                [id, agent]: [string, any],
              ) => ({
                id,
                purpose: agent.purpose,
                type: agent.type,
              })),
              jobs: Object.entries(draft.config.jobs || {}).map(([id, job]: [string, any]) => ({
                id,
                description: job.description,
                agentCount: job.execution?.agents?.length || 0,
              })),
              signals: Object.keys(draft.config.signals || {}),
              tools: Object.keys(draft.config.tools?.mcp?.servers || {}),
            },
          };
        }
      } catch (error) {
        logger.error("Error showing draft config", { error });
        return {
          success: false,
          error: `Error showing config: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  list_session_drafts: {
    description: "List all draft workspaces for the current session",
    parameters: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (_) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: list_session_drafts called", { sessionId });

      try {
        const adapter = await getDraftStorageAdapter();
        const drafts = await adapter.getSessionDrafts(sessionId);

        return {
          success: true,
          drafts: drafts.map((d) => ({
            id: d.id,
            name: d.name,
            description: d.description,
            createdAt: d.createdAt,
            agentCount: Object.keys(d.config.agents || {}).length,
            jobCount: Object.keys(d.config.jobs || {}).length,
          })),
        };
      } catch (error) {
        logger.error("Error listing session drafts", { error });
        return {
          success: false,
          error: `Error listing drafts: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
});

export class ConversationSupervisor {
  constructor(
    private workspaceId: string,
    private workspaceContext?: any, // TODO: Add proper workspace context type
  ) {}

  async *processMessage(
    sessionId: string,
    messageId: string,
    message: string,
    fromUser: string,
    messageHistory?: ConversationMessage[], // QUICK FIX: Accept conversation history
  ): AsyncIterableIterator<ConversationEvent> {
    const timestamp = new Date().toISOString();

    // Emit thinking event
    yield {
      type: "thinking",
      data: {
        status: "processing",
        message: "ConversationSupervisor is analyzing your request...",
        fromUser,
      },
      timestamp,
      messageId,
      sessionId,
    };

    // QUICK FIX: Build conversation context from message history
    let conversationContext = "";
    if (messageHistory && messageHistory.length > 0) {
      // Include last 10 messages for context (5 exchanges)
      const recentHistory = messageHistory.slice(-10);
      conversationContext = "\n\nRECENT CONVERSATION HISTORY:\n";

      const logger = AtlasLogger.getInstance();
      logger.debug("ConversationSupervisor: Including conversation history", {
        sessionId,
        historyLength: messageHistory.length,
        recentHistoryLength: recentHistory.length,
      });

      for (const msg of recentHistory) {
        const role = msg.type === "user" ? "User" : "Assistant";
        conversationContext += `${role}: ${msg.content}\n`;
      }

      conversationContext += "\nCurrent message:\n";
    }

    const systemPrompt =
      `You are Addy, the Atlas AI assistant specialized in creating sophisticated multi-agent workspaces through iterative conversation.

## PRIMARY RULE: Always respond to users
You MUST ALWAYS call cx_reply to provide a response to the user. NEVER leave the user without a response.

## ADAPTIVE WORKSPACE CREATION
Analyze the user's request to determine how specific they are:

### If user provides SPECIFIC agent descriptions:
1. Call workspace_draft_create
2. Call update_workspace_config for EACH agent they described
3. Call cx_reply to summarize what you created and ask for refinement details

Example: "I want a telephone game with 3 members: first mishears, second embellishes, third makes haiku"
- Tool 1: workspace_draft_create {"name": "telephone-game", "description": "...", "pattern": "pipeline"}
- Tool 2: update_workspace_config {"operation": "add_agent", "config": {"name": "mishearing-agent", "purpose": "Slightly mishears and alters the message", "type": "llm", "model": "claude-3-5-haiku-20241022"}}
- Tool 3: update_workspace_config {"operation": "add_agent", "config": {"name": "embellishing-agent", "purpose": "Adds creative details and embellishments", "type": "llm", "model": "claude-3-5-haiku-20241022"}}
- Tool 4: update_workspace_config {"operation": "add_agent", "config": {"name": "haiku-agent", "purpose": "Converts the message into haiku poetry", "type": "llm", "model": "claude-3-5-haiku-20241022"}}
- Tool 5: update_workspace_config {"operation": "add_job", "config": {"name": "telephone-pipeline", "description": "Run agents in sequence for telephone game", "triggers": ["telephone-game-trigger"], "execution": {"strategy": "sequential", "agents": ["mishearing-agent", "embellishing-agent", "haiku-agent"]}}}
- Tool 6: cx_reply {"message": "I've created a draft workspace called 'telephone-game' that will transform messages through three stages:\n1. A mishearing agent that slightly alters the original message\n2. An embellishing agent that adds creative details\n3. A haiku agent that converts it to poetry\n\nNow let's design these agents. For the mishearing agent, what kind of alterations should it make? Should it:\n- Swap similar-sounding words (like 'bear' → 'bare')?\n- Drop or add small words?\n- Slightly change pronunciation-based errors?\n\nThis will help me configure the agent's transformation rules appropriately."}

### If user provides VAGUE request:
1. Call workspace_draft_create
2. Call cx_reply to ask for more details

Example: "Help me create a workspace"
- Tool 1: workspace_draft_create {"name": "new-workspace", "description": "...", "pattern": "custom"}
- Tool 2: cx_reply {"message": "I've created a draft workspace. What would you like this workspace to do? What kind of agents should it have?"}

## Showing Draft Configuration
When the user asks to see the current configuration:
1. Call show_draft_config with format="yaml" if they want YAML
2. Call show_draft_config with format="summary" (or omit format) for a prose summary
3. The configuration will be automatically included in the response

## Publishing Workspaces
When the user says "publish it" or wants to finalize their workspace:
1. Call publish_workspace with the draftId
2. The workspace will be created in the user's current directory with collision detection
3. If a directory with that name exists, it will use name-2, name-3, etc.
4. IMPORTANT: In your cx_reply, include the FULL PATH where the workspace was created
5. Tell the user they can cd to that directory and start using the workspace

Example response after publishing:
"✅ I've successfully published your workspace 'telephone-game'! 

The workspace has been created at:
/Users/username/code/telephone-game

You can now use it by:
1. Navigate to the workspace: cd /Users/username/code/telephone-game
2. Add your ANTHROPIC_API_KEY to the .env file
3. Run signals like: deno task atlas signal trigger telephone-game-trigger"

Note: If the directory already exists, it will be created with an incremented name (e.g., telephone-game-2)

## Other Instructions
- For "what is atlas?": Reply with "Atlas is an AI agent orchestration platform where engineers create workspaces for AI agents to collaborate on tasks."
- Always include your COMPLETE response in the cx_reply message field
- Create all agents the user specifies before asking for details
- When using model names, ALWAYS use the full model identifier (e.g., "claude-3-5-haiku-20241022" not just "claude-3-haiku")

## Available Workspace Patterns
- **pipeline**: Sequential processing where each agent transforms the output of the previous one
- **ensemble**: Multiple agents work in parallel on the same input
- **hierarchy**: Supervisor agent coordinates multiple worker agents
- **custom**: Design your own coordination pattern

Available tools:
- cx_reply: Send messages to the user (REQUIRED for all responses) - message field must contain COMPLETE response
- workspace_create: Create simple new workspaces (legacy)
- workspace_draft_create: Create a draft workspace that can be iteratively refined
- update_workspace_config: Add or modify agents, jobs, triggers, and tools in the draft
- show_draft_config: Display the current draft configuration
- publish_workspace: Publish a draft workspace to make it active
- list_session_drafts: Show all draft workspaces in the current session${conversationContext}`;

    // Check for specific questions and handle them directly
    const lowerMessage = message.toLowerCase().trim();
    if (lowerMessage === "what is atlas?" || lowerMessage.includes("what is atlas")) {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: Direct response for 'what is atlas?'");

      // Emit the response directly without calling the LLM
      const atlasDescription =
        "Atlas is an AI agent orchestration platform where engineers create workspaces for AI agents to collaborate on tasks. Think of it as Kubernetes for AI agents. You define agents, jobs, and signals in YAML files, and Atlas manages the execution.";

      // Emit as message chunks for typing effect
      const words = atlasDescription.split(" ");
      let content = "";

      for (let i = 0; i < words.length; i++) {
        content += (i > 0 ? " " : "") + words[i];

        yield {
          type: "message_chunk",
          data: {
            content,
            partial: i < words.length - 1,
          },
          timestamp: new Date().toISOString(),
          messageId,
          sessionId,
        };

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Emit completion
      yield {
        type: "message_complete",
        data: {
          messageId,
          complete: true,
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };

      return; // Skip LLM call entirely
    }

    try {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: Processing message", {
        exactMessage: message,
        messageLength: message.length,
        trimmedMessage: message.trim(),
        lowercaseMessage: message.toLowerCase().trim(),
        isWhatIsAtlas: message.toLowerCase().trim() === "what is atlas?",
      });

      // Create tools with sessionId context
      const tools = createCxTools(sessionId);

      logger.debug("ConversationSupervisor: Calling LLM with tools", {
        message,
        toolNames: Object.keys(tools),
        sessionId,
        systemPromptLength: systemPrompt.length,
        systemPromptPreview: systemPrompt.substring(0, 200) + "...",
      });

      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.7,
        maxSteps: 7, // Allow multiple agent creation and job setup when user provides specific details
        toolChoice: "required", // Force tool usage to ensure cx_reply is called
        operationContext: { operation: "conversation_supervision" },
        timeout: 90000, // 90 seconds for complex multi-agent workspace creation
      });

      logger.debug("ConversationSupervisor: LLM result", {
        toolCallsCount: result.toolCalls.length,
        toolNames: result.toolCalls.map((tc) => tc.toolName),
        toolResultsCount: result.toolResults.length,
        hasText: !!result.text,
        sessionId,
      });

      // Log detailed tool call information
      if (result.toolCalls.length > 0) {
        logger.info(JSON.stringify(
          {
            message: "ConversationSupervisor: Tool calls made",
            toolCalls: result.toolCalls.map((tc) => ({
              name: tc.toolName,
              args: tc.args,
            })),
            sessionId,
            messageId,
          },
          null,
          2,
        ));
      } else {
        logger.error(JSON.stringify(
          {
            message: "ConversationSupervisor: No tool calls made for message",
            error: message,
            sessionId,
            messageId,
          },
          null,
          2,
        ));
      }

      // Emit tool call event
      if (result.toolCalls.length > 0) {
        const logger = AtlasLogger.getInstance();
        for (const toolCall of result.toolCalls) {
          logger.debug("ConversationSupervisor tool call", {
            toolName: toolCall.toolName,
            args: toolCall.args,
            sessionId,
            messageId,
          });

          yield {
            type: "tool_call",
            data: {
              toolName: toolCall.toolName,
              args: toolCall.args,
            },
            timestamp: new Date().toISOString(),
            messageId,
            sessionId,
          };
        }
      }

      // Check if workspace tools were called without cx_reply
      const workspaceToolsCalled = result.toolCalls.filter((tc) =>
        [
          "workspace_draft_create",
          "update_workspace_config",
          "publish_workspace",
          "show_draft_config",
        ].includes(tc.toolName)
      );
      const cxReplyCalled = result.toolCalls.some((tc) => tc.toolName === "cx_reply");

      // Process tool results and emit events
      if (result.toolResults.length > 0) {
        // Process ALL tool results, not just the first one
        for (const toolResultWrapper of result.toolResults) {
          const toolResult = toolResultWrapper.result as any;

          // Find which tool was called
          const toolCall = result.toolCalls.find((tc) =>
            tc.toolCallId === toolResultWrapper.toolCallId
          );
          const toolName = toolCall?.toolName;

          if (!toolResult) continue;

          // Handle cx_reply tool result
          if (toolName === "cx_reply" && toolResult.message) {
            const words = toolResult.message.split(" ");
            let content = "";

            for (let i = 0; i < words.length; i++) {
              content += (i > 0 ? " " : "") + words[i];

              yield {
                type: "message_chunk",
                data: {
                  content,
                  partial: i < words.length - 1,
                },
                timestamp: new Date().toISOString(),
                messageId,
                sessionId,
              };

              // Small delay for realistic typing feel
              await new Promise((resolve) => setTimeout(resolve, 10)); // Reduced from 50ms
            }
          }

          // Emit transparency data (from cx_reply)
          if (toolName === "cx_reply" && toolResult.transparency) {
            const logger = AtlasLogger.getInstance();
            logger.debug("ConversationSupervisor reasoning", {
              analysis: toolResult.transparency.analysis,
              confidence: toolResult.transparency.confidence,
              complexity: toolResult.transparency.complexity,
              requiresAgentCoordination: toolResult.transparency.requiresAgentCoordination,
              sessionId,
              messageId,
            });

            yield {
              type: "transparency",
              data: toolResult.transparency,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };
          }

          // Emit orchestration data if present
          if (toolResult.orchestration) {
            yield {
              type: "orchestration",
              data: toolResult.orchestration,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };
          }
        } // End of for loop processing all tool results
      }

      // Handle case where no tools were called at all
      if (result.toolCalls.length === 0) {
        logger.error("ConversationSupervisor: No tools were called, which should not happen", {
          message,
          sessionId,
          messageId,
        });

        // Emit a default error message
        const errorMessage =
          "I apologize, but I encountered an issue processing your request. Please try rephrasing your workspace creation request.";
        const words = errorMessage.split(" ");
        let content = "";

        for (let i = 0; i < words.length; i++) {
          content += (i > 0 ? " " : "") + words[i];

          yield {
            type: "message_chunk",
            data: {
              content,
              partial: i < words.length - 1,
            },
            timestamp: new Date().toISOString(),
            messageId,
            sessionId,
          };

          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // If workspace tools were called without cx_reply, provide a default message
      if (workspaceToolsCalled.length > 0 && !cxReplyCalled) {
        logger.warn("ConversationSupervisor: Workspace tools called without cx_reply follow-up", {
          tools: workspaceToolsCalled.map((tc) => tc.toolName),
          sessionId,
          messageId,
        });

        // Generate a continuation message based on what tools were called
        let continuationMessage = "";

        for (const toolCall of workspaceToolsCalled) {
          const toolResult = result.toolResults.find((tr) => tr.toolCallId === toolCall.toolCallId)
            ?.result as any;

          if (toolCall.toolName === "workspace_draft_create" && toolResult?.success) {
            const workspaceName = toolResult.message?.match(/'([^']+)'/)?.[1] || "your workspace";
            continuationMessage =
              `I've created a draft workspace called '${workspaceName}' for your telephone game. ${
                toolResult.suggestionsText || toolResult.suggestions?.join(" ") ||
                "What would you like to add to this workspace?"
              }`;
          } else if (toolCall.toolName === "update_workspace_config" && toolResult?.success) {
            continuationMessage = `${
              toolResult.message || "I've updated your workspace configuration."
            }${toolResult.nextSteps ? "\n\nNext steps:\n" + toolResult.nextSteps.join("\n") : ""}`;
          } else if (toolCall.toolName === "show_draft_config" && toolResult?.success) {
            if (toolCall.args.format === "yaml" && toolResult.config) {
              continuationMessage =
                `Here's your current workspace configuration in YAML format:\n\n\`\`\`yaml\n${toolResult.config}\`\`\`\n\nWhat would you like to modify or shall we proceed to publish it?`;
            } else if (toolResult.summary) {
              const summary = toolResult.summary;
              let summaryText = `Here's your current workspace configuration:\n\n`;
              summaryText += `**Workspace**: ${summary.name}\n`;
              summaryText += `**Description**: ${summary.description}\n\n`;

              if (summary.agents && summary.agents.length > 0) {
                summaryText += `**Agents** (${summary.agents.length}):\n`;
                summary.agents.forEach(
                  (agent: { id: string; purpose: string; type: string }, i: number) => {
                    summaryText += `${i + 1}. **${agent.id}** - ${agent.purpose} (${agent.type})\n`;
                  },
                );
                summaryText += `\n`;
              }

              if (summary.jobs && summary.jobs.length > 0) {
                summaryText += `**Jobs** (${summary.jobs.length}):\n`;
                summary.jobs.forEach(
                  (job: { id: string; description: string; agentCount: number }, i: number) => {
                    summaryText += `${
                      i + 1
                    }. **${job.id}** - ${job.description} (${job.agentCount} agents)\n`;
                  },
                );
                summaryText += `\n`;
              }

              if (summary.signals && summary.signals.length > 0) {
                summaryText += `**Signals**: ${summary.signals.join(", ")}\n`;
              }

              if (summary.tools && summary.tools.length > 0) {
                summaryText += `**MCP Tools**: ${summary.tools.join(", ")}\n`;
              }

              summaryText += `\nWhat would you like to modify or shall we proceed to publish it?`;
              continuationMessage = summaryText;
            } else {
              continuationMessage =
                "Here's your current workspace configuration. What would you like to modify or shall we proceed to publish it?";
            }
          } else if (toolCall.toolName === "publish_workspace" && toolResult?.success) {
            // Include the full path in the continuation message
            const workspacePath = toolResult.path;
            const workspaceName = toolResult.message?.match(/'([^']+)'/)?.[1] || "your workspace";
            continuationMessage = `✅ I've successfully published ${workspaceName}!\n\n` +
              `The workspace has been created at:\n` +
              `\`${workspacePath}\`\n\n` +
              `You can now use it by:\n` +
              `1. Navigate to the workspace: \`cd ${workspacePath}\`\n` +
              `2. Add your ANTHROPIC_API_KEY to the .env file\n` +
              `3. Run signals like: \`deno task atlas signal trigger ${workspaceName}-trigger\``;
          }
        }

        // Emit the continuation message if we generated one
        if (continuationMessage) {
          const words = continuationMessage.split(" ");
          let content = "";

          for (let i = 0; i < words.length; i++) {
            content += (i > 0 ? " " : "") + words[i];

            yield {
              type: "message_chunk",
              data: {
                content,
                partial: i < words.length - 1,
              },
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };

            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }

      // Emit completion event
      yield {
        type: "message_complete",
        data: {
          messageId,
          complete: true,
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };
    } catch (error) {
      // Emit error event
      yield {
        type: "message_complete",
        data: {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };
    }
  }
}
