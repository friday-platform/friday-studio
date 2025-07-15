import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConversationClient } from "../../../utils/conversation-client.ts";
import { OutputEntry } from "../index.ts";

export interface MCPDescribeOptions {
  mcpClient: Client;
  conversationClient: ConversationClient;
  conversationSessionId: string;
  workspaceId: string;
  itemId: string;
  promptName: string;
  itemType: string;
  setOutputBuffer: React.Dispatch<React.SetStateAction<OutputEntry[]>>;
  setTypingState: React.Dispatch<
    React.SetStateAction<{ isTyping: boolean; elapsedSeconds: number }>
  >;
}

export async function handleDescribeMCP({
  mcpClient,
  conversationClient,
  conversationSessionId,
  workspaceId,
  itemId,
  promptName,
  itemType,
  setOutputBuffer,
  setTypingState,
}: MCPDescribeOptions): Promise<void> {
  // Get the describe prompt from MCP
  const args: Record<string, string> = {
    workspaceId: workspaceId,
  };

  // Add the appropriate ID based on item type
  if (itemType === "signal") {
    args.signalId = itemId;
  } else if (itemType === "agent") {
    args.agentId = itemId;
  } else if (itemType === "job") {
    args.jobId = itemId;
  } else if (itemType === "session") {
    args.sessionId = itemId;
  }

  const result = await mcpClient.request(
    {
      method: "prompts/get",
      params: {
        name: promptName,
        arguments: args,
      },
    },
    GetPromptResultSchema,
  );

  // Extract the text from the MCP response
  if (result.messages && result.messages.length > 0) {
    const message = result.messages[0];
    if (
      message.content &&
      typeof message.content === "object" &&
      "text" in message.content
    ) {
      const promptText = message.content.text as string;

      // Send directly to conversation without showing in output buffer
      setTypingState((prev) => ({ ...prev, isTyping: true }));

      try {
        await conversationClient.sendMessage(
          conversationSessionId,
          promptText,
        );
        // Note: setTypingState will be called by the SSE handler when message_complete is received
      } catch (error) {
        // Reset typing on error
        setTypingState((prev) => ({ ...prev, isTyping: false }));
        throw error;
      }
    }
  }
}
