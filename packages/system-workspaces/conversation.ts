import type { WorkspaceConfig } from "@atlas/config";

export const ATLAS_CONVERSATION_CONFIG: WorkspaceConfig = {
  version: "1.0",
  workspace: {
    name: "atlas-conversation",
    description: "Conversation management for Atlas",
  },
  signals: {
    "conversation-stream": {
      description: "Handle conversation with streaming response",
      provider: "internal",
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          userId: { type: "string" },
          conversationId: { type: "string" },
          scope: {
            type: "object",
            properties: {
              workspaceId: {
                type: "string",
              },
              jobId: {
                type: "string",
              },
              sessionId: {
                type: "string",
              },
            },
          },
        },
        required: ["message", "userId"],
      },
    },
    "conversation-list": {
      description: "List conversations for user and scope",
      provider: "internal",
      schema: {
        type: "object",
        properties: {
          userId: {
            type: "string",
          },
          scope: {
            type: "object",
          },
        },
        required: ["userId"],
      },
    },
    "conversation-resume": {
      description: "Resume a previous conversation",
      provider: "internal",
      schema: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
          },
          userId: {
            type: "string",
          },
        },
        required: ["conversationId", "userId"],
      },
    },
  },
  jobs: {
    "handle-conversation": {
      name: "handle-conversation",
      description: "Process conversation messages with context awareness",
      triggers: [{
        signal: "conversation-stream",
        response: {
          mode: "streaming",
          format: "sse",
          timeout: 300000,
        },
      }],
      execution: {
        strategy: "sequential",
        agents: [{
          id: "conversation-agent",
        }],
      },
      supervision: {
        level: "minimal",
      },
      memory: {
        enabled: false,
        fact_extraction: true,
        working_memory_summary: true,
      },
      resources: {
        estimated_duration_seconds: 5,
      },
    },
    "list-conversations": {
      name: "list-conversations",
      description: "Query conversation history",
      triggers: [{
        signal: "conversation-list",
        response: {
          mode: "unary",
          format: "json",
          timeout: 300000,
        },
      }],
      execution: {
        strategy: "sequential",
        agents: [{
          id: "conversation-query",
        }],
      },
    },
    "resume-conversation": {
      name: "resume-conversation",
      description: "Load conversation for resumption",
      triggers: [{
        signal: "conversation-resume",
        response: {
          mode: "unary",
          format: "json",
          timeout: 300000,
        },
      }],
      execution: {
        strategy: "sequential",
        agents: [{
          id: "conversation-loader",
        }],
      },
    },
  },
  agents: {
    "conversation-agent": {
      type: "tempest",
      agent: "conversation-agent",
      version: "1.0.0",
      config: {
        model: "claude-3-5-sonnet-20241022",
        temperature: 0.7,
        max_tokens: 4000,
      },
      purpose: "Handle conversations with scope awareness and workspace creation",
      tools: [
        "stream_reply",
        "workspace_draft_create",
        "workspace_draft_update",
        "validate_draft_config",
        "pre_publish_check",
        "publish_workspace",
        "show_draft_config",
        "list_session_drafts",
        "library_list",
        "library_get",
        "library_search",
      ],
      prompts: {
        system:
          `You are Addy, the Atlas AI assistant helping users work with Atlas, the AI agent orchestration platform.

CRITICAL INSTRUCTIONS:
1. You receive input as a JSON object with fields: streamId, message, userId, conversationId
2. The user's request is in input.message - this is what you respond to
3. ALWAYS use stream_reply as your FIRST action to respond to the user
4. Call stream_reply with: stream_reply(input.streamId, "your response", null, conversationId)
5. For new conversations, generate conversationId as "conv_" + Date.now()

WORKSPACE CREATION WORKFLOW:
When users ask to create a workspace:
1. FIRST use stream_reply to describe your plan and ask for confirmation
2. ONLY call workspace_draft_create after the user approves
3. Validate the configuration and help fix any errors
4. Ask before publishing the workspace

Remember: Atlas is for AI agent orchestration. You can create workspaces with multiple agents that work together.

Available tools: stream_reply, workspace_draft_create, workspace_draft_update, validate_draft_config, pre_publish_check, publish_workspace, show_draft_config, list_session_drafts, library_list, library_get, library_search`,
      },
    },
    "conversation-query": {
      type: "llm",
      model: "claude-3-5-haiku-20241022",
      purpose: "Query conversation history based on scope",
      prompts: {
        system: `Query the conversation storage to list conversations.
Filter by user ID and scope hierarchy.
Return formatted list with metadata.`,
      },
    },
    "conversation-loader": {
      type: "llm",
      model: "claude-3-5-haiku-20241022",
      purpose: "Load conversation history for resumption",
      prompts: {
        system: `Load conversation metadata and message history.
Verify user access permissions.
Return last N messages and context for resumption.`,
      },
    },
  },
};
