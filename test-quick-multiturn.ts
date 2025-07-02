import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

console.log("Quick multi-turn conversation test...\n");

try {
  const client = new ConversationClient("http://localhost:8080");

  // 1. Create session
  console.log("1. Creating session...");
  const session = await client.createSession({
    userId: "test-user",
    scope: { workspaceId: "test-workspace" },
    createOnly: true,
  });
  console.log("✓ Session created:", session.sessionId);

  // Helper function to send message and get response
  async function sendAndWait(message: string, turnNumber: number): Promise<string> {
    console.log(`\n${turnNumber}. Sending: "${message}"`);

    // Send message
    const messageResult = await client.sendMessage(session.sessionId, message);
    console.log(`✓ Message sent (${messageResult.messageId})`);

    // Wait for complete response
    let fullResponse = "";
    let eventCount = 0;

    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      eventCount++;

      if (event.data.content && !event.data.partial) {
        fullResponse = event.data.content;
        console.log(`✓ Response (${eventCount} events): "${fullResponse.substring(0, 50)}..."`);
        break;
      }

      if (event.type === "message_complete") {
        break;
      }
    }

    return fullResponse;
  }

  // 2. First turn
  await sendAndWait("Hello! What's 2+2?", 2);

  // 3. Second turn
  await sendAndWait("What did I just ask you about?", 3);

  console.log("\n🎉 Multi-turn test completed successfully!");
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
